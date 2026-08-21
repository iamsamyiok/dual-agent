// 双层 Agent 自迭代系统 — 零依赖 HTTP 服务
// 启动：node server.js [--port 3788]；DUAL_AGENT_MOCK=1 为演示模式（内层假 LLM + 外层假 opencode）
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const APP_VERSION = '0.9.7';
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : (process.env.PORT || 3788));
const ROOT = __dirname;
const DATA_DIR = process.env.DUAL_AGENT_DATA || path.join(ROOT, '.data');
const WS_ROOT = process.env.DUAL_AGENT_WS_ROOT || path.join(ROOT, 'workspaces'); // 多工作区根目录（每个工作区一个任务域；可用环境变量覆盖供测试隔离）
const WS_NAME_RE = /^[a-z0-9-]{1,40}$/;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LEGACY_MSG_PATH = path.join(DATA_DIR, 'inner-messages.json'); // 旧版全局会话，一次性迁移用

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WS_ROOT, { recursive: true });

const plugins = require('./lib/plugins');
const approval = require('./lib/approval');
const outerMod = require('./lib/outer');
const { chatInner, isMultiStepTask } = require('./lib/inner');
const { validProfiles, pickProfile } = require('./lib/profiles');
const { NET_CODES } = require('./lib/llmRetry');

// ---------- 日志 tee ----------
const LOG_PATH = path.join(DATA_DIR, 'server.log');
try { fs.writeFileSync(LOG_PATH, `=== dual-agent-loop started ${new Date().toISOString()} ===\n`); } catch { /* ignore */ }
const origLog = console.log.bind(console);
console.log = (...a) => { origLog(...a); try { fs.appendFileSync(LOG_PATH, a.join(' ') + '\n'); } catch { /* ignore */ } };
process.on('uncaughtException', e => console.log('[uncaught]', e && e.stack || e));
process.on('unhandledRejection', e => console.log('[unhandled]', e && (e.stack || e) || e));

// ---------- 配置（内层 OpenAI 兼容 API；key 仅存本机） ----------
const DEFAULT_CONFIG = { inner: { base_url: '', api_key: '', model: '' }, inner_profiles: [], workspace: 'default', outerSession: '', reviewMark: 0 };
function getConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(patch) {
  const cfg = getConfig();
  const next = { ...cfg, inner: { ...cfg.inner, ...(patch.inner || {}) } };
  // 前端回传打码值时保留原 key
  if (patch.inner && /ˣ{4}/.test(patch.inner.api_key || '')) next.inner.api_key = cfg.inner.api_key;
  // 多路 API profile：数组整体替换；条目内打码值保留原 key（前端未改动即回传打码串）
  if (Array.isArray(patch.inner_profiles)) {
    const prev = validProfiles(cfg);
    next.inner_profiles = patch.inner_profiles.map((p, i) => {
      if (!p || typeof p !== 'object') return p;
      const old = prev[i];
      return /ˣ{4}/.test(String(p.api_key || '')) && old ? { ...p, api_key: old.api_key } : p;
    });
  }
  for (const k of ['workspace', 'outerSession', 'reviewMark']) {
    if (k in patch) next[k] = patch[k];
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* 非 POSIX 环境忽略 */ }
  } catch (e) {
    console.log('[config] 配置落盘失败（当前配置仅存活于内存，重启即失）:', e && e.message || e);
    throw new Error('配置保存失败：' + (e && e.message || e));
  }
  return next;
}
function maskedConfig() {
  const cfg = getConfig();
  const k = cfg.inner.api_key || '';
  const maskKey = key => (key ? String(key).slice(0, 3) + 'ˣˣˣˣ' : '');
  const profiles = validProfiles(cfg).map(p => ({ ...p, api_key: maskKey(p.api_key) }));
  return { ...cfg, inner: { ...cfg.inner, api_key: maskKey(k) }, inner_profiles: profiles };
}

