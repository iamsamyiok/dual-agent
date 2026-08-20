// 内层引擎：OpenAI 兼容 API（/chat/completions 流式）+ 插件工具调用循环
// DUAL_AGENT_MOCK=1 时走本地脚本化假 LLM（无需真实 API 即可演示全流程）
const vm = require('vm');
const MAX_ROUNDS = 12; // 工具调用轮数上限（防死循环）

// ---------- tool_calls.arguments 净化 ----------
// 部分模型（尤其小参数量）流式产出的 arguments 是非法 JSON：键无引号、单引号、尾逗号、截断。
// 原样回填 messages 会让下一轮 API 直接 400（arguments must be valid JSON）且无法自纠。
// parseToolArgs：{ ok, text }；合法原样 → 以 { 开头的尝试 vm 沙箱宽松解析 → 失败降级 '{}'，
// 由框架的必填参数校验给 LLM 明确的重试提示形成自愈闭环。
function parseToolArgs(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, text: '{}' };
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, text: s };
    return { ok: true, text: '{}' }; // 合法 JSON 但非对象（数字/数组等）→ 降级
  } catch { /* 继续修复 */ }
  if (!s.startsWith('{')) return { ok: false, text: '{}' }; // 仅接受对象字面量形态，防代码注入进沙箱
  try {
    const val = vm.runInNewContext(`(${s})`, Object.freeze({}), { timeout: 200 });
    if (val && typeof val === 'object' && !Array.isArray(val)) return { ok: true, text: JSON.stringify(val) };
  } catch { /* 修复失败 */ }
  return { ok: false, text: '{}' };
}
function sanitizeToolArguments(raw) {
  return parseToolArgs(raw).text;
}

// ---------- 流拆分重组（真实 API 兼容性修复，2026-08 agnes-2.5-flash 实测） ----------
// 部分 OpenAI 兼容 API 会把同一次调用的超大 arguments 间歇性拆到多个 index 流
// （如 index 0 = 完整前半 JSON、index 1 = 后半片段），违反流式协议：逐桶 JSON 均不完整，
// 简单净化会把两次都降级 '{}'，模型重试再被拆，循环耗尽轮数上限。
// 重组策略（三遍）：
//   1. 逐桶解析，合法桶直接通过
//   2. 无 id/name 的残桶（纯 arguments 延续）并入前一桶原始串重试（正序/反序各一次）
//   3. 仍存在坏桶且有多个桶时：全部按序拼接为单次调用兜底（模型把一次调用拆成多个有 id 的流）
function reassembleCalls(callsMap) {
  const list = [...callsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, name: c.name, raw: c.args }));
  for (const c of list) c.parsed = parseToolArgs(c.raw);
  const out = [];
  for (const c of list) {
    if (c.parsed.ok) { out.push(c); continue; }
    const prev = out[out.length - 1];
    if (prev && !c.id && !c.name) {
      const m1 = parseToolArgs(prev.raw + c.raw);
      if (m1.ok) { out[out.length - 1] = { id: prev.id, name: prev.name, raw: prev.raw + c.raw, parsed: m1 }; continue; }
      const m2 = parseToolArgs(c.raw + prev.raw);
      if (m2.ok) { out[out.length - 1] = { id: prev.id, name: prev.name, raw: c.raw + prev.raw, parsed: m2 }; continue; }
    }
    out.push(c); // 暂存坏桶（第三遍可能整体救回）
  }
  if (out.length > 1 && out.some(c => !c.parsed.ok)) {
    const all = parseToolArgs(list.map(c => c.raw).join(''));
    if (all.ok) {
      const f = list.find(c => c.id || c.name) || list[0];
      return [{ id: f.id || '', name: f.name || '', args: all.text }];
    }
  }
  return out.map(c => ({ id: c.id, name: c.name, args: c.parsed.ok ? c.parsed.text : '{}' }));
}

