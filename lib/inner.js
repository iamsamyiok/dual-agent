// 内层引擎：OpenAI 兼容 API（/chat/completions 流式）+ 插件工具调用循环
// DUAL_AGENT_MOCK=1 时走本地脚本化假 LLM（无需真实 API 即可演示全流程）
const vm = require('vm');
const path = require('path');
const { withRetry, RetryableError, isRetryableStatus, isRateLimitText } = require('./llmRetry');
const MAX_ROUNDS = 24; // 工具调用轮数上限（长文分段+偶发重试下 12 不够；死循环保护仍在）

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
  // 空参数标记：raw 完全为空 = API 流式传输丢失 arguments（agnes 实测单调用/多调用尾部均出现），
  // 与"截断"区分——前者原样重试即可，后者需缩短内容
  return out.map(c => ({
    id: c.id, name: c.name,
    args: c.parsed.ok ? c.parsed.text : '{}',
    emptyRaw: !c.raw, // true = 参数在传输中整体丢失
    truncatedRaw: !!c.raw && !c.parsed.ok // true = 参数传输中被截断（收到不完整 JSON 片段）
  }));
}

// ---------- 真实链路 ----------
// 止损阈值：同一轮内同一插件连续失败达到该次数后，本轮后续该插件调用直接跳过，
// 防止模型在失败上无限重试（实测 agnes 空参风暴：单轮 100+ 次失败占满轮数上限）。
const STALL_LIMIT = 3;

// 止损判定：同插件本轮连续失败 STALL_LIMIT 次且从未成功 → 跳过（防失败风暴占满轮数）
function shouldStall(roundFails, name) {
  const s = roundFails.get(name);
  return !!s && s.n >= STALL_LIMIT && !s.ok;
}
function recordFail(roundFails, name, ok) {
  if (ok) { roundFails.delete(name); return; }
  const s = roundFails.get(name) || { n: 0, ok: false };
  s.n += 1;
  roundFails.set(name, s);
}

// ---------- 上下文预算管理 ----------
// 病根：messages 无限增长（read 大文件/插件全量结果），最终撞 token 上限 → API 400 且无法自愈。
// 策略：发 API 前构造压缩副本（落盘的 inner-messages.json 保持完整）：
// - 预算默认 60000 字符（DUAL_AGENT_CTX_BUDGET 可调），超出时从最旧的 tool 结果开始压缩
// - tool content 压缩为 头300 + 尾100 + 折叠标记（保留关键入参回执与结尾指示）
// - 绝不删除条目：assistant.tool_calls 与 tool 结果必须配对（OpenAI 协议），删了直接 400
// - system 永不压缩；最近 K 轮（4 轮）tool 结果保持全文
function estimateChars(messages) {
  let n = 0;
  for (const m of messages) {
    n += (m.content && typeof m.content === 'string') ? m.content.length : 0;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}

// ---------- token 计量 ----------
// 病根（v0.9.0 修复）：全链路对真实 token 用量零采集——请求不带 stream_options，
// 解析器遇 choices 空帧（协议中携带 usage 的末帧）直接 continue，API 返回的真实用量被丢弃。
// 模型被问"用了多少 token"时只能按自己输出的文字量脑补（千级），而计费口径是每轮
// 全量 prompt 重发（系统提示+技能清单+全部工具结果，多轮循环累计轻松几十万）——差两个数量级。
// 修复四件套：① 请求带 stream_options.include_usage（网关 400 不识别时自动降级）
// ② 捕获 usage 末帧（choices 可为空）③ 每轮累计并发 usage 事件 ④ 无 usage 网关用
// estimateTokens 估算兜底（est 标记）。模型每轮还会收到注入发送副本的计量注记（落盘干净）。
function estimateTokens(str) {
  const s = String(str || '');
  let cjk = 0;
  for (const ch of s) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

// 计量注记：注入发送副本末尾（messages 落盘保持干净），让模型每轮握有真实数字
function usageNoteMsg(last, totals, sendChars) {
  const lines = ['[token 计量] 以下为本会话 API 真实用量（或高质量估算），回答 token 用量类问题必须引用这些数字，禁止自行估算：'];
  if (last) lines.push(`- 上一轮 API 调用：prompt ${last.prompt} tok${last.cached ? `（其中缓存命中 ${last.cached}）` : ''} + 输出 ${last.completion} tok`);
  lines.push(`- 会话累计（API 计费口径）：${totals.calls} 次调用，prompt ${totals.prompt} tok + 输出 ${totals.completion} tok${totals.cached ? `（缓存命中 ${totals.cached}）` : ''}`);
  lines.push(`- 注意计费口径每轮 prompt 全量重发，累计值远大于净上下文体积（本轮发送约 ${sendChars} 字符）。`);
  lines.push('详细历史可用 usage 插件查询（action=get 本区累计 / action=history 按会话分组）。');
  return { role: 'system', content: lines.join('\n') };
}

function budgetMessages(messages) {
  const budget = Number(process.env.DUAL_AGENT_CTX_BUDGET) || 60000;
  if (estimateChars(messages) <= budget) return messages;
  // 最近 4 个 tool 结果索引保持全文
  const toolIdx = [];
  messages.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i); });
  const keepFull = new Set(toolIdx.slice(-4));
  const out = messages.map((m, i) => {
    if (m.role !== 'tool' || keepFull.has(i) || typeof m.content !== 'string') return m;
    if (m.content.length <= 500) return m; // 短结果无压缩价值
    const head = m.content.slice(0, 300);
    const tail = m.content.slice(-100);
    return { ...m, content: `${head}\n…［上下文预算：此结果已折叠 ${(m.content.length - 400)} 字符，完整内容见工作区 process 过程文件］…\n${tail}` };
  });
  return out;
}


