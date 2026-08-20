// 插件运行时：清单扫描（注释头元信息）+ 渐进式加载 + 热插拔
// 插件文件约定（元信息在注释头，系统无需 require 即可列清单）：
//   // @name read
//   // @desc 读取文本文件内容
//   // @essential true
// module.exports = { params: <JSON Schema>, run: async (args, ctx) => string }
// 渐进式加载：essential 插件启动即 require；业务插件首次调用时才 require（缓存复用）
const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const NAME_RE = /^[a-z0-9-]{1,40}$/;

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

// 执行插件：懒加载 → run → 异常转错误字符串回传 LLM（不中断会话）
async function runPlugin(name, args, ctx) {
  if (!loaded.has(name)) {
    const err = tryLoad(name);
    if (err) return `插件 ${name} 加载失败：${err}`;
  }
  const mod = loaded.get(name);
  try {
    const r = await mod.run(args || {}, ctx);
    const s = String(r ?? '');
    return s.length > 8192 ? s.slice(0, 8192) + '\n…（输出过长已截断）' : s;
  } catch (e) {
    return `插件 ${name} 执行出错：${String((e && e.message) || e)}`;
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
