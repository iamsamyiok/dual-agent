// hwj TUI 渲染引擎 — readline + ANSI 转义序列，零依赖（仅 Node 内置）
// 分区模型：消息流（append-only 沉降区）+ 活动区（状态栏/流式回复/工具行，事件驱动重绘）+ readline prompt（最底行）
// text 事件是快照式覆盖（inner.js pendingText 语义），TUI 维护 replyBuf 整段替换重绘实现流式效果
const readline = require('readline');

// ---------- 显示宽度（CJK 双宽感知） ----------
// 码点 > 0x2E80 的 CJK 区按 2 列宽（统一表意/全角标点/假名），其余 1 列
function charWidth(cp) {
  if (cp >= 0x1100 && (cp <= 0x115F || cp === 0x2329 || cp === 0x232A)) return 2; // 谚文兼容区
  if (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) return 2; // CJK 部首~彝文区
  if (cp >= 0xAC00 && cp <= 0xD7A3) return 2; // 谚文音节
  if (cp >= 0xF900 && cp <= 0xFAFF) return 2; // CJK 兼容表意
  if (cp >= 0xFE30 && cp <= 0xFE4F) return 2; // CJK 兼容形式
  if (cp >= 0xFF00 && cp <= 0xFF60) return 2; // 全角形式
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return 2; // 全角符号
  if (cp >= 0x20000 && cp <= 0x3FFFD) return 2; // CJK 扩展 B+
  return 1;
}
function strWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += charWidth(ch.codePointAt(0));
  return w;
}
// 按显示宽度硬折行（CJK 字符不拆半，宽度不够时整字符下移）
function wrapText(text, width) {
  const out = [];
  if (width < 2) return [String(text ?? '')];
  for (const rawLine of String(text ?? '').split('\n')) {
    if (!rawLine) { out.push(''); continue; }
    let cur = '', curW = 0;
    for (const ch of rawLine) {
      const cw = charWidth(ch.codePointAt(0));
      if (curW + cw > width) { out.push(cur); cur = ch; curW = cw; }
      else { cur += ch; curW += cw; }
    }
    if (cur || rawLine) out.push(cur);
  }
  return out.length ? out : [''];
}
// 按显示宽度截断加省略号（超长单行摘要用）
function ellipsis(s, max) {
  const str = String(s ?? '');
  if (max <= 1) return '…';
  if (strWidth(str) <= max) return str;
  let keep = '', w = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    keep += ch; w += cw;
  }
  return keep + '…';
}
// token 数格式化：12345 → 12.3k
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

// ---------- 工具行 / 状态栏渲染（纯函数） ----------
// 参数摘要：优先 path/command/query 等可读字段，单行压平
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const flat = {};
  for (const [k, v] of Object.entries(args)) flat[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 80) : v;
  const pick = flat.path ?? flat.command ?? flat.query ?? flat.url ?? flat.name ?? flat.action ?? '';
  const rest = Object.keys(flat).filter(k => k !== 'path' && k !== 'command' && k !== 'query' && k !== 'url' && k !== 'name' && k !== 'action');
  let s = String(pick);
  if (rest.length && strWidth(s) < 40) s += ` ${rest.slice(0, 2).map(k => `${k}=${ellipsis(String(flat[k]), 20)}`).join(' ')}`;
  return s.trim();
}
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// tool: { plugin, args, t0, done, ok, ms, sub, spin }（spin 为当前转圈字符）
function renderToolLine(tool, width) {
  const dur = tool.done ? `${tool.ms}ms` : `${Date.now() - tool.t0}ms`;
  const icon = tool.done ? (tool.ok ? '✓' : '✗') : (tool.spin || SPINNER[0]);
  const head = ` ${icon} ${tool.sub ? '[子] ' : ''}${tool.plugin}`;
  const headW = strWidth(head);
  const durW = strWidth(dur) + 1;
  const body = ellipsis(summarizeArgs(tool.args), Math.max(2, width - headW - durW));
  return { head, body, dur };
}
// 状态栏：hwj v0.9.28 · build · ws:default · 12.3k tok · 轮 3
function renderStatusBar(st, width) {
  const parts = [`hwj ${st.version || ''}`.trim(), st.mode || 'build', `ws:${st.ws || 'default'}`];
  if (st.tokens) parts.push(`${fmtTokens(st.tokens.prompt + st.tokens.completion)} tok`);
  if (st.calls) parts.push(`${st.calls} calls`);
  if (st.busy) parts.push(st.busy);
  return ellipsis(parts.join(' · '), Math.max(4, width));
}

