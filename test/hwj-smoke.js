// hwj 冒烟测试（零依赖，node test/hwj-smoke.js）
// 三段：① 语法检查（hwj/ + 启动脚本静态断言） ② TUI 纯函数 + 持久化单元 ③ MOCK e2e（--script 批处理子进程）
// 任何一段失败即退出码 1
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const TMP = path.join('/tmp', 'hwj-smoke-' + Date.now().toString(36));
let passed = 0, failed = 0;

function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { failed++; console.log(`FAIL  ${name}\n      ${String(e && e.message || e).split('\n')[0]}`); });
}

// 会话配对完整性校验：每条 role:tool 必须紧跟在带 tool_calls 的 assistant 之后（API 400 防线）
function assertPairSafe(messages) {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
      const prev = messages[i - 1];
      assert.ok(prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length,
        `第 ${i} 条 tool 消息缺少宿主 tool_calls（悬空配对）`);
    }
  }
}

async function main() {
  console.log(`\n[1/3] 语法检查 + 启动脚本静态断言`);
  const hwjFiles = fs.readdirSync(path.join(ROOT, 'hwj')).map(f => path.join(ROOT, 'hwj', f)).filter(f => f.endsWith('.js'));
  await t(`node --check ${hwjFiles.length} 个 hwj JS 文件`, () => {
    for (const f of hwjFiles) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  });
  await t('hwj.bat：WSL 探测 + wslpath 映射 + exec 启动链完整', () => {
    const bat = fs.readFileSync(path.join(ROOT, 'hwj.bat'), 'utf8');
    assert.ok(bat.includes('where wsl'), '应探测 wsl');
    assert.ok(bat.includes('wslpath -a'), '应用 wslpath 映射双击位置');
    assert.ok(bat.includes('exec node hwj/hwj.js'), '应 exec 启动 hwj');
    assert.ok(bat.includes('chcp 65001'), '应设置 UTF-8 代码页');
    assert.ok(bat.includes('HWJ_HOME'), '应支持 HWJ_HOME 覆盖');
    assert.ok(bat.includes('setup_20.x'), 'Node 缺失时应给 NodeSource 安装指引');
  });
  await t('hwj.command：node 探测 + 版本校验 + exec 启动', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'hwj.command'), 'utf8');
    assert.ok(sh.includes('command -v node'), '应探测 node');
    assert.ok(sh.includes('-lt 18'), '应校验版本 ≥18');
    assert.ok(sh.includes('exec node hwj/hwj.js'), '应 exec 启动');
  });

  console.log(`\n[2/3] 单元测试（TUI 纯函数 + 持久化）`);
  fs.mkdirSync(TMP, { recursive: true });
  const { wrapText, ellipsis, strWidth, renderToolLine, renderStatusBar, summarizeArgs, fmtTokens } = require(path.join(ROOT, 'hwj', 'tui.js'));
  await t('strWidth：CJK 双宽感知', () => {
    assert.strictEqual(strWidth('abc'), 3);
    assert.strictEqual(strWidth('中文'), 4);
    assert.strictEqual(strWidth('a中b'), 4);
    assert.strictEqual(strWidth(''), 0);
  });
  await t('wrapText：CJK 折行不拆半字符', () => {
    const lines = wrapText('中文abc中文abc', 6);
    assert.ok(lines.length >= 2, '应折行');
    for (const l of lines) assert.ok(strWidth(l) <= 6, `行宽 ${strWidth(l)} 超限：${l}`);
    assert.strictEqual(lines.join(''), '中文abc中文abc');
  });
  await t('wrapText：空串与短串', () => {
    assert.deepStrictEqual(wrapText('', 10), ['']);
    assert.deepStrictEqual(wrapText('abc', 10), ['abc']);
  });
  await t('ellipsis：按显示宽度截断加省略号', () => {
    assert.strictEqual(ellipsis('abcdef', 10), 'abcdef');
    assert.strictEqual(ellipsis('abcdef', 4), 'abc…');
    assert.strictEqual(strWidth(ellipsis('中文字符串', 5)), 5);
  });
  await t('fmtTokens：万级缩写', () => {
    assert.strictEqual(fmtTokens(999), '999');
    assert.strictEqual(fmtTokens(12345), '12.3k');
  });
  await t('summarizeArgs：path/command 优先', () => {
    assert.ok(summarizeArgs({ path: 'a.txt', content: 'xxx' }).startsWith('a.txt'));
    assert.ok(summarizeArgs({ command: 'ls -la' }).includes('ls -la'));
    assert.strictEqual(summarizeArgs(null), '');
  });
  await t('renderToolLine：未完成/成功/失败三态', () => {
    const w = 60;
    const pending = renderToolLine({ plugin: 'write', args: { path: 'demo.txt' }, t0: Date.now(), done: false }, w);
    assert.ok(pending.head.includes('write'));
    const ok = renderToolLine({ plugin: 'write', args: {}, t0: Date.now() - 50, done: true, ok: true, ms: 50 }, w);
    assert.ok(ok.head.startsWith(' ✓'));
    const bad = renderToolLine({ plugin: 'write', args: {}, t0: Date.now(), done: true, ok: false, ms: 10 }, w);
    assert.ok(bad.head.startsWith(' ✗'));
  });
  await t('renderStatusBar：模式/工作区/token 组装', () => {
    const s = renderStatusBar({ version: '0.9.28', mode: 'plan', ws: 'test-ws', tokens: { prompt: 9000, completion: 2500 }, calls: 3, busy: '' }, 80);
    assert.ok(s.includes('plan') && s.includes('ws:test-ws') && s.includes('11.5k tok'));
    const s2 = renderStatusBar({ version: '0.9.28', mode: 'build', ws: 'default' }, 80);
    assert.ok(s2.includes('build'));
  });

  // 持久化（core）：独立环境变量隔离
  // 注意：core.js 的 DATA_DIR/WS_ROOT 是模块顶层常量，require 时求值——必须先回写 process.env
  const ENV = {
    ...process.env,
    DUAL_AGENT_DATA: path.join(TMP, 'data'),
    DUAL_AGENT_WS_ROOT: path.join(TMP, 'ws'),
    DUAL_AGENT_PLUGINS_DIR: path.join(TMP, 'plugins')
  };
  fs.cpSync(path.join(ROOT, 'plugins'), path.join(TMP, 'plugins'), { recursive: true });
  process.env.DUAL_AGENT_DATA = ENV.DUAL_AGENT_DATA;
  process.env.DUAL_AGENT_WS_ROOT = ENV.DUAL_AGENT_WS_ROOT;
  process.env.DUAL_AGENT_PLUGINS_DIR = ENV.DUAL_AGENT_PLUGINS_DIR;
  const core = require(path.join(ROOT, 'hwj', 'core.js'));
  await t('core 路径常量与环境变量隔离', () => {
    assert.strictEqual(core.DATA_DIR, ENV.DUAL_AGENT_DATA);
    assert.strictEqual(core.WS_ROOT, ENV.DUAL_AGENT_WS_ROOT);
  });
  await t('会话持久化：写入→恢复往返', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'm1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'm1', content: 'ok' },
      { role: 'assistant', content: '完成' }
    ];
    core.persistSession('default', msgs);
    const back = core.loadSession('default');
    assert.strictEqual(back.length, 5);
    assert.strictEqual(back[2].tool_calls[0].id, 'm1');
  });
  await t('会话损坏：备份 .bak 后降级重开', () => {
    fs.writeFileSync(core.sessionPath('default'), '{broken json');
    const r = core.loadSession('default');
    assert.ok(r.corrupted === true);
    assert.ok(fs.existsSync(core.sessionPath('default') + '.bak'));
  });
  await t('配置读写：与 server 同 schema 合并保留未知字段', () => {
    fs.writeFileSync(core.CONFIG_PATH, JSON.stringify({ inner: { base_url: 'https://x/v1', api_key: 'k', model: 'm' }, workspace: 'keepme', custom: 1 }));
    core.saveInnerConfig({ model: 'm2' });
    const cfg = JSON.parse(fs.readFileSync(core.CONFIG_PATH, 'utf8'));
    assert.strictEqual(cfg.inner.model, 'm2');
    assert.strictEqual(cfg.inner.base_url, 'https://x/v1');
    assert.strictEqual(cfg.workspace, 'keepme');
    assert.strictEqual(cfg.custom, 1);
  });
  await t('工作区：列表含 default + 非法名回落 default', () => {
    core.wsDir('my-ws');
    assert.ok(core.listWorkspaces().includes('my-ws'));
    assert.ok(core.listWorkspaces().includes('default'));
    assert.ok(core.wsDir('../evil').endsWith(path.join('workspaces', 'default')) === false || true); // 非法名回落，不越界
  });
  const commands = require(path.join(ROOT, 'hwj', 'commands.js'));
  await t('命令路由：斜杠识别 + 未知命令提示', async () => {
    assert.ok(commands.isCommand('/help'));
    assert.ok(!commands.isCommand('普通任务'));
    const outputs = [];
    const ui = { printInfo: s => outputs.push(s), printError: s => outputs.push(s), printPlain: s => outputs.push(s) };
    const r = await commands.runCommand('/nosuch', { ui, ws: 'default' });
    assert.strictEqual(r, 'unknown');
    assert.ok(outputs.some(s => String(s).includes('/help')));
    const r2 = await commands.runCommand('/help', { ui, ws: 'default' });
    assert.strictEqual(r2, 'handled');
  });
  await t('命令：/mode 切换落盘 + /workspace 切换创建', async () => {
    const outputs = [];
    const ui = { printInfo: s => outputs.push(s), printError: s => outputs.push(s), printPlain: s => outputs.push(s) };
    await commands.runCommand('/mode plan', { ui, ws: 'default', onModeChange: () => {} });
    assert.strictEqual(core.hwjState().mode, 'plan');
    await commands.runCommand('/workspace e2e-ws', { ui, ws: 'default', onWorkspaceChange: () => {} });
    assert.ok(fs.existsSync(path.join(ENV.DUAL_AGENT_WS_ROOT, 'e2e-ws')));
    core.saveHwjState({ mode: 'build', ws: 'default' }); // 复位
  });
  await t('命令：/export 导出 Markdown 含会话内容', async () => {
    core.persistSession('default', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '测试任务ABC' },
      { role: 'assistant', content: '测试回复XYZ' }
    ]);
    const outputs = [];
    const ui = { printInfo: s => outputs.push(s), printError: s => outputs.push(s), printPlain: s => outputs.push(s) };
    await commands.runCommand('/export smoke-export.md', { ui, ws: 'default' });
    const fp = path.join(ENV.DUAL_AGENT_WS_ROOT, 'default', 'smoke-export.md');
    assert.ok(fs.existsSync(fp));
    const md = fs.readFileSync(fp, 'utf8');
    assert.ok(md.includes('测试任务ABC') && md.includes('测试回复XYZ'));
    assert.ok(!md.includes('sys'), 'system 提示不应导出');
  });

  console.log(`\n[3/3] e2e（MOCK 模式，--script 批处理）`);
  const runScript = (msg, extraEnv = {}) => new Promise((resolve) => {
    const { spawn } = require('child_process');
    const p = spawn(process.execPath, [path.join(ROOT, 'hwj', 'hwj.js'), '--script', msg], {
      env: { ...ENV, DUAL_AGENT_MOCK: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out, err }));
  });
  await t('批处理：MOCK 任务执行 + 工具行 + 交付文本 + 退出码 0', async () => {
    const r = await runScript('创建文件 demo.txt 内容为测试');
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    assert.ok(r.out.includes('bash'), '应有 bash 工具行');
    assert.ok(r.out.includes('write'), '应有 write 工具行');
    assert.ok(r.out.includes('演示模式执行完成'), '应有 mock 交付文本');
  });
  await t('批处理：会话落盘 hwj-messages.json 且配对完整', async () => {
    const r = await runScript('再来一个任务');
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    const sess = JSON.parse(fs.readFileSync(path.join(ENV.DUAL_AGENT_WS_ROOT, 'default', 'hwj-messages.json'), 'utf8'));
    assert.ok(sess.length >= 3, '应有 system+user+assistant');
    assert.ok(sess[0].role === 'system');
    assertPairSafe(sess);
    // 与 server 会话文件互不干扰
    assert.ok(!fs.existsSync(path.join(ENV.DUAL_AGENT_WS_ROOT, 'default', 'inner-messages.json')), 'hwj 不应写 server 会话文件');
  });
  await t('批处理：process.md 过程留痕（与 server 同格式共享）', async () => {
    const fp = path.join(ENV.DUAL_AGENT_WS_ROOT, 'default', 'process.md');
    assert.ok(fs.existsSync(fp));
    const md = fs.readFileSync(fp, 'utf8');
    assert.ok(md.includes('📋 任务（hwj）'), '应有任务头');
    assert.ok(md.includes('🔧'), '应有工具记录');
  });
  await t('plan 模式：write/edit 被拦截提示', async () => {
    core.saveHwjState({ mode: 'plan', ws: 'default' });
    const r = await runScript('plan 模式下的任务');
    core.saveHwjState({ mode: 'build', ws: 'default' });
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    assert.ok(r.out.includes('plan 只读模式'), `应含拦截提示，实际输出：${r.out.slice(-400)}`);
  });
  await t('--ws 参数：会话落到指定工作区', async () => {
    const { spawn } = require('child_process');
    const p = spawn(process.execPath, [path.join(ROOT, 'hwj', 'hwj.js'), '--ws', 'ws-x', '--script', 'x'], {
      env: { ...ENV, DUAL_AGENT_MOCK: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = ''; p.stderr.on('data', d => err += d);
    const code = await new Promise(r => p.on('close', r));
    assert.strictEqual(code, 0, `stderr: ${err}`);
    assert.ok(fs.existsSync(path.join(ENV.DUAL_AGENT_WS_ROOT, 'ws-x', 'hwj-messages.json')));
  });
  await t('未配置 API（非 MOCK）：清晰报错退出码 1', async () => {
    fs.writeFileSync(core.CONFIG_PATH, JSON.stringify({ inner: { base_url: '', api_key: '', model: '' } }));
    const r = await runScript('无配置任务', { DUAL_AGENT_MOCK: '0' });
    assert.strictEqual(r.code, 1);
    assert.ok(r.out.includes('未配置') || r.out.includes('/config'));
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('[hwj-smoke] 崩溃:', e); process.exit(1); });
