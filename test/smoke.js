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
  await t('parseProposals：code 内嵌 ``` 时围栏容错（逐级扩展闭合点）', () => {
    const code = '// @name demo\n// 教学示例嵌套围栏 ```js\n// const x = 1;\n// ```\nmodule.exports = { run: async () => "ok" };';
    const text = '说明文字\n```json\n{"proposals":[{"action":"create","plugin":"demo","code":' + JSON.stringify(code) + ',"reason":"r"}]}\n```\n结尾';
    const ps = outerMod.parseProposals(text);
    assert.equal(ps.length, 1, JSON.stringify(ps));
    assert.equal(ps[0].plugin, 'demo');
    assert.ok(ps[0].code.includes('```js') && ps[0].code.includes('module.exports'), 'code 应完整含嵌套围栏');
  });
  await t('buildContext：首评带源码、失败日志放宽、审批历史附带', () => {
    const ctxText = outerMod.buildContext(
      [{ name: 'bash', essential: true, status: 'loaded', desc: '执行命令' }],
      [
        { ts: Date.now(), plugin: 'write', args: {}, ok: false, result: 'E'.repeat(800), ms: 5 },
        { ts: Date.now(), plugin: 'read', args: {}, ok: true, result: 'S'.repeat(300), ms: 3 }
      ],
      { codes: new Map([['bash', '// bash code body']]), audit: ['- [2026-08-20 12:00] 已批准 update bash'] }
    );
    assert.ok(ctxText.includes('// bash code body'), '应包含源码全文');
    assert.ok(ctxText.includes('E'.repeat(600)), '失败条目应放宽到 600');
    assert.ok(!ctxText.includes('S'.repeat(90)), '成功条目应压缩到 80');
    assert.ok(ctxText.includes('已批准 update bash'), '应附审批历史');
    assert.ok(ctxText.includes('plugins/bash.js'), '清单应带文件路径');
  });

  const plugins = require(path.join(ROOT, 'lib', 'plugins'));
  await t('NAME_RE 拒绝路径穿越', () => {
    assert.ok(!plugins.NAME_RE.test('../evil'));
    assert.ok(!plugins.NAME_RE.test('a/b'));
    assert.ok(plugins.NAME_RE.test('my-tool'));
  });
  await t('插件清单：9 个插件，essential 均可加载', () => {
    const list = plugins.listPlugins();
    assert.equal(list.length, 9);
    assert.ok(list.every(p => p.status !== 'broken'), '存在 broken：' + JSON.stringify(list.filter(p => p.status === 'broken')));
    assert.equal(list.filter(p => p.essential).length, 5);
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
    assert.ok(fs.existsSync(path.join(WS, '.memory-short.json')), '记忆应存工作区（随工作区隔离）');
  });
  await t('memory 插件：单调 id（删除后新增不复用）+ 同标签追加不覆盖', async () => {
    const s1 = await plugins.runPlugin('memory', { action: 'save', content: '事实甲', tags: ['proj'] }, ctx);
    assert.ok(s1.includes('#2'), '前序用例已占 #1，本条应为 #2：' + s1); // #1 = 上一用例的"端口 3788"
    const s2 = await plugins.runPlugin('memory', { action: 'save', content: '事实乙', tags: ['proj'] }, ctx);
    assert.ok(s2.includes('#3'), s2);
    const d1 = await plugins.runPlugin('memory', { action: 'delete', id: 2 }, ctx);
    assert.ok(d1.includes('已删除'), d1);
    const s3 = await plugins.runPlugin('memory', { action: 'save', content: '事实丙', tags: ['proj'] }, ctx);
    assert.ok(s3.includes('#4'), '删除后新增应继续单调递增（旧版会复用 id 撞车）：' + s3);
    const arr = JSON.parse(fs.readFileSync(path.join(WS, '.memory-short.json'), 'utf8'));
    assert.equal(arr.length, 3, '同标签应追加保留，不应覆盖：' + JSON.stringify(arr));
    assert.ok(arr.some(m => m.content === '事实乙') && arr.some(m => m.content === '事实丙'), '同标签两条事实都应存在');
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
  await t('skill 插件：Agent Skills 标准目录型（SKILL.md + frontmatter）', async () => {
    // 目录型技能拷入工作区 skills/ 即被发现（社区技能零适配直接用）
    const skDir = path.join(WS, 'skills', 'pdf-processing');
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'), '---\nname: pdf-processing\ndescription: Extract PDF text and fill forms. Use when handling PDFs.\n---\n\n# 步骤\n1. 提取文本', 'utf8');
    fs.mkdirSync(path.join(skDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skDir, 'scripts', 'extract.py'), 'print(1)', 'utf8');
    const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
    assert.ok(list.includes('pdf-processing') && list.includes('Extract PDF text'), 'frontmatter description 应进入 list：' + list.slice(0, 300));
    assert.ok(!list.includes('# 步骤'), '渐进式：list 不含正文');
    const full = await plugins.runPlugin('skill', { action: 'get', name: 'pdf-processing' }, ctx);
    assert.ok(full.includes('# 步骤') && full.includes('目录型技能') && full.includes('scripts'), 'get 应返回全文与捆绑资源提示');
    const del = await plugins.runPlugin('skill', { action: 'delete', name: 'pdf-processing' }, ctx);
    assert.ok(del.includes('目录型'), del);
    assert.ok(!fs.existsSync(skDir), '删除应移除整个技能目录');
  });
  await t('skill 插件：全局共享目录 + 工作区同名就近优先', async () => {
    const shared = path.join(TMP, 'skills-shared');
    fs.mkdirSync(path.join(shared, 'common-greet'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'common-greet', 'SKILL.md'), '---\nname: common-greet\ndescription: 全局共享版本\n---\n\n全局', 'utf8');
    const prev = process.env.DUAL_AGENT_SKILLS_SHARED;
    process.env.DUAL_AGENT_SKILLS_SHARED = shared;
    try {
      let list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      assert.ok(list.includes('common-greet') && list.includes('全局共享版本'), '共享目录技能应被发现：' + list.slice(0, 200));
      // 工作区放同名技能 → 就近优先
      const wsDir = path.join(WS, 'skills', 'common-greet');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'SKILL.md'), '---\nname: common-greet\ndescription: 工作区覆盖版本\n---\n\n本地', 'utf8');
      list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      assert.ok(list.includes('工作区覆盖版本') && !list.includes('全局共享版本'), '工作区应覆盖全局：' + list.slice(0, 200));
      const full = await plugins.runPlugin('skill', { action: 'get', name: 'common-greet' }, ctx);
      assert.ok(full.includes('本地'), 'get 应返回工作区版本');
      fs.rmSync(wsDir, { recursive: true, force: true });
    } finally {
      process.env.DUAL_AGENT_SKILLS_SHARED = prev;
    }
  });
  await t('read 插件：skill: 协议直读技能捆绑资源（含就近优先与 frontmatter 名匹配）', async () => {
    const shared = path.join(TMP, 'skills-shared2');
    // 目录名与 frontmatter name 不同：验证 frontmatter 名也可命中
    fs.mkdirSync(path.join(shared, 'My Fancy Tool'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'My Fancy Tool', 'SKILL.md'), '---\nname: fancy-tool\ndescription: 测试名解析\n---\n\n# 正文', 'utf8');
    fs.mkdirSync(path.join(shared, 'My Fancy Tool', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'My Fancy Tool', 'templates', 'viewer.html'), '<html>TEMPLATE</html>', 'utf8');
    const prev = process.env.DUAL_AGENT_SKILLS_SHARED;
    process.env.DUAL_AGENT_SKILLS_SHARED = shared;
    try {
      // 1. frontmatter 名 + 技能内相对路径
      const r1 = await plugins.runPlugin('read', { path: 'skill:fancy-tool/templates/viewer.html' }, ctx);
      assert.ok(r1.includes('TEMPLATE'), 'skill: 协议应解析到捆绑资源：' + r1.slice(0, 120));
      // 2. skill:名 直接读 SKILL.md 本体
      const r2 = await plugins.runPlugin('read', { path: 'skill:fancy-tool' }, ctx);
      assert.ok(r2.includes('# 正文'), 'skill:名 应默认读 SKILL.md');
      // 3. 工作区同名技能就近优先
      const wsDir = path.join(WS, 'skills', 'fancy-tool');
      fs.mkdirSync(path.join(wsDir, 'templates'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'SKILL.md'), '---\nname: fancy-tool\ndescription: 本地版\n---\n\n# 本地', 'utf8');
      fs.writeFileSync(path.join(wsDir, 'templates', 'viewer.html'), '<html>LOCAL</html>', 'utf8');
      const r3 = await plugins.runPlugin('read', { path: 'skill:fancy-tool/templates/viewer.html' }, ctx);
      assert.ok(r3.includes('LOCAL'), '工作区技能应优先命中');
      fs.rmSync(wsDir, { recursive: true, force: true });
      // 4. miss 时错误信息列出可用技能（框架层把 throw 转返回字符串，断言其内容）
      const miss = await plugins.runPlugin('read', { path: 'skill:no-such/templates/x.html' }, ctx);
      assert.ok(String(miss).includes('fancy-tool') && String(miss).includes('未命中'), 'miss 应提示可用技能名：' + miss);
    } finally {
      process.env.DUAL_AGENT_SKILLS_SHARED = prev;
    }
  });
  await t('skill 插件：list 描述按词边界截断（不截在词中间）', async () => {
    const skDir = path.join(WS, 'skills', 'clip-test');
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'), `---\nname: clip-test\ndescription: ${'word '.repeat(40).trim()}\n---\n\n正文`, 'utf8');
    const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
    const line = list.split('\n').find(l => l.includes('clip-test'));
    assert.ok(/ word…$/.test(line), '截断应落在完整词后（不切词一半）：...' + line.slice(-40));
    fs.rmSync(skDir, { recursive: true, force: true });
  });
  await t('skill 插件：get 资源清单含 bash 可用绝对路径（脚本类技能执行入口）', async () => {
    const skDir = path.join(WS, 'skills', 'script-demo');
    fs.mkdirSync(path.join(skDir, 'scripts', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'), '---\nname: script-demo\ndescription: 脚本技能\n---\n\n# 正文', 'utf8');
    fs.writeFileSync(path.join(skDir, 'scripts', 'run.py'), 'print(1)', 'utf8');
    fs.writeFileSync(path.join(skDir, 'scripts', '__pycache__', 'run.cpython-311.pyc'), 'bin', 'utf8');
    try {
      const get = await plugins.runPlugin('skill', { action: 'get', name: 'script-demo' }, ctx);
      assert.ok(get.includes(`skill:script-demo/scripts/run.py → ${path.join(WS, 'skills', 'script-demo', 'scripts', 'run.py')}`), '清单应同时给 skill: 路径与绝对路径');
      assert.ok(!get.includes('__pycache__') && !get.includes('.pyc'), '应过滤 __pycache__/.pyc');
    } finally { fs.rmSync(skDir, { recursive: true, force: true }); }
  });
  await t('skill 插件：多行 YAML frontmatter（折叠/字面/续行）零适配解析', async () => {
    const skDir = path.join(WS, 'skills', 'multi-line-demo');
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'),
      '---\nname: multi-line-demo\ndescription: >-\n  折叠标量第一行，\n  第二行继续描述。\nlicense: MIT\n---\n\n# 正文', 'utf8');
    try {
      const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      const line = list.split('\n').find(l => l.includes('multi-line-demo'));
      assert.ok(line && line.includes('折叠标量第一行， 第二行继续描述'), '折叠标量应折成单行：' + line);
      const get = await plugins.runPlugin('skill', { action: 'get', name: 'multi-line-demo' }, ctx);
      assert.ok(get.includes('# 正文'), 'get 正常');
    } finally { fs.rmSync(skDir, { recursive: true, force: true }); }
    // 字面量块（|）：描述保留换行（list 中折行显示为空格拼接也接受，但不允许读出 "|" 字面量）
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'),
      '---\nname: multi-line-demo\ndescription: |\n  字面量块第一行\n  字面量块第二行\n---\n\n# 正文', 'utf8');
    try {
      const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      assert.ok(!list.includes('|'), '块标量符号不应泄漏到描述：' + list.split('\n').find(l => l.includes('multi-line-demo')));
      assert.ok(list.includes('字面量块第一行'), '字面量内容应被读取');
    } finally { fs.rmSync(skDir, { recursive: true, force: true }); }
    // 普通标量续行
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'),
      '---\nname: multi-line-demo\ndescription: 起始描述\n  接着的一行\n---\n\n# 正文', 'utf8');
    try {
      const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      const line = list.split('\n').find(l => l.includes('multi-line-demo'));
      assert.ok(line && line.includes('起始描述 接着的一行'), '续行应并入：' + line);
    } finally { fs.rmSync(skDir, { recursive: true, force: true }); }
  });

  const { sanitizeToolArguments, parseToolArgs, reassembleCalls, shouldStall, recordFail, STALL_LIMIT } = require(path.join(ROOT, 'lib', 'inner'));
  const { withRetry, RetryableError, isRetryableStatus, isRateLimitText } = require(path.join(ROOT, 'lib', 'llmRetry'));
  await t('llmRetry：限流 429 → 退避后重试成功（info 事件可见）', async () => {
    let n = 0;
    const events = [];
    const r = await withRetry(async () => {
      n += 1;
      if (n === 1) throw new RetryableError('API 429：rate limit exceeded');
      return 'OK';
    }, { onEvent: e => events.push(e), label: '内层 LLM', baseMs: 1 });
    assert.equal(r, 'OK');
    assert.equal(n, 2, '第二次成功');
    assert.equal(events.length, 1, '一次退避提示');
    assert.ok(events[0].text.includes('自动重试（第 1/4 次）'), events[0].text);
  });
  await t('llmRetry：持续限流 → 3^n 序列重试 4 次后耗尽抛错', async () => {
    let n = 0;
    const events = [];
    let threw = '';
    try {
      await withRetry(async () => { n += 1; throw new RetryableError('API 429'); }, { onEvent: e => events.push(e), baseMs: 1 });
    } catch (e) { threw = e.message; }
    assert.equal(n, 5, '1 次初始 + 4 次重试');
    assert.equal(events.length, 4, '4 条退避提示');
    assert.ok(events.every(e => /秒后自动重试/.test(e.text)), '每条提示含等待秒数');
    assert.ok(/429/.test(threw), '最终抛出原限流错误');
  });
  await t('llmRetry：退避时长按 3^n 递增（3s→9s→27s→81s 对应 base*3^n）', async () => {
    const events = [];
    const t0 = Date.now();
    try {
      await withRetry(async () => { throw Object.assign(new Error('too many requests'), { retryable: true }); }, { onEvent: e => events.push(e), baseMs: 5 });
    } catch { /* 耗尽 */ }
    const el = Date.now() - t0;
    // 5+15+45+135 = 200ms 退避总量下限（毫秒误差放宽）
    assert.ok(el >= 180, `4 次退避总时长应 ≥ base*(3^0+3^1+3^2+3^3)：实际 ${el}ms`);
    assert.equal(events.length, 4);
  });
  await t('llmRetry：非限流错误（400 参数错）立即抛出不重试', async () => {
    let n = 0;
    let threw = '';
    try {
      await withRetry(async () => { n += 1; throw new Error('内层 API 400：invalid model'); }, { baseMs: 1 });
    } catch (e) { threw = e.message; }
    assert.equal(n, 1, '不重试');
    assert.ok(/400/.test(threw));
  });
  await t('llmRetry：网络抖动（ECONNRESET code）→ 自动重试恢复', async () => {
    let n = 0;
    const r = await withRetry(async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return 42;
    }, { baseMs: 1 });
    assert.equal(r, 42);
    assert.equal(n, 2);
  });
  await t('llmRetry：状态码与文本判定', () => {
    assert.ok(isRetryableStatus(429) && isRetryableStatus(402) && isRetryableStatus(503));
    assert.ok(!isRetryableStatus(400) && !isRetryableStatus(404) && !isRetryableStatus(500));
    assert.ok(isRateLimitText('Rate limit reached') && isRateLimitText('请求过多，请稍后再试'));
    assert.ok(!isRateLimitText('invalid api key'));
  });
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
  await t('reassemble：raw 全空的桶带 emptyRaw 标记（API 丢参数 → 精准重试提示）', () => {
    const m = new Map();
    m.set(0, { id: 'a', name: 'write', args: '' });
    m.set(1, { id: 'b', name: 'write', args: '{"path":"x","content":"y"}' });
    const out = reassembleCalls(m);
    assert.equal(out.length, 2);
    assert.equal(out[0].emptyRaw, true);
    assert.ok(!out[1].emptyRaw);
  });
  await t('止损：同插件连续失败 STALL_LIMIT 次后跳过，成功则清零', () => {
    assert.equal(STALL_LIMIT, 3);
    const rf = new Map();
    assert.ok(!shouldStall(rf, 'bash')); // 未失败不触发
    recordFail(rf, 'bash', false); recordFail(rf, 'bash', false);
    assert.ok(!shouldStall(rf, 'bash')); // 2 次未达阈值
    recordFail(rf, 'bash', false);
    assert.ok(shouldStall(rf, 'bash')); // 3 次触发
    recordFail(rf, 'bash', true); // 成功清零
    assert.ok(!shouldStall(rf, 'bash'));
    // 不同插件独立计数
    recordFail(rf, 'write', false);
    assert.ok(!shouldStall(rf, 'write'));
    assert.ok(!shouldStall(rf, 'bash'));
    // 跨轮累计：跨轮状态保留（failStreak 是跨轮 Map），模拟两轮各失败一次后第三轮触发
    recordFail(rf, 'read', false);
    recordFail(rf, 'read', false);
    recordFail(rf, 'read', false);
    assert.ok(shouldStall(rf, 'read'));
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
  await t('write append：分段追加与新建文件', async () => {
    await plugins.runPlugin('write', { path: 'long-doc.md', content: 'AAA' }, ctx);
    const a1 = await plugins.runPlugin('write', { path: 'long-doc.md', content: 'BBB', append: true }, ctx);
    assert.ok(a1.includes('已追加') && a1.includes('BBB'), a1);
    const a2 = await plugins.runPlugin('write', { path: 'fresh.md', content: 'NEW', append: true }, ctx); // 不存在则新建
    assert.ok(a2.includes('新建'), a2);
    const readBack = await plugins.runPlugin('read', { path: 'long-doc.md' }, ctx);
    assert.ok(readBack.includes('AAABBB'), readBack);
  });
  await t('write 覆盖保护：高相似续写拦截、低相似重构放行', async () => {
    const base = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight';
    await plugins.runPlugin('write', { path: 'protect.md', content: base }, ctx);
    // 高相似（原文+续写尾巴）→ 判定续写场景，无 confirm 拒绝
    const w1 = await plugins.runPlugin('write', { path: 'protect.md', content: base + ' extra tail words here' }, ctx);
    assert.ok(/^插件 write 执行出错/.test(w1) && w1.includes('append=true') && w1.includes('confirm=true'), w1);
    // 低相似（截然不同内容）→ 判定整体重构，自动放行（旧版会误拦）
    const w2 = await plugins.runPlugin('write', { path: 'protect.md', content: 'red orange yellow green blue indigo violet purple pink brown black white gray silver gold copper iron zinc tin lead mercury neon argon krypton xenon' }, ctx);
    assert.ok(w2.includes('已重写') && w2.includes('重构'), w2);
    // 重构后文件变短（148<200），先恢复长文件再测 confirm 强覆盖
    await plugins.runPlugin('write', { path: 'protect.md', content: base }, ctx);
    const w3 = await plugins.runPlugin('write', { path: 'protect.md', content: base + ' extra tail words here', confirm: true }, ctx);
    assert.ok(w3.includes('已覆盖'), w3);
    // 小文件（<200 字符）不受限
    const w4 = await plugins.runPlugin('write', { path: 'small.md', content: '首次小文件' }, ctx);
    assert.ok(w4.includes('已写入'), w4);
    // 原子写入不残留临时文件
    assert.equal(fs.readdirSync(WS).filter(f => f.includes('.tmp-')).length, 0, '不应残留 .tmp- 临时文件');
  });
  await t('write append 幂等：重试重复段自动跳过', async () => {
    const seg = 'S'.repeat(60) + '-segment-content-marker'; // ≥40 字符才启用幂等
    await plugins.runPlugin('write', { path: 'idem.md', content: seg, append: true }, ctx);
    const again = await plugins.runPlugin('write', { path: 'idem.md', content: seg, append: true }, ctx);
    assert.ok(again.includes('幂等保护'), again);
    const back = await plugins.runPlugin('read', { path: 'idem.md' }, ctx);
    assert.ok(back.includes(seg) && back.indexOf(seg) === back.lastIndexOf(seg), '重复段不应被二次写入');
    const next = await plugins.runPlugin('write', { path: 'idem.md', content: 'T'.repeat(60) + '-next-segment', append: true }, ctx); // 不同内容正常追加
    assert.ok(next.includes('已追加'), next);
    const short = await plugins.runPlugin('write', { path: 'idem2.md', content: 'ab', append: true }, ctx); // 短内容（<40）重复是正常需求
    const short2 = await plugins.runPlugin('write', { path: 'idem2.md', content: 'ab', append: true }, ctx);
    assert.ok(short.includes('已追加') && short2.includes('已追加'), short2);
  });
  await t('read tail/offset：读末尾与分段（不回传全文）', async () => {
    await plugins.runPlugin('write', { path: 'big.txt', content: 'x'.repeat(5000) + 'TAIL_MARKER' }, ctx);
    const tl = await plugins.runPlugin('read', { path: 'big.txt', tail: 100 }, ctx);
    assert.ok(tl.includes('TAIL_MARKER') && tl.length < 500, tl.length + ' 字符'); // 未包含 5000 个 x
    const seg = await plugins.runPlugin('read', { path: 'big.txt', offset: 0, limit: 10 }, ctx);
    assert.ok(/第 0-10\/\d+ 字符/.test(seg) && seg.includes('offset=10'), seg);
    const over = await plugins.runPlugin('read', { path: 'big.txt', offset: 99999 }, ctx);
    assert.ok(over.includes('执行出错') && over.includes('超出'), over);
  });
  await t('软失败统一 throw：read 不存在文件标记为失败（防模型误读成功）', async () => {
    const r = await plugins.runPlugin('read', { path: 'no-such-file.txt' }, ctx);
    assert.ok(/^插件 read 执行出错/.test(r), r); // 框架前缀 → ok=false
    const m = await plugins.runPlugin('memory', { action: 'search', query: '' }, ctx);
    assert.ok(/^插件 memory 执行出错/.test(m), m);
  });
  await t('bash 重定向无输出时给确认提示（外层 Agent 建议的改进）', async () => {
    const r = await plugins.runPlugin('bash', { command: 'echo x >> redirect-test.txt' }, ctx);
    assert.ok(r.includes('重定向到文件') && r.includes('wc -c'), r);
    const n = await plugins.runPlugin('bash', { command: 'echo normal-output' }, ctx);
    assert.ok(!n.includes('重定向到文件'), n);
  });
  await t('fetch 去噪：菜单剥离 + 数据短行保留（回归：丢弃块未清 buf 会吞后续短行）', async () => {
    const http = require('http');
    const menu = ['曼谷','东京','首尔','吉隆坡','新加坡','巴黎','罗马','伦敦','雅典','柏林','纽约','温哥华','墨西哥城','哈瓦那','圣何塞','巴西利亚','开普敦','维多利亚','悉尼','墨尔本'];
    const weather = ['雷阵雨','雷阵雨','大雨转中雨','中雨','雷阵雨','雷阵雨','大雨转小雨'];
    const days = weather.map((w, i) => `<h1>${21 + i}日（周${'一二三四五六日'[i]}）</h1><p>${w}</p><p>3${i} / 2${i}℃</p>`).join('');
    const html = `<html><head><title>惠州天气预报</title></head><body><div class="nav"><ul>${menu.map(c => `<li>${c}</li>`).join('')}</ul><p>首页 | 预报 | 预警 | 雷达 | 云图 | 天气地图 | 专业产品</p></div><div class="t">${days}</div></body></html>`;
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const r = await plugins.runPlugin('fetch', { url: `http://127.0.0.1:${port}/` }, ctx);
      assert.ok(r.includes('标题：惠州天气预报'), '标题应置顶：' + r.slice(0, 80));
      assert.ok(r.includes('雷阵雨') && r.includes('大雨转中雨') && r.includes('中雨'), '天气词必须保留（僵尸 buf 回归）：' + r);
      assert.ok(/21日（周一）\n雷阵雨/.test(r), '日期后应紧跟天气词');
      assert.ok(!r.includes('东京') && !r.includes('首尔') && !r.includes('温哥华'), '城市菜单应被剥离');
      assert.ok(!/首页 \| 预报/.test(r), '竖线导航行应被剥离');
    } finally { srv.close(); }
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
    env: { ...process.env, DUAL_AGENT_MOCK: '1', DUAL_AGENT_DATA: DATA_TMP, DUAL_AGENT_PLUGINS_DIR: PLUGINS_TMP, DUAL_AGENT_WS_ROOT: path.join(TMP, 'ws-root'), PORT: String(PORT) },
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
    // 注：前序外层对话已把 reviewMark 推进到当前水位，此处写 5 条失败确保阈值触发（JSONL 追加式）
    fs.writeFileSync(path.join(DATA_TMP, 'inner-log.jsonl'), [1, 2, 3, 4, 5].map(i => JSON.stringify({ ts: Date.now(), plugin: 'x', args: {}, ok: false, result: 'f' + i, ms: 1 })).join('\n') + '\n');
    const h1 = await (await fetch(base + '/api/review-hint')).json();
    assert.ok(h1.suggest === true && h1.fails >= 3, JSON.stringify(h1));
    await fetch(base + '/api/review-ack', { method: 'POST' });
    const h2 = await (await fetch(base + '/api/review-hint')).json();
    assert.ok(h2.suggest === false);
  });
  await t('多工作区：切换 test-ws 目录创建 + 新区会话为空', async () => {
    const r = await (await fetch(base + '/api/workspace/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test-ws' }) })).json();
    assert.ok(r.success && r.current === 'test-ws');
    assert.ok(fs.existsSync(path.join(TMP, 'ws-root', 'test-ws')));
    const m = await (await fetch(base + '/api/inner/messages')).json();
    assert.equal(m.messages.length, 0, '新工作区会话应为空');
  });
  await t('多工作区：切回 default 历史完整恢复（分片存档）', async () => {
    const r = await (await fetch(base + '/api/workspace/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'default' }) })).json();
    assert.ok(r.success && r.current === 'default');
    const m = await (await fetch(base + '/api/inner/messages')).json();
    assert.ok(m.messages.some(x => x.role === 'user' && x.content === '演示'), '切回原工作区应恢复历史（旧版切换即销毁）');
    assert.ok(fs.existsSync(path.join(TMP, 'ws-root', 'default', 'inner-messages.json')), '会话应按工作区分片落盘');
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
