// 内层引擎：OpenAI 兼容 API（/chat/completions 流式）+ 插件工具调用循环
// DUAL_AGENT_MOCK=1 时走本地脚本化假 LLM（无需真实 API 即可演示全流程）
const vm = require('vm');
const MAX_ROUNDS = 12; // 工具调用轮数上限（防死循环）

// ---------- tool_calls.arguments 净化 ----------
// 部分模型（尤其小参数量）流式产出的 arguments 是非法 JSON：键无引号、单引号、尾逗号、截断。
// 原样回填 messages 会让下一轮 API 直接 400（arguments must be valid JSON）且无法自纠。
// 策略：合法原样 → 以 { 开头的尝试 vm 沙箱宽松解析（覆盖 JS 对象字面量小错误）→ 全部失败降级 '{}'，
// 由框架的必填参数校验给 LLM 明确的重试提示形成自愈闭环。
function sanitizeToolArguments(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '{}';
  try { JSON.parse(s); return s; } catch { /* 继续修复 */ }
  if (!s.startsWith('{')) return '{}'; // 仅接受对象字面量形态，防代码注入进沙箱
  try {
    const val = vm.runInNewContext(`(${s})`, Object.freeze({}), { timeout: 200 });
    if (val && typeof val === 'object' && !Array.isArray(val)) return JSON.stringify(val);
  } catch { /* 修复失败 */ }
  return '{}';
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

    // 有工具调用：执行插件并把结果追加进消息序列
    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    // 净化 arguments：保证回填 messages 的永远是合法 JSON（否则下一轮 API 400）
    for (const c of toolCalls) c.args = sanitizeToolArguments(c.args);
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

module.exports = { chatInner, MAX_ROUNDS, sanitizeToolArguments };