// ---------- 多工作区（内层插件默认工作目录，记忆/技能随工作区隔离） ----------
function currentWorkspace() {
  const name = String(getConfig().workspace || 'default');
  return WS_NAME_RE.test(name) ? name : 'default';
}
function workspaceDir() {
  const dir = path.join(WS_ROOT, currentWorkspace());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function listWorkspaces() {
  let names = [];
  try { names = fs.readdirSync(WS_ROOT).filter(n => WS_NAME_RE.test(n) && fs.statSync(path.join(WS_ROOT, n)).isDirectory()); } catch { /* ignore */ }
  if (!names.includes('default')) names.unshift('default');
  return names.sort();
}

// ---------- 内层执行过程记录（workspaces/<ws>/process.md，按时间顺序记录完整过程） ----------
// 聊天窗口只显示单行动态摘要；完整入参/完整结果/全文回复都落盘到这里，
// 前端双击工具条在 /process 页实时查看（含执行中任务的增量刷新）。
function processPath() { return path.join(workspaceDir(), 'process.md'); }
function fmtClock(ts) { return new Date(ts).toTimeString().slice(0, 8); }
function readProcess() {
  try { return fs.readFileSync(processPath(), 'utf8'); } catch { return ''; }
}
function appendProcess(text) {
  try {
    const fp = processPath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    // 体量保护：超过 2MB 保留尾部 1MB（头部旧记录滚动淘汰）
    try {
      const st = fs.statSync(fp);
      if (st.size > 2 * 1024 * 1024) {
        const keep = fs.readFileSync(fp, 'utf8').slice(-1024 * 1024);
        fs.writeFileSync(fp, keep.slice(keep.indexOf('\n---\n') >= 0 ? keep.indexOf('\n---\n') : 0));
      }
    } catch { /* 新文件 */ }
    fs.appendFileSync(fp, text, 'utf8');
  } catch { /* ignore */ }
}

// ---------- 内层运行日志（JSONL 追加式：每条一行 append，读时取尾 200 条；消除全量读改写） ----------
const INNER_LOG_JSONL = path.join(DATA_DIR, 'inner-log.jsonl');
function getInnerLog() {
  try {
    // 大文件优化：只读尾部 256KB（约 300+ 条），避免日志增长后每次全量读
    const st = fs.statSync(INNER_LOG_JSONL);
    const readFrom = Math.max(0, st.size - 256 * 1024);
    const fd = fs.openSync(INNER_LOG_JSONL, 'r');
    const buf = Buffer.alloc(st.size - readFrom);
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    const list = [];
    for (const l of lines) { try { list.push(JSON.parse(l)); } catch { /* 跳过残行 */ } }
    // readFrom > 0 时首行可能是截断残行，已被 JSON.parse 跳过
    return list.slice(-200);
  } catch { return []; }
}
function appendInnerLog(entry) {
  try {
    fs.appendFileSync(INNER_LOG_JSONL, JSON.stringify(entry) + '\n', 'utf8');
    // 体量保护：超 2MB 截断到尾部 1MB（低频滚动，append 主路径零读开销）
    try {
      const st = fs.statSync(INNER_LOG_JSONL);
      if (st.size > 2 * 1024 * 1024) {
        const fd = fs.openSync(INNER_LOG_JSONL, 'r');
        const buf = Buffer.alloc(st.size - 1024 * 1024);
        fs.readSync(fd, buf, 0, buf.length, 1024 * 1024);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').filter(Boolean).slice(1); // 丢弃首截断行
        fs.writeFileSync(INNER_LOG_JSONL, lines.map(l => l + '\n').join(''));
      }
    } catch { /* 截断失败不影响主流程 */ }
  } catch (e) { console.log('[log] 内层日志追加失败:', e && e.message || e); } // 关键写失败可见
}

// ---------- 内层消息历史（按工作区分片落盘：workspaces/<ws>/inner-messages.json；切换换载而非清空，历史保留） ----------
let innerMessages = [];
function wsMsgPath(ws) { return path.join(WS_ROOT, ws || currentWorkspace(), 'inner-messages.json'); }
function loadInnerMessages() {
  try { innerMessages = JSON.parse(fs.readFileSync(wsMsgPath(), 'utf8')) || []; }
  catch {
    innerMessages = [];
    // 一次性迁移：0.4.0 及之前的全局会话归入当前工作区，迁移后改名防止重复吸入其他工作区
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_MSG_PATH, 'utf8'));
      if (Array.isArray(legacy) && legacy.length) { innerMessages = legacy; persistInnerMessages(); }
      fs.renameSync(LEGACY_MSG_PATH, LEGACY_MSG_PATH + '.migrated');
    } catch { /* 无旧数据 */ }
  }
}
function persistInnerMessages() {
  try { fs.writeFileSync(wsMsgPath(), JSON.stringify(innerMessages.slice(-60), null, 1)); }
  catch (e) { console.log('[persist] 内层会话落盘失败:', e && e.message || e); } // 关键写失败必须可见
}
function clearInnerMessages() { innerMessages.length = 0; persistInnerMessages(); }
loadInnerMessages();

// ---------- 审批历史摘要（外层上下文用：最近 n 条批准/拒绝决定） ----------
function recentAuditLines(n) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'audit.json'), 'utf8')); } catch { return []; }
  return list
    .filter(e => e.op === 'apply' || e.op === 'reject')
    .slice(-n)
    .map(e => `- [${String(e.ts).slice(0, 16)}] ${e.op === 'apply' ? '已批准' : '已拒绝'} ${e.action} ${e.plugin}${e.reason ? `（理由：${String(e.reason).slice(0, 120)}）` : ''}`);
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

// opencode 检测缓存（detectOpencode 返回 { cmd, shell } | null）
let ocCache = { ts: 0, runner: null };
async function opencodeRunner() {
  if (Date.now() - ocCache.ts < 10000) return ocCache.runner;
  ocCache = { ts: Date.now(), runner: await outerMod.detectOpencode() };
  return ocCache.runner;
}

