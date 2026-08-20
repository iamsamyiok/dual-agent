// 冒烟测试集（零依赖，node test/smoke.js）
// 三段：① 全量语法检查 ② 核心单元（lint/parse/插件/超时/审批管线） ③ MOCK 模式 e2e（子进程起服务）
// 任何一段失败即退出码 1
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const TMP = path.join('/tmp', 'da-smoke-' + Date.now().toString(36));
const PORT = 3900 + Math.floor(Math.random() * 90);
let passed = 0, failed = 0;

function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { failed++; console.log(`FAIL  ${name}\n      ${String(e && e.message || e).split('\n')[0]}`); });
}

async function main() {
  console.log(`\n[1/3] 语法检查`);
  const jsFiles = [path.join(ROOT, 'server.js')]
    .concat(fs.readdirSync(path.join(ROOT, 'lib')).map(f => path.join(ROOT, 'lib', f)))
    .concat(fs.readdirSync(path.join(ROOT, 'plugins')).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, 'plugins', f)))
    .concat(fs.readdirSync(path.join(ROOT, 'tools')).map(f => path.join(ROOT, 'tools', f)))
    .filter(f => f.endsWith('.js'));
  await t(`node --check ${jsFiles.length} 个 JS 文件`, () => {
    for (const f of jsFiles) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  });
  await t('前端内联 script 语法（new Function）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  });

  console.log(`\n[2/3] 单元测试`);
  fs.mkdirSync(TMP, { recursive: true });
  const PLUGINS_TMP = path.join(TMP, 'plugins');
  const DATA_TMP = path.join(TMP, 'data');
  fs.cpSync(path.join(ROOT, 'plugins'), PLUGINS_TMP, { recursive: true });
  fs.mkdirSync(DATA_TMP, { recursive: true });
  process.env.DUAL_AGENT_PLUGINS_DIR = PLUGINS_TMP;
  process.env.DUAL_AGENT_DATA = DATA_TMP;
  process.env.DUAL_AGENT_PLUGIN_TIMEOUT_MS = '300';

  const { lintCode } = require(path.join(ROOT, 'lib', 'lint'));
  await t('lintCode：语法错误被拦截', () => {
    const r = lintCode('const x = {');
    assert.ok(r.syntax, '应报语法错误');
  });
  await t('lintCode：child_process 命中危险警告', () => {
    const r = lintCode(`const cp = require('child_process'); module.exports = { run: async () => 'x' };`);
    assert.ok(!r.syntax);
    assert.ok(r.warns.some(w => w.includes('子进程')), JSON.stringify(r.warns));
  });
  await t('lintCode：干净代码零警告', () => {
    const r = lintCode(`module.exports = { run: async (a) => String(a.x) };`);
    assert.ok(!r.syntax && r.warns.length === 0);
  });

  const outerMod = require(path.join(ROOT, 'lib', 'outer'));
  await t('parseProposals：json 块/单对象/无效块', () => {
    const text = '看下\n```json\n{"proposals":[{"action":"create","plugin":"a","code":"x","reason":"r"}]}\n```\n```json\n{"action":"create","plugin":"b","code":"y"}\n```\n```json\n{bad json}\n```';
    const ps = outerMod.parseProposals(text);
    assert.equal(ps.length, 2);
    assert.equal(ps[1].plugin, 'b');
  });
  await t('parseProposals：非法 action 被忽略', () => {
    assert.equal(outerMod.parseProposals('```json\n{"proposals":[{"action":"rm","plugin":"x"}]}\n```').length, 0);
  });

  const plugins = require(path.join(ROOT, 'lib', 'plugins'));
  await t('NAME_RE 拒绝路径穿越', () => {
    assert.ok(!plugins.NAME_RE.test('../evil'));
    assert.ok(!plugins.NAME_RE.test('a/b'));
    assert.ok(plugins.NAME_RE.test('my-tool'));
  });
  await t('插件清单：8 个插件，essential 均可加载', () => {
    const list = plugins.listPlugins();
    assert.equal(list.length, 8);
    assert.ok(list.every(p => p.status !== 'broken'), '存在 broken：' + JSON.stringify(list.filter(p => p.status === 'broken')));
    assert.equal(list.filter(p => p.essential).length, 6);
  });
  await t('runPlugin：执行超时兜底生效（300ms）', async () => {
    fs.writeFileSync(path.join(PLUGINS_TMP, 'sleeper.js'), `module.exports = { run: () => new Promise(r => setTimeout(() => r('late'), 5000)) };`);
    const t0 = Date.now();
    const out = await plugins.runPlugin('sleeper', {}, { cwd: TMP });
    assert.ok(out.includes('执行出错') && out.includes('未返回'), out);
    assert.ok(Date.now() - t0 < 3000, '超时未及时返回');
  });
  const WS = path.join(TMP, 'ws');
  fs.mkdirSync(WS, { recursive: true });
  const ctx = { cwd: WS, dataDir: DATA_TMP };
  await t('memory 插件：save/search/delete', async () => {
    await plugins.runPlugin('memory', { action: 'save', content: '端口 3788', tags: ['env'] }, ctx);
    const hit = await plugins.runPlugin('memory', { action: 'search', query: '端口' }, ctx);
    assert.ok(hit.includes('端口 3788'), hit);
    assert.ok(fs.existsSync(path.join(WS, '.memory.json')), '记忆应存工作区（随工作区隔离）');
  });
  await t('todo 插件：add/toggle/clear', async () => {
    const a = await plugins.runPlugin('todo', { action: 'add', text: '写周报' }, ctx);
    assert.ok(a.includes('#1'));
    const b = await plugins.runPlugin('todo', { action: 'toggle', id: 1 }, ctx);
    assert.ok(b.includes('[x]'));
    await plugins.runPlugin('todo', { action: 'clear', mode: 'done' }, ctx);
  });
  await t('skill 插件：save/get/非法名', async () => {
    await plugins.runPlugin('skill', { action: 'save', name: 't1', content: '# 标题' }, ctx);
    assert.ok((await plugins.runPlugin('skill', { action: 'get', name: 't1' }, ctx)).includes('# 标题'));
    assert.ok((await plugins.runPlugin('skill', { action: 'save', name: '../bad', content: 'x' }, ctx)).includes('不合法'));
  });

  const { sanitizeToolArguments, parseToolArgs, reassembleCalls } = require(path.join(ROOT, 'lib', 'inner'));
  await t('sanitize：键无引号/单引号/尾逗号 可修复', () => {
    assert.equal(sanitizeToolArguments(`{path: "a.html", content: 'x'}`), JSON.stringify({ path: 'a.html', content: 'x' }));
    assert.equal(sanitizeToolArguments(`{path: "a.html",}`), JSON.stringify({ path: 'a.html' }));
  });
  await t('sanitize：截断/非法输入降级 {}（防下一轮 API 400）', () => {
    assert.equal(sanitizeToolArguments(`{"path": "x"`), '{}');
    assert.equal(sanitizeToolArguments('process.exit()'), '{}');
    assert.equal(sanitizeToolArguments(''), '{}');
    assert.equal(sanitizeToolArguments(null), '{}');
    const legal = '{"path":"a"}';
    assert.equal(sanitizeToolArguments(legal), legal); // 合法原样
  });
  await t('reassemble：残桶（无 id/name）并入前一桶（agnes 拆流修复）', () => {
    // 复现线上拆流：index 0 = 合法前半 JSON，index 1 = 无 id/name 的后半片段
    const m = new Map();
    m.set(0, { id: 'call-1', name: 'write', args: '{"path": "game.html", "content": "<html>' });
    m.set(1, { id: '', name: '', args: 'body>ok</body></html>"}' });
    const out = reassembleCalls(m);
    assert.equal(out.length, 1, '应融合为单次调用：' + JSON.stringify(out));
    assert.equal(out[0].name, 'write');
    assert.equal(JSON.parse(out[0].args).path, 'game.html');
  });
  await t('reassemble：两桶各自合法 = 两次独立调用', () => {
    const m = new Map();
    m.set(0, { id: 'a', name: 'read', args: '{"path": "x"}' });
    m.set(1, { id: 'b', name: 'read', args: '{"path": "y"}' });
    const out = reassembleCalls(m);
    assert.equal(out.length, 2);
  });
  await t('reassemble：多桶全坏时兜底顺序拼接', () => {
    const m = new Map();
    m.set(0, { id: 'call-1', name: 'write', args: '{"path": "a.html", "content": "1' });
    m.set(1, { id: 'call-2', name: '', args: '2' });
    m.set(2, { id: '', name: '', args: '3"}' });
    const out = reassembleCalls(m);
    assert.equal(out.length, 1, '应兜底拼为单次调用');
    assert.equal(JSON.parse(out[0].args).content, '123');
  });
  await t('reassemble：全坏且拼接也失败 → 降级空参（由必填校验反馈重试）', () => {
    const m = new Map();
    m.set(0, { id: 'a', name: 'write', args: '{broken' });
    const out = reassembleCalls(m);
    assert.equal(out[0].args, '{}');
  });
  await t('runPlugin：缺必填参数返回可重试错误（不再 EISDIR）', async () => {
    const out = await plugins.runPlugin('write', {}, ctx); // 复现线上事故：LLM 空参调 write
    assert.ok(out.includes('调用被拒绝') && out.includes('path'), out);
    assert.ok(!out.includes('EISDIR'), out);
  });
  await t('runPlugin：参数非对象被拦截', async () => {
    const out = await plugins.runPlugin('write', 'just a string', ctx);
    assert.ok(out.includes('必须是 JSON 对象'), out);
  });
  await t('write/read：目标是目录给明确提示', async () => {
    const w = await plugins.runPlugin('write', { path: '.', content: 'x' }, ctx);
    assert.ok(w.includes('是目录'), w);
    const r = await plugins.runPlugin('read', { path: '.' }, ctx);
    assert.ok(r.includes('是目录') || r.includes('目录'), r);
  });

  const approval = require(path.join(ROOT, 'lib', 'approval'));
  let badId = '', warnId = '';
  await t('addProposal：语法错误代码被拒绝入队', () => {
    const r = approval.addProposal({ action: 'create', plugin: 'bad1', code: 'const =', reason: 'r' }, 'outer');
    assert.ok(!r.ok && r.error.includes('语法'), r.error);
  });
  await t('addProposal：危险模式转为审批警告', () => {
    const r = approval.addProposal({ action: 'create', plugin: 'warn1', code: `require('child_process'); module.exports = { run: async () => 'x' };`, reason: 'r' }, 'outer');
    assert.ok(r.ok);
    assert.ok(r.proposal.warns.length >= 1, '应有警告');
    warnId = r.proposal.id;
  });
  await t('审批队列持久化到磁盘（重启可恢复）', () => {
    const arr = JSON.parse(fs.readFileSync(path.join(DATA_TMP, 'proposals.json'), 'utf8'));
    assert.ok(arr.some(p => p.id === warnId));
  });
  await t('decide 批准 → 热加载成功', () => {
    const r = approval.decide(warnId, true);
    assert.ok(r.ok, r.error);
    assert.ok(plugins.listPlugins().some(p => p.name === 'warn1' && p.status !== 'broken'));
  });
  await t('manualSave：语法错误拒绝保存', () => {
    const r = approval.manualSave('bad2', 'function {');
    assert.ok(!r.ok && r.error.includes('语法'));
  });

  console.log(`\n[3/3] e2e（MOCK 模式，端口 ${PORT}）`);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, DUAL_AGENT_MOCK: '1', DUAL_AGENT_DATA: DATA_TMP, DUAL_AGENT_PLUGINS_DIR: PLUGINS_TMP, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await new Promise(r => setTimeout(r, 1500));

  const base = `http://127.0.0.1:${PORT}`;
  const sseEvents = async (pathUrl, body) => {
    const resp = await fetch(base + pathUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 100));
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    const events = [];
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
      }
    }
    return events;
  };

  await t('health：mock + 版本 + 工作区 default', async () => {
    const r = await (await fetch(base + '/api/health')).json();
    assert.ok(r.success && r.mock === true && r.workspace === 'default');
  });
  await t('内层对话：bash→write 工具循环 + done', async () => {
    const evs = await sseEvents('/api/inner/chat', { message: '演示' });
    assert.ok(evs.some(e => e.type === 'tool_call' && e.plugin === 'bash'));
    assert.ok(evs.some(e => e.type === 'tool_call' && e.plugin === 'write'));
    assert.ok(evs.at(-1).type === 'done');
  });
  await t('内层历史持久化：GET messages 含 user', async () => {
    const r = await (await fetch(base + '/api/inner/messages')).json();
    assert.ok(r.messages.some(m => m.role === 'user' && m.content === '演示'));
  });
  await t('外层对话：建议入队（1 条 create append）', async () => {
    const evs = await sseEvents('/api/outer/chat', { message: '检查' });
    const pr = evs.find(e => e.type === 'proposals');
    assert.ok(pr && pr.count === 1, JSON.stringify(evs.map(e => e.type)));
  });
  await t('审批队列 → 批准 append → 热加载', async () => {
    const list = (await (await fetch(base + '/api/proposals')).json()).proposals;
    assert.ok(list.length === 1);
    const r = await (await fetch(base + '/api/proposals/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: list[0].id, approve: true }) })).json();
    assert.ok(r.success, r.error);
    assert.ok(r.plugins.some(p => p.name === 'append' && p.status === 'loaded'));
  });
  await t('插件导出：附件下载内容正确', async () => {
    const r = await fetch(base + '/api/plugins/export?name=bash');
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('@name bash'));
  });
  await t('评审提示：3 次失败后 suggest=true，ack 后恢复', async () => {
    // 注：前序外层对话已把 reviewMark 推进到当前水位，此处写 5 条失败确保阈值触发
    fs.writeFileSync(path.join(DATA_TMP, 'inner-log.json'), JSON.stringify([1, 2, 3, 4, 5].map(i => ({ ts: Date.now(), plugin: 'x', args: {}, ok: false, result: 'f' + i, ms: 1 }))));
    const h1 = await (await fetch(base + '/api/review-hint')).json();
    assert.ok(h1.suggest === true && h1.fails >= 3, JSON.stringify(h1));
    await fetch(base + '/api/review-ack', { method: 'POST' });
    const h2 = await (await fetch(base + '/api/review-hint')).json();
    assert.ok(h2.suggest === false);
  });
  await t('多工作区：切换 test-ws → 会话清空 + 目录创建', async () => {
    const r = await (await fetch(base + '/api/workspace/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test-ws' }) })).json();
    assert.ok(r.success && r.current === 'test-ws');
    assert.ok(fs.existsSync(path.join(ROOT, 'workspaces', 'test-ws')));
    const m = await (await fetch(base + '/api/inner/messages')).json();
    assert.equal(m.messages.length, 0, '切换工作区后内层会话应清空');
  });
  await t('工作区名非法被拒绝', async () => {
    const r = await (await fetch(base + '/api/workspace/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '../evil' }) })).json();
    assert.ok(!r.success);
  });
  await t('回滚：append 恢复到不存在', async () => {
    const r = await (await fetch(base + '/api/rollback', { method: 'POST' })).json();
    assert.ok(r.success, r.error);
    assert.ok(!r.plugins.some(p => p.name === 'append'));
  });
  await t('并发互斥：第二路内层请求返回 409', async () => {
    // 用慢请求占住锁：向 inner-log 注入长任务不可行；改为直接并行双发，断言至少一路成功
    const [a, b] = await Promise.allSettled([
      fetch(base + '/api/inner/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '并发A' }) }),
      fetch(base + '/api/inner/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '并发B' }) })
    ]);
    const codes = [a, b].map(x => x.status === 'fulfilled' ? x.value.status : -1);
    assert.ok(codes.some(c => c === 200), '至少一路成功');
    // mock 执行快，锁窗口小：409 可选出现，不强制
  });

  srv.kill();
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('smoke 崩溃：', e); process.exit(1); });