// ---------- ANSI 帮助 ----------
const A = {
  reset: '\x1b[0m', clearLine: '\x1b[2K\x1b[1G',
  up: n => `\x1b[${n}A`, down: n => `\x1b[${n}B`,
  cyan: s => `\x1b[36m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`,
  gray: s => `\x1b[90m${s}\x1b[0m`, dim: s => `\x1b[2m\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`
};

// ---------- TUI 对象 ----------
// opts: { onLine, onSigint, version, ws, mode, plain }（plain=非交互模式：无 ANSI 无重绘，e2e 用）
function createTui(opts = {}) {
  const out = process.stdout;
  const plain = !!opts.plain;
  const st = {
    version: opts.version || '', ws: opts.ws || 'default', mode: opts.mode || 'build',
    tokens: null, calls: 0, busy: '', reply: '', tools: [], queueN: 0
  };
  let rl = null;
  let spinIdx = 0;
  let spinTimer = null;
  let redrawQueued = false;
  let lastReplyDraw = 0;
  let onLine = opts.onLine || (() => {});
  let onSigint = opts.onSigint || (() => {});
  const termWidth = () => Math.max(20, (out.columns || 80) - 1);

  // ----- 消息流（沉降区，append-only） -----
  function printRaw(line) { out.write(line + '\n'); }
  function printUser(text) {
    if (plain) { printRaw(`你  ${text}`); return; }
    for (const l of wrapText(text, termWidth() - 4)) printRaw(A.cyan('你  ') + l);
  }
  function printAssistant(text) {
    if (plain) { printRaw(text); return; }
    for (const l of wrapText(text, termWidth() - 4)) printRaw(A.green('hwj ') + l);
  }
  function printInfo(text) {
    if (plain) { printRaw(`[info] ${text}`); return; }
    for (const l of wrapText(text, termWidth() - 2)) printRaw(A.dim(' ' + l));
  }
  function printError(text) {
    if (plain) { printRaw(`[错误] ${text}`); return; }
    for (const l of wrapText(text, termWidth() - 2)) printRaw(A.red('✗ ' + l));
  }
  function printPlain(text) { printRaw(plain ? text : A.gray(text)); }

  // ----- 活动区行集合 -----
  function activeLines() {
    const w = termWidth();
    const lines = [plain ? renderStatusBar(st, w) : A.gray(renderStatusBar(st, w))];
    if (st.reply) {
      const wrapped = wrapText(st.reply, w - 4);
      const shown = wrapped.length > 12 ? ['…', ...wrapped.slice(-12)] : wrapped; // 流式回复只显示尾部，防滚动
      for (const l of shown) lines.push(plain ? l : A.green('hwj ') + l);
    }
    for (const t of st.tools) {
      const { head, body, dur } = renderToolLine(t, w);
      const headStr = t.done ? (t.ok ? A.green(head) : A.red(head)) : A.gray(head);
      lines.push(`${headStr} ${A.gray(ellipsis(body, Math.max(0, w - strWidth(head) - strWidth(dur) - 1)))} ${A.gray(dur)}`);
    }
    // 活动区行数保护：超过终端高度-2（留 prompt+缓冲）截头部
    const maxLines = Math.max(4, (out.rows || 24) - 2);
    if (lines.length > maxLines) return ['…', ...lines.slice(-(maxLines - 1))];
    return lines;
  }

  // ----- 活动区重绘 -----
  // 光标模型：当前位于 readline prompt 行。清 prompt 行 → 上移 n 行 → 逐行清写 → 回到 prompt 行重绘 prompt
  function redraw() {
    if (plain) { // 非交互：活动区直接顺序打印（工具行 done 时打印一行）
      for (const t of st.tools) if (t._printed !== true) {
        t._printed = true;
        const { head, body, dur } = renderToolLine(t, 200);
        printRaw(`${head} ${body} ${dur}${t.done ? '' : ' …'}`);
      }
      if (st.reply) { st._printedReply = st.reply; }
      return;
    }
    if (!rl) return;
    const lines = activeLines();
    const n = lines.length;
    let buf = A.clearLine;
    if (n > 0) buf += A.up(n);
    for (let i = 0; i < n; i++) {
      buf += A.clearLine + lines[i];
      if (i < n - 1) buf += '\x1b[1B';
    }
    if (n > 0) buf += '\n';
    out.write(buf);
    rl.prompt(true);
  }
  // 合并高频重绘（text 流式/usage 每轮多次，逐事件全量重绘浪费且闪烁）
  function queueRedraw() {
    if (plain) { redraw(); return; }
    if (redrawQueued) return;
    redrawQueued = true;
    setImmediate(() => { redrawQueued = false; redraw(); });
  }
  // 回复流式节流：≥60ms 才真正重绘（快照可能逐 token 高频到达）
  function setReply(text) {
    st.reply = String(text || '');
    if (Date.now() - lastReplyDraw >= 60) { lastReplyDraw = Date.now(); queueRedraw(); }
  }

  // ----- 任务生命周期 -----
  function beginTask() {
    st.reply = ''; st.tools = []; st.busy = '执行中';
    startSpin();
    queueRedraw();
  }
  function endTask() {
    stopSpin();
    // 活动区沉降：工具行以静态形态进入消息流；回复文本由调用方以 finalText 统一打印
    //（活动区 reply 只是流式预览，最终交付可能含核验缺口标注等后处理，以 core 返回为准）
    for (const t of st.tools) {
      const { head, body, dur } = renderToolLine(t, termWidth());
      const headStr = t.done ? (t.ok ? A.green(head) : A.red(head)) : A.gray(head);
      printRaw(`${headStr} ${A.gray(ellipsis(body, Math.max(0, termWidth() - strWidth(head) - strWidth(dur) - 1)))} ${A.gray(dur)}`);
    }
    st.reply = ''; st.tools = []; st.busy = '';
    queueRedraw();
  }
  function toolCall(ev) {
    st.tools.push({ plugin: ev.plugin, args: ev.args, t0: Date.now(), done: false, ok: false, ms: 0, sub: !!ev.sub });
    // 工具行数保护：超过 8 行时最早完成的行沉降（保留未完成行供就地更新）
    if (st.tools.length > 8) {
      const settle = [];
      while (st.tools.length > 8 && st.tools[0].done) settle.push(st.tools.shift());
      for (const t of settle) {
        const { head, body, dur } = renderToolLine(t, termWidth());
        printRaw(`${A.gray(head)} ${A.gray(ellipsis(body, Math.max(0, termWidth() - strWidth(head) - strWidth(dur) - 1)))} ${A.gray(dur)}`);
      }
    }
    queueRedraw();
  }
  function toolResult(ev) {
    // 子级事件与主级按 plugin+t0 就近匹配；无 id 语义，取最后一个同名未完成行
    for (let i = st.tools.length - 1; i >= 0; i--) {
      const t = st.tools[i];
      if (t.plugin === ev.plugin && !t.done) {
        t.done = true; t.ok = !!ev.ok; t.ms = ev.ms || (Date.now() - t.t0);
        break;
      }
    }
    queueRedraw();
  }
  function usage(ev) {
    if (ev && ev.totals) {
      st.tokens = { prompt: ev.totals.prompt, completion: ev.totals.completion };
      st.calls = ev.totals.calls;
    }
    queueRedraw();
  }
  function setMeta(patch) { Object.assign(st, patch); queueRedraw(); }

  // ----- 转圈指示 -----
  function startSpin() {
    if (spinTimer || plain) return;
    spinTimer = setInterval(() => {
      spinIdx = (spinIdx + 1) % SPINNER.length;
      for (const t of st.tools) if (!t.done) t.spin = SPINNER[spinIdx];
      if (st.busy) queueRedraw();
    }, 125);
    if (spinTimer.unref) spinTimer.unref();
  }
  function stopSpin() { if (spinTimer) { clearInterval(spinTimer); spinTimer = null; } }

  // ----- readline -----
  function start() {
    if (plain) return;
    rl = readline.createInterface({ input: process.stdin, output: out, prompt: A.bold('> ') });
    rl.on('line', line => { onLine(line); });
    let sigintCount = 0; let sigintTs = 0;
    rl.on('SIGINT', () => {
      const now = Date.now();
      if (now - sigintTs > 3000) sigintCount = 0;
      sigintTs = now; sigintCount += 1;
      onSigint(sigintCount);
    });
    out.on('resize', () => queueRedraw());
    rl.prompt();
  }
  function setHandlers(h) { if (h.onLine) onLine = h.onLine; if (h.onSigint) onSigint = h.onSigint; }
  function refreshPrompt() { if (rl) rl.prompt(true); }
  function clearPromptLine() { if (!plain) out.write(A.clearLine); }
  function close() {
    stopSpin();
    if (rl) { rl.close(); rl = null; }
  }
  return { printUser, printAssistant, printInfo, printError, printPlain, beginTask, endTask, setReply, toolCall, toolResult, usage, setMeta, start, setHandlers, refreshPrompt, clearPromptLine, close, state: st };
}

module.exports = { createTui, wrapText, ellipsis, strWidth, charWidth, renderToolLine, renderStatusBar, summarizeArgs, fmtTokens, SPINNER };