// 内层系统提示：针对真实模型实测暴露的三类问题（并行调用丢参数、超长参数传输截断、oldText 凭记忆编写）
const INNER_SYSTEM_PROMPT = [
  '你是内层执行 Agent，通过调用插件完成任务，完成后用简洁中文总结。',
  '',
  '## 任务执行前必须：',
  '1. 先调用 memory.search(query="任务关键词") 检索相关记忆，将结果作为背景参考',
  '2. 调用 skill.list() 查看技能库（渐进式：list 只给名称+描述），发现与任务相关的技能必须 skill.get(name) 读全文并按其步骤执行',
  '3. 复杂任务必须先建任务清单：满足任一条件即算复杂——(a) 需要 ≥3 个执行步骤 (b) 涉及多个文件的创建/修改 (c) 用户消息含"然后/接着/再/最后"等多步标志。建法：每个步骤一次 todo.add(text="动宾短语")；此后每完成一步立即 todo.toggle(id=...) 勾选，开始下一步前如记不清进度就 todo.list() 查看；全部完成时清单应全为 [x]。禁止跳过建清单直接执行复杂任务',
  '4. 产出验证纪律：任务产出文件后，禁止只凭"我写了"就宣称完成。收尾前用 verify 插件断言关键产出（exists + contains 文本特征 + line_count 行数），多规则一次调用；看到 FAIL 必须修复后重新 verify，直到 PASS 才能总结',
  '5. 子智能体（subagent）：探索型子任务（多文件调研、方案对比、联网查证 ≥2 个独立问题）用 subagent 插件并行派生，主上下文只收结论——禁止自己 read 一堆大文件把上下文撑爆。产出写入类操作仍由主会话亲自执行',
  '6. 动态规划：每轮可见 [任务清单] 注记。执行中发现实际状况与计划不符（文件比预期大/依赖缺失/步骤顺序要变）必须先修订清单（todo.add 新步骤）再继续，禁止明知跑偏还硬走原计划',
  '',
  '## 技能执行纪律（重要）：',
  '- 技能全文就是操作手册：其中要求的每个步骤（读模板、跑脚本、按格式输出）都必须照做',
  '- SKILL.md 正文引用的捆绑文件用 read 读取，path 填 "skill:技能名/正文相对路径"（如 skill:pdf/scripts/run.py），框架自动定位技能目录',
  '- 正文未引用的相对路径也可用同法读取；禁止跳过步骤后凭空自造替代品',
  '',
  '## 记忆与技能使用规则（重要）：',
  '1. 完成任务后，如果学到新信息（用户偏好、项目结构、技术选型），调用 memory.save(level="long", content="...", tags=["偏好","项目"]) 记录到长期记忆',
  '2. 复杂任务的执行流程可调用 memory.save(level="short", content="...") 记录到近期记忆（限任务摘要，不超过 100 字）',
  '3. 可复用的方法论/操作流程（如"如何分段写入长文"）调用 skill.save(name="xxx", content="markdown 全文") 沉淀为技能',
  '4. 记忆格式：content 一句话，具体明确；tags 不超过 3 个',
  '5. memory 和 skill 是不同概念：memory 记事实/偏好（短句），skill 记方法/流程（长文档）',
  '6. 技能名规范：英文小写+连字符（如 chang-wen-fen-duan-xie-ru）或中文均可',
  '7. 保存记忆前先用 memory.search 检索是否已存在相似内容，避免重复',
  '8. 被问到 token 用量/消耗/成本时：禁止凭感觉估算，必须调用 usage 插件（action=get 或 history）取真实数据作答，并区分"API 计费口径累计"与"净上下文"两个口径；对话中出现的 [token 计量] 注记也是真实数据，可直接引用',
  '9. JSON 配置文件必须使用双引号，不能使用单引号',
  '10. 任务完成后必须检查所有输出文件，确保格式正确',
  '11. 回复必须简洁，不超过 100 字，直接输出结果，不要解释过程',
  '12. 如果检索到相关记忆，必须在任务完成后保存重要发现到长期记忆',
  '13. 系统提示优先级：JSON 双引号 > 目录结构 > 技术栈 > 测试覆盖',
  '',
  '## 工具调用规则：',
  '1. 每次工具调用都必须完整提供所有必填参数；同一轮并行发起多个调用时，path 等参数每次都要单独带上，不能省略或依赖上一条',
  '2. edit 的 oldText 必须先用 read 读取文件后从返回内容逐字符复制（含空格缩进），不能凭记忆编写',
  '3. 需要联网信息时：先用 search(query=关键词) 搜索拿到结果列表，再用 fetch(url=...) 打开需要的链接读全文',
  '4. 长内容分段写入（必须遵守，API 通道对大参数不可靠）：首次 write 创建文件，每段 ≤1500 字符；后续续写一律用 write 的 append=true 逐段追加。绝不能用普通 write 续写——那会整体覆盖之前的段落。需要重新生成完整文件时才用普通 write（覆盖大文件需 confirm=true）。确认文件末尾用 read 的 tail 参数',
  '5. 收到「参数在 API 传输中丢失/截断」的提示时：第 1 次可原样重试；再次出现必须立即改为小分段（≤1500 字符/段 + append=true），禁止第三次发送大参数',
  '6. Python 模块导入：同目录文件可直接导入，跨目录需用 sys.path.insert 或相对导入',
  '',
  '## 任务完成报告：',
  '1. 输出检索到的记忆列表',
  '2. 说明每条记忆如何影响了你的决策',
  '3. 确认所有任务要求已完成',
  '4. 如果学到了新信息，调用 memory.save(level="long", ...) 保存到长期记忆'
].join('\n');

