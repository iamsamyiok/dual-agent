// 双层 Agent 自迭代系统 — 零依赖 HTTP 服务
// 启动：node server.js [--port 3788]；DUAL_AGENT_MOCK=1 为演示模式（内层假 LLM + 外层假 opencode）
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const APP_VERSION = '0.1.0';
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : (process.env.PORT || 3788));
const ROOT = __dirname;
const DATA_DIR = process.env.DUAL_AGENT_DATA || path.join(ROOT, '.data');
const WORKSPACE_DIR = path.join(ROOT, 'workspace'); // 内层插件默认工作目录
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const INNER_LOG_PATH = path.join(DATA_DIR, 'inner-log.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

const plugins = require('./lib/plugins');
const approval = require('./lib/approval');
const outerMod = require('./lib/outer');
const { chatInner } = require('./lib/inner');

// ---------- 日志 tee ----------
const LOG_PATH = path.join(DATA_DIR, 'server.log');
try { fs.writeFileSync(LOG_PATH, `=== dual-agent-loop started ${new Date().toISOString()} ===\n`); } catch { /* ignore */ }
const origLog = console.log.bind(console);
console.log = (...a) => { origLog(...a); try { fs.appendFileSync(LOG_PATH, a.join(' ') + '\n'); } catch { /* ignore */ } };
process.on('uncaughtException', e => console.log('[uncaught]', e && e.stack || e));
process.on('unhandledRejection', e => console.log('[unhandled]', e && (e.stack || e) || e));

// ---------- 配置（内层 OpenAI 兼容 API；key 仅存本机） ----------
function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return { inner: { base_url: '', api_key: '', model: '' } }; }
}
function saveConfig(patch) {
  const cfg = getConfig();
  const next = { ...cfg, inner: { ...cfg.inner, ...(patch.inner || {}) } };
  // 前端回传打码值时保留原 key
  if (patch.inner && /ˣ{4}/.test(patch.inner.api_key || '')) next.inner.api_key = cfg.inner.api_key;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}
function maskedConfig() {
  const cfg = getConfig();
  const k = cfg.inner.api_key || '';
  return { ...cfg, inner: { ...cfg.inner, api_key: k ? k.slice(0, 3) + 'ˣˣˣˣ' : '' } };
}

// ---------- 内层运行日志（环形最近 200 条；单向同步给外层上下文） ----------
function getInnerLog() {
  try { return JSON.parse(fs.readFileSync(INNER_LOG_PATH, 'utf8')); } catch { return []; }
}
function appendInnerLog(entry) {
  const list = getInnerLog();
  list.push(entry);
  try { fs.writeFileSync(INNER_LOG_PATH, JSON.stringify(list.slice(-200), null, 1)); } catch { /* ignore */ }
}

// ---------- HTTP 基础 ----------
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
  });
}
function sse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ } };
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { clearInterval(hb); } }, 15000);
  let closed = false;
  const onClose = () => { if (closed) return; closed = true; clearInterval(hb); };
  req.on('close', onClose);
  res.on('close', onClose);
  return send;
}

