// 插件运行时：清单扫描（注释头元信息）+ 渐进式加载 + 热插拔
// 插件文件约定（元信息在注释头，系统无需 require 即可列清单）：
//   // @name read
//   // @desc 读取文本文件内容
//   // @essential true
// module.exports = { params: <JSON Schema>, run: async (args, ctx) => string }
// 渐进式加载：essential 插件启动即 require；业务插件首次调用时才 require（缓存复用）
const fs = require('fs');
const path = require('path');

// 插件目录可经 DUAL_AGENT_PLUGINS_DIR 覆盖（测试隔离用），默认随代码库
const PLUGINS_DIR = process.env.DUAL_AGENT_PLUGINS_DIR || path.join(__dirname, '..', 'plugins');
const NAME_RE = /^[a-z0-9-]{1,40}$/;
// 单次插件执行兜底超时（防业务插件挂起卡死内层循环；bash 内部另有 30s 细粒度超时）
const RUN_TIMEOUT_MS = Number(process.env.DUAL_AGENT_PLUGIN_TIMEOUT_MS) > 0 ? Number(process.env.DUAL_AGENT_PLUGIN_TIMEOUT_MS) : 60000;

// 解析注释头元信息（不执行插件代码）
function parseMeta(file) {
  const src = fs.readFileSync(path.join(PLUGINS_DIR, file), 'utf8');
  const head = src.split(/\r?\n/).slice(0, 12).join('\n');
  const name = (head.match(/^\/\/\s*@name\s+(.+)$/m) || [])[1];
  const desc = (head.match(/^\/\/\s*@desc\s+(.+)$/m) || [])[1];
  const essential = /^\/\/\s*@essential\s+true/m.test(head);
  return { name: (name || '').trim(), desc: (desc || '').trim(), essential };
}

// 插件清单：全部 .js 文件（元信息 + 加载状态；损坏文件标记 broken 不影响他者）
function listPlugins() {
  let files = [];
  try { files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js')); } catch { /* ignore */ }
  const out = [];
  for (const f of files) {
    const base = f.slice(0, -3);
    let meta = { name: base, desc: '', essential: false };
    let broken = '';
    try { meta = { ...meta, ...parseMeta(f) }; } catch (e) { broken = String(e.message || e); }
    if (!meta.name) meta.name = base;
    if (!NAME_RE.test(meta.name)) { out.push({ name: base, desc: meta.desc, essential: false, status: 'broken', err: `插件名 "${meta.name}" 不合法（限小写字母/数字/连字符）` }); continue; }
    if (broken) { out.push({ name: meta.name, desc: meta.desc, essential: false, status: 'broken', err: broken }); continue; }
    // essential 插件启动即加载验证；业务插件保持懒加载状态
    if (meta.essential && !loaded.has(meta.name)) {
      const err = tryLoad(meta.name);
      if (err) { out.push({ name: meta.name, desc: meta.desc, essential: true, status: 'broken', err }); continue; }
    }
    out.push({
      name: meta.name,
      desc: meta.desc,
      essential: !!meta.essential,
      status: loaded.has(meta.name) ? 'loaded' : 'lazy',
      err: ''
    });
  }
  return out.sort((a, b) => (b.essential - a.essential) || a.name.localeCompare(b.name));
}

// ---------- 加载与执行 ----------
const loaded = new Map(); // name -> { params, run }

function pluginPath(name) { return path.join(PLUGINS_DIR, `${name}.js`); }

// require 加载（捕获语法/顶层错误），成功返回 ''，失败返回错误信息
function tryLoad(name) {
  try {
    const p = pluginPath(name);
    delete require.cache[require.resolve(p)];
    const mod = require(p);
    if (!mod || typeof mod.run !== 'function') return '插件必须导出 run 函数';
    loaded.set(name, mod);
    return '';
  } catch (e) {
    loaded.delete(name);
    return String((e && e.message) || e);
  }
}

// 热加载：清缓存重新加载（审批应用/手动保存后调用；失败保留旧版本并返回错误）
function hotReload(name) {
  const err = tryLoad(name);
  return err; // '' = 成功
}
function hotUnload(name) { loaded.delete(name); }

// 统一必填参数校验：用插件 params.required（JSON Schema）在执行前兜底。
// 缺参时返回明确的可重试错误（LLM 看到后会按 schema 重新调用），避免插件拿到残缺参数
// 炸出 EISDIR / undefined 这类费解错误（曾发生：write 空参数 → path.resolve(cwd,'') → 写目录 EISDIR）
function checkRequired(mod, args) {
  const req = mod && mod.params && Array.isArray(mod.params.required) ? mod.params.required : [];
  const missing = req.filter(k => args[k] === undefined || args[k] === null || (typeof args[k] === 'string' && !args[k].trim()));
  if (!missing.length) return '';
  return `插件调用缺少必填参数：${missing.join('、')}。请按参数说明（JSON Schema）重新调用并提供完整参数；` +
    `若你确认上一轮已提供参数，说明超长输出在传输中被截断，请大幅缩短单次写入内容（如分多次写入文件的相邻片段）。`;
}

// 执行插件：懒加载 → 参数校验 → run（带兜底超时，防挂起）→ 异常/超时转错误字符串回传 LLM（不中断会话）
async function runPlugin(name, args, ctx) {
  if (!loaded.has(name)) {
    const err = tryLoad(name);
    if (err) return `插件 ${name} 加载失败：${err}`;
  }
  const mod = loaded.get(name);
  // 参数形态校验：必须是对象（LLM 偶发发字符串/数组/null）
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return `插件 ${name} 调用被拒绝：参数必须是 JSON 对象（本次收到 ${args === null ? 'null' : typeof args}），请重新调用。`;
  }
  const missErr = checkRequired(mod, args);
  if (missErr) return `插件 ${name} 调用被拒绝：${missErr}`;
  let timer = null;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(`__DA_TIMEOUT__`), RUN_TIMEOUT_MS);
    });
    const r = await Promise.race([Promise.resolve(mod.run(args || {}, ctx)), timeout]);
    if (r === '__DA_TIMEOUT__') return `插件 ${name} 执行出错：超过 ${Math.round(RUN_TIMEOUT_MS / 1000)} 秒未返回，已放弃等待（插件可能仍在后台运行）`;
    const s = String(r ?? '');
    return s.length > 8192 ? s.slice(0, 8192) + '\n…（输出过长已截断）' : s;
  } catch (e) {
    return `插件 ${name} 执行出错：${String((e && e.message) || e)}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// OpenAI tools 定义（broken 插件不进列表）
function toolDefs() {
  return listPlugins()
    .filter(p => p.status !== 'broken')
    .map(p => ({
      type: 'function',
      function: {
        name: p.name,
        description: p.desc || p.name,
        parameters: (loaded.has(p.name) && loaded.get(p.name).params) || { type: 'object', properties: {} }
      }
    }));
}

// 读取插件源码（前端查看/diff 用）
function readCode(name) {
  try { return fs.readFileSync(pluginPath(name), 'utf8'); } catch { return ''; }
}
function writeCode(name, code) {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  fs.writeFileSync(pluginPath(name), String(code || ''), 'utf8');
}
function deleteCode(name) {
  try { fs.unlinkSync(pluginPath(name)); hotUnload(name); return true; } catch { return false; }
}

module.exports = { listPlugins, toolDefs, runPlugin, hotReload, hotUnload, readCode, writeCode, deleteCode, PLUGINS_DIR, NAME_RE };