// 执行互斥：同一时刻只允许一路内层 / 一路外层（防止并发 SSE 交叉写坏会话状态）
let innerLock = false;
let outerLock = false;

// ---------- 网页在线检测与自动退出 ----------
// 语义：任何 /api 请求都视为"网页还开着"（前端有 20s 轮询心跳）；
// 网页关闭时前端用 sendBeacon 发 /api/bye 提前触发；全部网页关闭且
// 无任务执行时，超过 IDLE_MS 无人访问即自动退出（DUAL_AGENT_AUTOSTOP=0 常驻）。
const AUTOSTOP = process.env.DUAL_AGENT_AUTOSTOP !== '0';
const IDLE_MS = Number(process.env.DUAL_AGENT_IDLE_MS) > 0 ? Number(process.env.DUAL_AGENT_IDLE_MS) : 60000;
const BYE_GRACE_MS = Number(process.env.DUAL_AGENT_BYE_GRACE_MS) > 0 ? Number(process.env.DUAL_AGENT_BYE_GRACE_MS) : 25000; // bye 后宽限：默认大于前端轮询间隔 20s，多标签页时另一页的轮询会续命
// 首次运行（未配置内层 API 且非演示模式）多给 4 分钟配置时间，避免向导没填完就被退出
const _cfg0 = getConfig();
let lastSeen = Date.now() + (!(_cfg0.inner.base_url && _cfg0.inner.api_key && _cfg0.inner.model) && process.env.DUAL_AGENT_MOCK !== '1' ? 4 * 60000 : 0);
setInterval(() => {
  if (!AUTOSTOP || innerLock || outerLock) return;
  if (Date.now() - lastSeen > IDLE_MS) {
    console.log(`网页已全部关闭且空闲超过 ${Math.round(IDLE_MS / 1000)} 秒，自动退出（DUAL_AGENT_AUTOSTOP=0 可常驻）`);
    process.exit(0);
  }
}, 5000);

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  // ---------- 静态 ----------
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    lastSeen = Date.now(); // 打开/刷新页面也算在线
    fs.readFile(path.join(ROOT, 'public', 'index.html'), (e, d) => {
      if (e) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
    return;
  }
  if (req.method === 'GET' && p === '/process') {
    lastSeen = Date.now();
    fs.readFile(path.join(ROOT, 'public', 'process.html'), (e, d) => {
      if (e) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
    return;
  }
  if (req.method === 'GET' && p === '/help') {
    lastSeen = Date.now();
    fs.readFile(path.join(ROOT, 'public', 'help.html'), (e, d) => {
      if (e) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
    return;
  }

  try {
    // 网页关闭信号（sendBeacon）：把 lastSeen 拨回"IDLE_MS - 宽限"前，宽限内无新请求即退出
    if (p === '/api/bye' && req.method === 'POST') {
      lastSeen = Date.now() - IDLE_MS + BYE_GRACE_MS;
      json(res, 200, { success: true });
      return;
    }
    if (p.startsWith('/api/')) lastSeen = Date.now();
    // ---------- 健康/配置 ----------
    if (p === '/api/health' && req.method === 'GET') {
      const cfg = getConfig();
      const oc = await opencodeRunner();
      json(res, 200, {
        success: true, version: APP_VERSION,
        mock: process.env.DUAL_AGENT_MOCK === '1',
        innerConfigured: !!(cfg.inner.base_url && cfg.inner.api_key && cfg.inner.model),
        profileCount: validProfiles(cfg).length, // 多路 API：子智能体轮转分摊速率限制（0 = 仅主配置）
        opencode: oc ? oc.cmd : '', workspace: currentWorkspace(),
        workspaceDir: workspaceDir(), outerSession: cfg.outerSession || ''
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

    // ---------- 多工作区 ----------
    if (p === '/api/workspaces' && req.method === 'GET') {
      json(res, 200, { success: true, current: currentWorkspace(), workspaces: listWorkspaces() });
      return;
    }
    if (p === '/api/workspace/switch' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!WS_NAME_RE.test(name)) { json(res, 400, { success: false, error: '工作区名不合法（小写字母/数字/连字符）' }); return; }
      saveConfig({ workspace: name, outerSession: '', reviewMark: getInnerLog().length });
      fs.mkdirSync(path.join(WS_ROOT, name), { recursive: true });
      loadInnerMessages(); // 会话按工作区分片：切换=换载，原工作区历史保留可切回
      json(res, 200, { success: true, current: name, workspaces: listWorkspaces(), workspaceDir: path.join(WS_ROOT, name) });
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
      json(res, 200, { success: r.ok, error: r.error, warns: r.warns || [], plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }
    if (p === '/api/plugins/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const r = approval.manualDelete(String(body.name || '').trim());
      json(res, 200, { success: r.ok, error: r.error, plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }
    if (p === '/api/plugins/export' && req.method === 'GET') {
      const name = String(parsed.query.name || '').trim();
      if (!plugins.NAME_RE.test(name) || !plugins.readCode(name)) { json(res, 404, { success: false, error: '插件不存在' }); return; }
      const code = plugins.readCode(name);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}.js"`
      });
      res.end(code);
      return;
    }
    if (p === '/api/plugins/usage' && req.method === 'GET') {
      const action = String(parsed.query.action || '').trim();
      const usageMod = require('./plugins/usage');
      const usageCtx = { cwd: workspaceDir() }; // 与内层插件执行同源（inner-usage.json 按工作区落盘）
      if (action === 'get') {
        json(res, 200, { success: true, data: usageMod.getUsage(usageCtx) });
      } else if (action === 'history') {
        json(res, 200, { success: true, data: usageMod.getSessions(usageCtx) });
      } else {
        json(res, 400, { success: false, error: '未知 action，支持 get/history' });
      }
      return;
    }

    // ---------- 内层对话 ----------
    if (p === '/api/inner/chat' && req.method === 'POST') {
      if (innerLock) { json(res, 409, { success: false, error: '内层正在执行上一条任务，请稍候' }); return; }
      const body = await readBody(req);
      const message = String(body.message || '').trim();
      if (!message) { json(res, 400, { success: false, error: '消息为空' }); return; }
      const cfg = getConfig();
      if (process.env.DUAL_AGENT_MOCK !== '1' && !(cfg.inner.base_url && cfg.inner.api_key && cfg.inner.model)) {
        json(res, 400, { success: false, error: '内层 API 未配置：点右上角「配置」填写 base_url / api_key / model' });
        return;
      }
      innerLock = true;
      const send = sse(req, res);
      send({ type: 'start' });
      const WS_DIR = workspaceDir();
      // 过程记录：任务头 + 待落盘的中间回复（text 快照式，工具调用前 flush 避免重复）
      appendProcess(`\n---\n\n## ${fmtClock(Date.now())} 📋 任务\n\n${message}\n`);
      let pendingText = '';
      const flushText = () => {
        if (pendingText.trim()) appendProcess(`\n### ${fmtClock(Date.now())} 💬 内层\n\n${pendingText.trim()}\n`);
        pendingText = '';
      };
      // 确保系统提示在会话首位（历史会话无 system 时补插；reset 后重建）
      if (innerMessages[0] && innerMessages[0].role === 'system') innerMessages[0].content = INNER_SYSTEM_PROMPT;
      else innerMessages.unshift({ role: 'system', content: INNER_SYSTEM_PROMPT });
      // 多步任务检测 → 注入 todo 提醒到 user 消息尾部（实测 agnes-2.5-flash 无视 system 程序指令，
      // 但对紧邻任务文本遵循度高；注入落盘，历史中形成使用示范）
      let finalMsg = message;
      if (isMultiStepTask(message)) {
        finalMsg = message + '\n\n[框架提示] 本任务为多步任务，两项纪律：\n1) 开始执行前必须先用 todo 建任务清单（每个步骤一条 todo.add），每完成一步立即 todo.toggle(id=...)，全部完成时清单应全为 [x]。\n2) 收尾前必须用 verify 插件断言每个产出文件（exists + contains 内容特征 + line_count），看到 FAIL 先修复再重验，全 PASS 才能总结。';
        send({ type: 'info', text: '检测到多步任务，已注入任务清单+产出验证提醒' });
      }
      innerMessages.push({ role: 'user', content: finalMsg });
      persistInnerMessages();
      // 事件处理器（主/子智能体共用）：过程落盘 + usage 落账 + SSE 透传（子事件带 sub 标记）
      const handleEvent = (ev) => {
        if (ev.type === 'text' && !ev.sub) pendingText = ev.text;
        else if (ev.type === 'tool_call') {
          flushText();
          let pretty = '';
          try { pretty = JSON.stringify(ev.args, null, 2); } catch { pretty = String(ev.args); }
          appendProcess(`\n### ${fmtClock(Date.now())} 🔧 ${ev.sub ? '[子] ' : ''}${ev.plugin}\n\n**入参**\n\n\`\`\`json\n${pretty}\n\`\`\`\n`);
        } else if (ev.type === 'tool_result') {
          appendProcess(`**结果** ${ev.ok ? '✓' : '✗'}（${ev.ms}ms）${ev.sub ? ' [子智能体]' : ''}\n\n\`\`\`\n${String(ev.result).slice(0, 2000)}\n\`\`\`\n`);
        } else if (ev.type === 'info') {
          flushText();
          appendProcess(`\n### ${fmtClock(Date.now())} ⏳ ${String(ev.text || '')}\n`);
        } else if (ev.type === 'usage') {
          // token 计量落盘：逐轮追加（当轮量 + 会话累计），usage 插件与审计由此取数；子智能体标记 sub
          try {
            const uf = path.join(WS_DIR, 'inner-usage.json');
            let rows = [];
            try { rows = JSON.parse(fs.readFileSync(uf, 'utf8')); } catch { /* 首次 */ }
            if (!Array.isArray(rows)) rows = [];
            rows.push({ ts: Date.now(), prompt: ev.last.prompt, completion: ev.last.completion, cached: ev.last.cached, est: !!ev.est, sub: !!ev.sub, profile: ev.tag || 'main',
              totalsPrompt: ev.totals.prompt, totalsCompletion: ev.totals.completion, totalsCalls: ev.totals.calls });
            fs.writeFileSync(uf, JSON.stringify(rows, null, 1), 'utf8');
          } catch { /* 计量落盘失败不阻断会话 */ }
            appendProcess(`\n> 📊 token${ev.sub ? `（子智能体${ev.tag ? '@' + ev.tag : ''}）` : ''}（第 ${ev.totals.calls} 次调用${ev.est ? '，估算' : '，API 真实返回'}）：prompt ${ev.last.prompt} + 输出 ${ev.last.completion}；会话累计 prompt ${ev.totals.prompt} + 输出 ${ev.totals.completion}\n`);
        } else if (ev.type === 'error') {
          flushText();
          appendProcess(`\n### ${fmtClock(Date.now())} ❌ 错误\n\n${String(ev.content)}\n`);
        }
        send(ev);
      };
      // 子智能体派生（对标 Claude Code Task）：独立 messages 跑完整工具循环（8 轮上限），
      // 探索过程隔离在子上下文，主上下文只收结论。子级 ctx 不带 spawnSub → 无法再派生（深度 1）。
      // 多路 API（v0.9.6）：子任务轮转选择 inner_profiles 里的配置，并行请求分摊到不同端点，
      // 避免同一 LLM API 的并发速率限制；未配置 profiles 时回退主配置（行为与旧版一致）。
      // 限流韧性（v0.9.7）：轮次级 withRetry 短退避（1.5s 序列，主会话的一半——子任务轻量，
      // 快速把结果交回主会话决策优于长等）；轮次重试耗尽后任务级 failover：换下一路 profile
      // 从头重跑一次（无多路配置时直接失败），限流不再死磕单端点
      const SUB_MAX_ROUNDS = 8;
      const SUB_RETRY_BASE_MS = 1500;
      const SUB_RR = { n: 0 }; // 轮转计数器：跨子任务递增，均匀分摊
      const SUB_SYSTEM_PROMPT = [
        '你是子智能体，负责独立完成一个调研/探索型子任务并返回结论。',
        '规则：1) 直接执行，不要建 todo 清单；2) 结论必须自包含（数字/路径/关键原文），主会话看不到你的中间过程；',
        '3) 只做只读探索（read/search/fetch/memory），除非子任务明确要求写文件；4) 结论 ≤300 字，先给结果再给一句依据。'
      ].join('\n');
      const isTransientErr = e => !!(e && (e.retryable || (e.code && NET_CODES.test(e.code))));
      const runSubOnce = async (picked) => {
        const subMessages = [
          { role: 'system', content: SUB_SYSTEM_PROMPT },
          { role: 'user', content: String(description) }
        ];
        const subCallPlugin = async (name, args) => {
          const t0 = Date.now();
          const result = await plugins.runPlugin(name, args, { cwd: WS_DIR, dataDir: DATA_DIR }); // 无 spawnSub：子级禁止嵌套
          appendInnerLog({ ts: Date.now(), plugin: name, args, ok: !/^(插件 .+?(加载失败|执行出错|调用被拒绝))/.test(result), result: String(result).slice(0, 400), ms: Date.now() - t0, sub: true, profile: picked.name });
          return result;
        };
        const { chatInnerReal } = require('./lib/inner');
        return await chatInnerReal(picked.cfg, subMessages, plugins.toolDefs(), subCallPlugin,
          ev => handleEvent({ ...ev, sub: true, tag: ev.type === 'usage' ? picked.name : ev.tag }),
          { maxRounds: SUB_MAX_ROUNDS, tag: picked.name, retryBaseMs: SUB_RETRY_BASE_MS });
      };
      const spawnSub = async (description) => {
        const picked = pickProfile(cfg, SUB_RR);
        try {
          return await runSubOnce(picked);
        } catch (e) {
          if (!isTransientErr(e)) throw e; // 非限流/网络类错误（如 401 配置错）不换路重跑
          const fallback = pickProfile(cfg, SUB_RR); // 换下一路（轮转计数器已前进）
          if (fallback.name === picked.name) throw e; // 无其他路可换
          handleEvent({ type: 'info', text: `子任务@${picked.name} 限流重试耗尽，failover 换路 @${fallback.name} 重跑` });
          return await runSubOnce(fallback);
        }
      };
      const callPlugin = async (name, args) => {
        const t0 = Date.now();
        const result = await plugins.runPlugin(name, args, { cwd: WS_DIR, dataDir: DATA_DIR, spawnSub });
        // 一次追加完整条目（含耗时），替代旧的“占位+回读覆写”两段式
        appendInnerLog({ ts: Date.now(), plugin: name, args, ok: !/^(插件 .+?(加载失败|执行出错|调用被拒绝))/.test(result), result: String(result).slice(0, 400), ms: Date.now() - t0 });
        return result;
      };
      // 动态清单注记：每轮 API 调用前取最新 todo 状态注入发送副本（落盘干净）——
      // 对标 Claude Code TodoList 的「执行中可见」，模型无需 todo.list 也能对齐进度、发现偏差即修订
      const todoNote = () => {
        try {
          const arr = JSON.parse(fs.readFileSync(path.join(WS_DIR, '.todo.json'), 'utf8'));
          if (!Array.isArray(arr) || !arr.length) return '';
          const open = arr.filter(t => !t.done);
          const done = arr.filter(t => t.done);
          const lines = ['[任务清单] 当前进度（执行中发现计划不适用必须修订：todo.add 加步骤/调整后再继续）：'];
          for (const t of open) lines.push(`- [ ] #${t.id} ${t.text}`);
          const recentDone = done.slice(-3);
          for (const t of recentDone) lines.push(`- [x] #${t.id} ${t.text}`);
          if (done.length > recentDone.length) lines.push(`- （另有 ${done.length - recentDone.length} 项已完成略）`);
          return lines.join('\n');
        } catch { return ''; }
      };
      try {
        await chatInner(cfg.inner, innerMessages, plugins.toolDefs(), callPlugin, handleEvent, { todoNote });
        flushText();
        persistInnerMessages();
        send({ type: 'done' });
      } catch (e) {
        appendProcess(`\n### ${fmtClock(Date.now())} ❌ 错误\n\n${String((e && e.message) || e)}\n`);
        send({ type: 'error', content: String((e && e.message) || e) });
        send({ type: 'done' });
      } finally {
        innerLock = false;
        try { res.end(); } catch { /* closed */ }
      }
      return;
    }
    // 过程文件内容（/process 页轮询拉取；执行中任务 mtime 变化时增量刷新）
    if (p === '/api/process' && req.method === 'GET') {
      let mtime = 0;
      try { mtime = fs.statSync(processPath()).mtimeMs; } catch { /* 无文件 */ }
      json(res, 200, { success: true, content: readProcess(), path: processPath(), mtime, running: innerLock });
      return;
    }
    if (p === '/api/inner/messages' && req.method === 'GET') {
      json(res, 200, { success: true, messages: innerMessages.filter(m => m.role !== 'system').slice(-60) });
      return;
    }
    if (p === '/api/inner/reset' && req.method === 'POST') {
      if (innerLock) { json(res, 409, { success: false, error: '内层执行中，不能清空' }); return; }
      clearInnerMessages();
      json(res, 200, { success: true });
      return;
    }

    // ---------- 外层对话（opencode 会话续聊：-s ses_xxx，会话 ID 持久化） ----------
    if (p === '/api/outer/chat' && req.method === 'POST') {
      if (outerLock) { json(res, 409, { success: false, error: '外层正在分析上一条指令，请稍候' }); return; }
      const body = await readBody(req);
      const message = String(body.message || '').trim();
      if (!message) { json(res, 400, { success: false, error: '消息为空' }); return; }
      const runner = await opencodeRunner();
      if (process.env.DUAL_AGENT_MOCK !== '1' && !runner) {
        json(res, 400, { success: false, error: '未检测到 opencode。安装：npm install -g opencode-ai，配置登录：opencode auth login；也可在环境变量 DUAL_AGENT_OPENCODE_CMD 指定完整路径' });
        return;
      }
      outerLock = true;
      const cfg = getConfig();
      const sessionId = cfg.outerSession || '';
      const send = sse(req, res);
      send({ type: 'start' });
      // 单向上下文：软约束提示词 + 插件清单（首评附全量源码）+ 审批历史 + 内层日志（失败详/成功简）
      const ctxOpts = { audit: recentAuditLines(5), scores: require('./lib/regression').pluginScores(getInnerLog()) };
      if (!sessionId) {
        // 首次评审（无续聊会话）：全量附带插件源码，杜绝外层"凭描述盲写"
        const codes = new Map();
        for (const pl of plugins.listPlugins()) codes.set(pl.name, plugins.readCode(pl.name));
        ctxOpts.codes = codes;
      }
      const prompt = `${outerMod.SYSTEM_PROMPT}\n\n${outerMod.buildContext(plugins.listPlugins(), getInnerLog(), ctxOpts)}\n\n== 用户指令 ==\n${message}`;
      let fullText = '';
      try {
        const r = await outerMod.runOuter(runner, prompt, ROOT, ev => {
          if (ev.type === 'text') { fullText = ev.text; send(ev); }
          else if (ev.type === 'info') send(ev); // 限流退避提示转发前端
          else if (ev.type === 'session' && ev.sessionId && ev.sessionId !== sessionId) {
            saveConfig({ outerSession: ev.sessionId }); // 首个 sessionID 回填，下次续聊
            send(ev);
          }
        }, sessionId);
        if (r.error) send({ type: 'error', content: r.error });
        // 发起评审即视为已处理评审提示
        saveConfig({ reviewMark: getInnerLog().length });
        // 解析建议 json → 审批队列
        const props = outerMod.parseProposals(fullText);
        const added = [];
        for (const pr of props) {
          const r2 = approval.addProposal(pr, 'outer');
          if (r2.ok) added.push(r2.proposal.id);
          else send({ type: 'notice', content: `建议无效已忽略：${r2.error}` });
        }
        if (!props.length && /```/.test(fullText)) {
          send({ type: 'notice', content: '外层回复含代码块但未解析出任何建议（JSON 格式不合规范）。请在右栏要求其按标准 ```json proposals 格式重发。' });
        }
        send({ type: 'proposals', added, count: added.length });
        send({ type: 'done' });
      } catch (e) {
        send({ type: 'error', content: String((e && e.message) || e) });
        send({ type: 'done' });
      } finally {
        outerLock = false;
        try { res.end(); } catch { /* closed */ }
      }
      return;
    }
    if (p === '/api/outer/new-session' && req.method === 'POST') {
      saveConfig({ outerSession: '' });
      json(res, 200, { success: true });
      return;
    }

    // ---------- 自动评审提示（内层累计调用/失败达到阈值时建议发起外层评审） ----------
    if (p === '/api/review-hint' && req.method === 'GET') {
      const log = getInnerLog();
      const mark = Math.min(Number(getConfig().reviewMark) || 0, log.length);
      const recent = log.slice(mark);
      const calls = recent.length;
      const fails = recent.filter(l => !l.ok).length;
      json(res, 200, { success: true, suggest: calls >= 12 || fails >= 3, calls, fails, outerSession: getConfig().outerSession || '' });
      return;
    }
    if (p === '/api/review-ack' && req.method === 'POST') {
      saveConfig({ reviewMark: getInnerLog().length });
      json(res, 200, { success: true });
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
    }    if (p === '/api/inner-log' && req.method === 'GET') {
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

// 就绪后自动打开浏览器（一键启动体验；无头/CI 环境自动跳过，DUAL_AGENT_NO_BROWSER=1 显式关闭）
function openBrowser(target) {
  if (process.env.DUAL_AGENT_NO_BROWSER === '1') return;
  if (process.platform === 'linux' && !process.env.DISPLAY) return;
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${target}"`
    : process.platform === 'darwin' ? `open "${target}"`
    : `xdg-open "${target}"`;
  exec(cmd, { timeout: 8000 }, () => { /* 打不开不影响服务 */ });
}

server.listen(PORT, '127.0.0.1', () => {
  const url0 = `http://localhost:${PORT}`;
  console.log(`双层 Agent 自迭代系统已启动: ${url0}`);
  console.log(`工作区: ${currentWorkspace()}（${workspaceDir()}）`);
  if (process.env.DUAL_AGENT_MOCK === '1') console.log('演示模式：内层假 LLM + 外层假 opencode（不依赖真实 API）');
  if (AUTOSTOP) console.log(`全部网页关闭且空闲超 ${Math.round(IDLE_MS / 1000)} 秒后自动退出（DUAL_AGENT_AUTOSTOP=0 可常驻）`);
  openBrowser(url0);
});

// 优雅退出：Ctrl+C / 关闭启动窗口；server.close 带 5 秒强制退出兜底（防 keep-alive 连接挂住）
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务器...`);
  const force = setTimeout(() => process.exit(0), 5000);
  server.close(() => { clearTimeout(force); console.log('服务器已关闭'); process.exit(0); });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