// 内层消息历史（内存，每会话一条链；demo 单会话）
const innerMessages = [];
// opencode 检测缓存（detectOpencode 返回 { cmd, shell } | null）
let ocCache = { ts: 0, runner: null };
async function opencodeRunner() {
  if (Date.now() - ocCache.ts < 10000) return ocCache.runner;
  ocCache = { ts: Date.now(), runner: await outerMod.detectOpencode() };
  return ocCache.runner;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  // ---------- 静态 ----------
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    fs.readFile(path.join(ROOT, 'public', 'index.html'), (e, d) => {
      if (e) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
    return;
  }

  try {
    // ---------- 健康/配置 ----------
    if (p === '/api/health' && req.method === 'GET') {
      const cfg = getConfig();
      const oc = await opencodeRunner();
      json(res, 200, {
        success: true, version: APP_VERSION,
        mock: process.env.DUAL_AGENT_MOCK === '1',
        innerConfigured: !!(cfg.inner.base_url && cfg.inner.api_key && cfg.inner.model),
        opencode: oc ? oc.cmd : '', workspace: WORKSPACE_DIR
      });
      return;
    }
    if (p === '/api/config' && req.method === 'GET') { json(res, 200, { success: true, config: maskedConfig() }); return; }
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      saveConfig(body);
      json(res, 200, { success: true, config: maskedConfig() });
      return;
    }

    // ---------- 插件 ----------
    if (p === '/api/plugins' && req.method === 'GET') {
      json(res, 200, {
        success: true,
        plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) }))
      });
      return;
    }
    if (p === '/api/plugins/save' && req.method === 'POST') {
      const body = await readBody(req);
      const r = approval.manualSave(String(body.name || '').trim(), String(body.code || ''));
      json(res, 200, { success: r.ok, error: r.error, plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }
    if (p === '/api/plugins/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const r = approval.manualDelete(String(body.name || '').trim());
      json(res, 200, { success: r.ok, error: r.error, plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }

    // ---------- 内层对话 ----------
    if (p === '/api/inner/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const message = String(body.message || '').trim();
      if (!message) { json(res, 400, { success: false, error: '消息为空' }); return; }
      const cfg = getConfig();
      if (process.env.DUAL_AGENT_MOCK !== '1' && !(cfg.inner.base_url && cfg.inner.api_key && cfg.inner.model)) {
        json(res, 400, { success: false, error: '内层 API 未配置：点右上角「配置」填写 base_url / api_key / model' });
        return;
      }
      const send = sse(req, res);
      send({ type: 'start' });
      innerMessages.push({ role: 'user', content: message });
      const callPlugin = async (name, args) => {
        const result = await plugins.runPlugin(name, args, { cwd: WORKSPACE_DIR, dataDir: DATA_DIR });
        appendInnerLog({ ts: Date.now(), plugin: name, args, ok: !/^(插件 .+?(加载失败|执行出错))/.test(result), result: String(result).slice(0, 400), ms: 0 });
        return result;
      };
      try {
        await chatInner(cfg.inner, innerMessages, plugins.toolDefs(), callPlugin, ev => {
          if (ev.type === 'tool_result') {
            // 日志补记耗时
            const list = getInnerLog();
            const last = list[list.length - 1];
            if (last && last.plugin === ev.plugin) { last.ms = ev.ms; last.ok = ev.ok; try { fs.writeFileSync(INNER_LOG_PATH, JSON.stringify(list.slice(-200), null, 1)); } catch { /* ignore */ } }
          }
          send(ev);
        });
        send({ type: 'done' });
      } catch (e) {
        send({ type: 'error', content: String((e && e.message) || e) });
        send({ type: 'done' });
      } finally {
        try { res.end(); } catch { /* closed */ }
      }
      return;
    }

    // ---------- 外层对话 ----------
    if (p === '/api/outer/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const message = String(body.message || '').trim();
      if (!message) { json(res, 400, { success: false, error: '消息为空' }); return; }
      const runner = await opencodeRunner();
      if (process.env.DUAL_AGENT_MOCK !== '1' && !runner) {
        json(res, 400, { success: false, error: '未检测到 opencode。安装：npm install -g opencode-ai，配置登录：opencode auth login；也可在环境变量 DUAL_AGENT_OPENCODE_CMD 指定完整路径' });
        return;
      }
      const send = sse(req, res);
      send({ type: 'start' });
      // 单向上下文：软约束提示词 + 插件清单 + 内层日志（不含内层对话原文）
      const prompt = `${outerMod.SYSTEM_PROMPT}\n\n${outerMod.buildContext(plugins.listPlugins(), getInnerLog())}\n\n== 用户指令 ==\n${message}`;
      let fullText = '';
      try {
        const r = await outerMod.runOuter(runner, prompt, ROOT, ev => {
          if (ev.type === 'text') { fullText = ev.text; send(ev); }
        });
        if (r.error) send({ type: 'error', content: r.error });
        // 解析建议 json → 审批队列
        const props = outerMod.parseProposals(fullText);
        const added = [];
        for (const pr of props) {
          const r2 = approval.addProposal(pr, 'outer');
          if (r2.ok) added.push(r2.proposal.id);
          else send({ type: 'notice', content: `建议无效已忽略：${r2.error}` });
        }
        send({ type: 'proposals', added, count: added.length });
        send({ type: 'done' });
      } catch (e) {
        send({ type: 'error', content: String((e && e.message) || e) });
        send({ type: 'done' });
      } finally {
        try { res.end(); } catch { /* closed */ }
      }
      return;
    }

    // ---------- 审批 ----------
    if (p === '/api/proposals' && req.method === 'GET') {
      json(res, 200, { success: true, proposals: approval.listProposals() });
      return;
    }
    if (p === '/api/proposals/decide' && req.method === 'POST') {
      const body = await readBody(req);
      const r = approval.decide(String(body.id || ''), !!body.approve);
      json(res, 200, { success: r.ok, error: r.error, rejected: !!r.rejected, plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }
    if (p === '/api/rollback' && req.method === 'POST') {
      const r = approval.rollback();
      json(res, 200, { success: r.ok, error: r.error, restored: r.restored, plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }

    if (p === '/api/audit' && req.method === 'GET') {
      let list = [];
      try { list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'audit.json'), 'utf8')); } catch { /* ignore */ }
      json(res, 200, { success: true, audit: list.slice(-100).reverse() });
      return;
    }
    if (p === '/api/inner-log' && req.method === 'GET') {
      json(res, 200, { success: true, log: getInnerLog().slice(-50).reverse() });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    console.log('[api]', err && err.stack || err);
    try { json(res, 500, { success: false, error: String((err && err.message) || err) }); } catch { /* ignore */ }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`双层 Agent 自迭代系统已启动: http://localhost:${PORT}`);
  console.log(`内层工作目录: ${WORKSPACE_DIR}`);
  if (process.env.DUAL_AGENT_MOCK === '1') console.log('演示模式：内层假 LLM + 外层假 opencode（不依赖真实 API）');
});