// ---------- 真实链路 ----------
async function chatInnerReal(cfg, messages, tools, callPlugin, onEvent) {
  const url = cfg.base_url.replace(/\/+$/, '') + '/chat/completions';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
      body: JSON.stringify({ model: cfg.model, messages, tools: tools.length ? tools : undefined, stream: true })
    });
    if (!resp.ok || !resp.body) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`内层 API ${resp.status}：${txt.slice(0, 300) || '无响应体'}`);
    }

    // SSE 流式解析：拼接 content 与 tool_calls 增量
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const content = { text: '' };
    const calls = new Map(); // index -> {id, name, args}
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          content.text += delta.content;
          onEvent({ type: 'text', text: content.text }); // 快照式（前端覆盖渲染）
        }
        for (const tc of delta.tool_calls || []) {
          const c = calls.get(tc.index) || { id: '', name: '', args: '' };
          if (tc.id) c.id = tc.id;
          if (tc.function && tc.function.name) c.name += tc.function.name;
          if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
          calls.set(tc.index, c);
        }
      }
    }

    // 无工具调用：本轮即最终回答
    if (!calls.size) {
      messages.push({ role: 'assistant', content: content.text });
      return content.text;
    }

    // 有工具调用：重组拆分流（兼容把超大 arguments 拆到多个 index 的 API）并净化
    const toolCalls = reassembleCalls(calls);
    messages.push({
      role: 'assistant',
      content: content.text || null,
      tool_calls: toolCalls.map(c => ({ id: c.id || `call-${c.name}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))
    });
    for (const c of toolCalls) {
      let args = {};
      try { args = JSON.parse(c.args || '{}'); } catch { /* 保持空对象 */ }
      onEvent({ type: 'tool_call', plugin: c.name, args });
      const t0 = Date.now();
      const result = await callPlugin(c.name, args);
      const ms = Date.now() - t0;
      onEvent({ type: 'tool_result', plugin: c.name, ok: !/^插件.*?(加载失败|执行出错|调用被拒绝)/.test(result), result: result.slice(0, 600), ms });
      messages.push({ role: 'tool', tool_call_id: c.id || `call-${c.name}`, content: result });
    }
  }
  const tail = '已达到工具调用轮数上限（12），强制结束本轮。';
  messages.push({ role: 'assistant', content: tail });
  onEvent({ type: 'text', text: tail });
  return tail;
}

// ---------- 演示模式：脚本化假 LLM ----------
// 行为：先 bash echo 探路 → write 写一个演示文件 → 输出总结（覆盖工具循环+日志+建议触发）
async function chatInnerMock(cfg, messages, tools, callPlugin, onEvent) {
  const plan = [
    { plugin: 'bash', args: { command: 'echo 内层演示：当前目录 && pwd' } },
    { plugin: 'write', args: { path: 'demo-note.txt', content: '这是内层 Agent 通过 write 插件创建的演示文件。\n' } }
  ];
  let acc = '';
  for (const step of plan) {
    onEvent({ type: 'tool_call', plugin: step.plugin, args: step.args });
    const t0 = Date.now();
    const result = await callPlugin(step.plugin, step.args);
    onEvent({ type: 'tool_result', plugin: step.plugin, ok: true, result: result.slice(0, 600), ms: Date.now() - t0 });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `m-${step.plugin}`, type: 'function', function: { name: step.plugin, arguments: JSON.stringify(step.args) } }] });
    messages.push({ role: 'tool', tool_call_id: `m-${step.plugin}`, content: result });
  }
  const finalText = '演示模式执行完成：已通过 bash 查看工作目录，并用 write 插件创建了 demo-note.txt。真实模式下我会根据你的任务自主选择插件组合完成。';
  acc = finalText;
  onEvent({ type: 'text', text: acc });
  messages.push({ role: 'assistant', content: finalText });
  return finalText;
}

function chatInner(cfg, messages, tools, callPlugin, onEvent) {
  return process.env.DUAL_AGENT_MOCK === '1'
    ? chatInnerMock(cfg, messages, tools, callPlugin, onEvent)
    : chatInnerReal(cfg, messages, tools, callPlugin, onEvent);
}

module.exports = { chatInner, MAX_ROUNDS, sanitizeToolArguments, parseToolArgs, reassembleCalls };