async function chatInnerReal(cfg, messages, tools, callPlugin, onEvent) {
  const url = cfg.base_url.replace(/\/+$/, '') + '/chat/completions';
  // 跨轮失败计数（止损用）：同一插件连续失败（期间无成功）累计达 STALL_LIMIT 次即跳过，
  // 覆盖「每轮 1 次失败 × N 轮」的慢风暴（实测 agnes 丢参常见此形态）
  const failStreak = new Map();
  // 传输层失败计数：参数整体丢失/截断累计。第 1 次提示原样重试；连续 ≥2 次说明该通道
  // 无法可靠传输大参数，强制提示改分段写入（实测：模型原样重试大参数 → 永远截断 → 死循环）
  let transLoss = 0;
  // token 计量：会话累计 + 网关不识别 stream_options 的降级标记
  const usageTotals = { calls: 0, prompt: 0, completion: 0, cached: 0 };
  let noUsageOpt = false;
  let lastUsage = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 发送副本构造（每轮一次）：上下文预算压缩 + 计量注记（仅发送，落盘干净）
    const budgeted = budgetMessages(messages);
    const sendChars = estimateChars(budgeted);
    const sendMsgs = usageTotals.calls > 0
      ? [...budgeted, usageNoteMsg(lastUsage, usageTotals, sendChars)]
      : budgeted;
    // 单次尝试：建连 + 完整读流。整体包进 withRetry：限流（429/402/503/特征词）与
    // 网络抖动按 3s→9s→27s→81s 指数退避自动重试；重试时重置本轮累积（assistant 消息
    // 尚未入 messages，text 事件为快照式，重复安全）
    const { content, calls, usage } = await withRetry(async () => {
      const payload = { model: cfg.model, messages: sendMsgs, tools: tools.length ? tools : undefined, stream: true };
      if (!noUsageOpt) payload.stream_options = { include_usage: true }; // 真实 token 计量（老网关 400 时自动降级）
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
        body: JSON.stringify(payload)
      });
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        // 部分老网关不识别 stream_options 直接 400：置降级标记后按可重试错误重跑（下次不带该参数）
        if (resp.status === 400 && !noUsageOpt && /stream_options/i.test(txt)) {
          noUsageOpt = true;
          throw new RetryableError('网关不识别 stream_options，去除该参数重试');
        }
        if (isRetryableStatus(resp.status) || isRateLimitText(txt)) {
          throw new RetryableError(`API ${resp.status}：${txt.slice(0, 160) || '无响应体'}`);
        }
        throw new Error(`内层 API ${resp.status}：${txt.slice(0, 300) || '无响应体'}`);
      }

      // SSE 流式解析：拼接 content 与 tool_calls 增量；捕获 usage 末帧（choices 可为空数组）
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const content = { text: '' };
      const calls = new Map(); // index -> {id, name, args}
      let usageFrame = null;
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
          if (ev.usage && typeof ev.usage === 'object') usageFrame = ev.usage; // 先于 delta 判定：usage 末帧 choices 为空
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
      return { content, calls, usage: usageFrame };
    }, { onEvent, label: '内层 LLM' });

    // token 计量落账：优先 API 真实返回；无 usage 网关用字符折算估算（est 标记）
    let est = false;
    let roundUsage = usage;
    if (!roundUsage) {
      est = true;
      roundUsage = {
        prompt_tokens: estimateTokens(JSON.stringify(sendMsgs)) + (tools.length ? estimateTokens(JSON.stringify(tools)) : 0),
        completion_tokens: estimateTokens(content.text) + [...calls.values()].reduce((n, c) => n + estimateTokens(c.args), 0)
      };
    }
    usageTotals.calls += 1;
    usageTotals.prompt += roundUsage.prompt_tokens || 0;
    usageTotals.completion += roundUsage.completion_tokens || 0;
    const cached = (roundUsage.prompt_tokens_details && roundUsage.prompt_tokens_details.cached_tokens) || 0;
    usageTotals.cached += cached;
    lastUsage = { prompt: roundUsage.prompt_tokens || 0, completion: roundUsage.completion_tokens || 0, cached };
    onEvent({ type: 'usage', est, totals: { ...usageTotals }, last: { ...lastUsage } });

    // 无工具调用：本轮即最终回答
    if (!calls.size) {
      messages.push({ role: 'assistant', content: content.text });
      return content.text;
    }

    // 有工具调用：重组拆分流（兼容把超大 arguments 拆到多个 index 的 API）并净化
    // DUAL_AGENT_DEBUG_TC=1 时把原始分桶落盘（诊断流式协议异常用）
    if (process.env.DUAL_AGENT_DEBUG_TC === '1' && calls.size) {
      try {
        const fs = require('fs');
        const dump = [...calls.entries()].sort((a, b) => a[0] - b[0])
          .map(([i, c]) => `index=${i} id=${JSON.stringify(c.id)} name=${JSON.stringify(c.name)} argsLen=${c.args.length}\n  head=${JSON.stringify(c.args.slice(0, 120))}\n  tail=${JSON.stringify(c.args.slice(-120))}`).join('\n');
        fs.appendFileSync(path.join(process.env.DUAL_AGENT_DATA || path.join(__dirname, '..', '.data'), 'tc-debug.log'), `--- ${new Date().toISOString()} ---\n${dump}\n`);
      } catch { /* ignore */ }
    }
    const toolCalls = reassembleCalls(calls);
    messages.push({
      role: 'assistant',
      content: content.text || null,
      tool_calls: toolCalls.map(c => ({ id: c.id || `call-${c.name}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))
    });
    // 止损判定（跨轮 failStreak）：同插件连续失败达 STALL_LIMIT 次即跳过，提示换策略
    for (const c of toolCalls) {
      const state = failStreak.get(c.name) || { n: 0, ok: false };
      if (shouldStall(failStreak, c.name)) {
        const msg = `插件 ${c.name} 已连续失败 ${state.n} 次，判定当前调用方式不可行，停止执行 ${c.name} 调用。` +
          `请换一种方式完成目标：检查参数是否完整、改用其他插件（write/read/edit/bash 换一种组合）、或分小步重试。`;
        onEvent({ type: 'tool_result', plugin: c.name, ok: false, result: msg, ms: 0 });
        messages.push({ role: 'tool', tool_call_id: c.id || `call-${c.name}`, content: msg });
        continue;
      }
      let args = {};
      try { args = JSON.parse(c.args || '{}'); } catch { /* 保持空对象 */ }
      onEvent({ type: 'tool_call', plugin: c.name, args });
      const t0 = Date.now();
      // 传输层失败（API 流式 bug）：跳过插件执行，直接给分层重试提示。
      // 截断型（truncatedRaw）与整体丢失（emptyRaw）一律不执行——带着残缺参数执行
      // 只会报"缺少必填参数"，误导模型以为是自己参数写错（实测死循环主因）。
      let result;
      if (c.emptyRaw || (c.truncatedRaw && !Object.keys(args).length)) {
        transLoss += 1;
        result = transLoss < 2
          ? `插件 ${c.name} 调用被拒绝：本次调用的 arguments 在 API 流式传输中${c.emptyRaw ? '整体丢失' : `被截断（仅收到不完整片段，非内容过长所致）`}。请原样重试同样的调用，无需缩短或修改内容。`
          : `插件 ${c.name} 调用被拒绝：参数已连续 ${transLoss} 次在 API 传输中丢失/截断，该通道无法可靠传输大参数，禁止再原样重试大调用。` +
            `立即改用分段模式完成写入：1) 首次 write(path=文件名, content=第一段, 每段 ≤1500 字符)；` +
            `2) 后续每段 write(path=同一路径, content=下一段, append=true)；` +
            `3) 用 read(path, tail=10) 确认衔接。段与段内容绝不能重叠或跳行。`;
      } else {
        result = await callPlugin(c.name, args);
        if (!/^插件.*?(加载失败|执行出错|调用被拒绝)/.test(result)) transLoss = 0; // 任一次成功执行说明通道恢复
      }
      const ms = Date.now() - t0;
      const ok = !/^插件.*?(加载失败|执行出错|调用被拒绝)/.test(result);
      onEvent({ type: 'tool_result', plugin: c.name, ok, result, ms }); // 全量结果：过程文件需要完整内容，前端自行截断显示
      messages.push({ role: 'tool', tool_call_id: c.id || `call-${c.name}`, content: result });
      // 更新失败计数：成功则清零，失败则累计（跨轮）
      recordFail(failStreak, c.name, ok);
    }
  }
  const tail = `已达到工具调用轮数上限（${MAX_ROUNDS}），强制结束本轮。可以发"继续"让我接着完成。`;
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
    onEvent({ type: 'tool_result', plugin: step.plugin, ok: true, result, ms: Date.now() - t0 });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `m-${step.plugin}`, type: 'function', function: { name: step.plugin, arguments: JSON.stringify(step.args) } }] });
    messages.push({ role: 'tool', tool_call_id: `m-${step.plugin}`, content: result });
  }
  const finalText = '演示模式执行完成：已通过 bash 查看工作目录，并用 write 插件创建了 demo-note.txt。真实模式下我会根据你的任务自主选择插件组合完成。';
  acc = finalText;
  onEvent({ type: 'text', text: acc });
  onEvent({ type: 'usage', est: true, totals: { calls: 2, prompt: 2100, completion: 180, cached: 0 }, last: { prompt: 1400, completion: 90, cached: 0 } });
  messages.push({ role: 'assistant', content: finalText });
  return finalText;
}

function chatInner(cfg, messages, tools, callPlugin, onEvent) {
  return process.env.DUAL_AGENT_MOCK === '1'
    ? chatInnerMock(cfg, messages, tools, callPlugin, onEvent)
    : chatInnerReal(cfg, messages, tools, callPlugin, onEvent);
}

module.exports = { chatInner, chatInnerReal, MAX_ROUNDS, sanitizeToolArguments, parseToolArgs, reassembleCalls, shouldStall, recordFail, STALL_LIMIT, budgetMessages, estimateChars, estimateTokens, usageNoteMsg };
