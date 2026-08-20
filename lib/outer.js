// 外层引擎：本机 opencode CLI 子进程 + 上下文单向注入 + 建议 JSON 解析
// DUAL_AGENT_MOCK=1 时走本地假输出（无 opencode 也能演示审批闭环）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DUAL_AGENT_DATA || path.join(__dirname, '..', '.data');

// ---------- 软约束系统提示词（无硬编码路径限制） ----------
const SYSTEM_PROMPT = [
  '你是「外层迭代 Agent」，负责观察内层 Agent 的运行日志与插件状态，提出插件改进建议。规则：',
  '1. 你只允许修改插件目录（plugins/）下的文件，绝不修改核心 runtime（server.js / lib/ / public/）。',
  '2. 你的任何修改建议只是建议：必须等待用户在审批栏批准后才会生效，绝不假设建议已生效。',
  '3. 建议必须以一个 ```json 代码块输出，格式（可批量）：',
  '   {"proposals":[{"action":"create|update|delete","plugin":"插件名(小写字母数字连字符)","code":"完整插件源码(create/update 必填)","reason":"修改理由"}]}',
  '4. 插件文件约定：文件头注释 // @name // @desc // @essential 提供元信息；module.exports = { params: JSONSchema, run: async (args, ctx) => string }（ctx.cwd 工作区目录、ctx.dataDir 数据目录）。插件分三类形态：工具类（无状态函数）、记忆类（跨会话状态存 ctx.dataDir）、技能类（markdown 方法论存 ctx.cwd）。',
  '5. 除建议代码块外，回复应简明说明你的观察与判断。没有值得修改的就直接说明，不输出 json 块。'
].join('\n');

// ---------- 单向上下文：插件清单 + 内层最近日志（不含内层对话原文） ----------
function buildContext(pluginList, innerLog) {
  const plugins = pluginList.map(p =>
    `- ${p.name} [${p.essential ? '基础' : '业务'}/${p.status === 'broken' ? '损坏' : p.status === 'loaded' ? '已加载' : '懒加载'}] ${p.desc || '（无描述）'}${p.err ? ` ⚠ ${p.err}` : ''}`
  ).join('\n');
  const logs = innerLog.slice(-40).map(l =>
    `[${new Date(l.ts).toISOString().slice(11, 19)}] ${l.plugin}(${JSON.stringify(l.args).slice(0, 120)}) → ${l.ok ? '成功' : '失败'} ${l.ms}ms：${String(l.result || '').slice(0, 100)}`
  ).join('\n') || '（内层暂无插件调用日志）';
  return `== 当前插件清单 ==\n${plugins}\n\n== 内层最近插件调用日志 ==\n${logs}`;
}

// ---------- opencode 子进程 ----------
// Windows 兼容（效仿 agents-chat findCli）：
// - npm 全局安装的 CLI 在 Windows 是 .cmd 垫片，且 where 可能先返回无扩展名的 bash 垫片
//   （文件存在但 Node spawn 直接执行报 ENOENT），须优先选 .exe/.cmd/.bat/.com 可执行垫片
// - .cmd/.bat 垫片必须 shell:true 启动（Node 18.20+ 禁止直接 spawn .cmd）
// - DUAL_AGENT_OPENCODE_CMD 可显式指定完整路径，优先级最高
const { exec } = require('child_process');

function detectOpencode() {
  return new Promise((resolve) => {
    const custom = process.env.DUAL_AGENT_OPENCODE_CMD;
    if (custom && fs.existsSync(custom)) {
      return resolve({ cmd: custom, shell: /\.(cmd|bat)$/i.test(custom) });
    }
    exec(process.platform === 'win32' ? 'where opencode' : 'which opencode', { timeout: 5000 }, (err, so) => {
      if (err) return resolve(null);
      const all = String(so || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(p => fs.existsSync(p));
      if (!all.length) return resolve(null);
      const winExe = all.find(p => /\.(exe|cmd|bat|com)$/i.test(p));
      const first = process.platform === 'win32' && winExe ? winExe : all[0];
      resolve({ cmd: first, shell: /\.(cmd|bat)$/i.test(first) });
    });
  });
}

// shell 模式下 child.kill 只能杀掉 shell 垫片，孙进程会残留，须杀整棵进程树
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', timeout: 10000 });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程可能已退出 */ }
}

// 运行外层：全量文本快照经 onEvent 下发，结束时解析建议 json
// sessionId 非空时以 `-s ses_xxx` 在同一 opencode 会话续聊（外层记得之前的对话）；
// 事件流中首个 sessionID 经 onEvent({type:'session'}) 回传，由调用方持久化供下次续聊
const OC_SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

function runOuterReal(runner, prompt, cwd, onEvent, sessionId) {
  return new Promise((resolve) => {
    const args = ['run', '--format', 'json'];
    if (sessionId && OC_SESSION_RE.test(sessionId)) args.push('-s', sessionId);
    if (process.env.DUAL_AGENT_AUTO_APPROVE !== '0') args.push('--auto');
    const child = spawn(runner.cmd, args, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: !!runner.shell, windowsHide: true,
      env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' } // 尽量让子进程输出 UTF-8
    });
    let closed = false;
    let seenSession = '';
    const finish = (error) => {
      if (closed) return;
      closed = true;
      resolve({ error, sessionId: seenSession });
    };
    const killer = setTimeout(() => { killTree(child); finish('执行超时（10 分钟）'); }, 10 * 60 * 1000);

    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();

    let buf = '';
    let full = ''; // 全量正文快照
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.sessionID && !seenSession && OC_SESSION_RE.test(String(ev.sessionID))) {
          seenSession = String(ev.sessionID);
          onEvent({ type: 'session', sessionId: seenSession });
        }
        if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string' && ev.part.text.trim()) {
          full = ev.part.text; // opencode text 事件为全量快照
          onEvent({ type: 'text', text: full });
        }
      }
    });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    child.on('error', (e) => { clearTimeout(killer); finish(`无法启动 opencode：${e.message}`); });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0 && !full) finish(`opencode 异常退出（码 ${code}）：${errBuf.slice(0, 400)}`);
      else finish('');
    });
  });
}

// ---------- 演示模式：固定建议输出 ----------
async function runOuterMock(cmd, prompt, cwd, onEvent) {
  const text = [
    '观察内层日志：write 插件只能整文件覆盖，写大文件效率低，建议新增一个追加写入插件 append。',
    '',
    '```json',
    JSON.stringify({
      proposals: [{
        action: 'create',
        plugin: 'append',
        code: [
          '// @name append',
          '// @desc 向文件末尾追加内容（文件不存在则创建）',
          '// @essential false',
          "const fs = require('fs');",
          "const path = require('path');",
          '',
          'module.exports = {',
          '  params: {',
          '    type: "object",',
          '    properties: {',
          '      path: { type: "string", description: "文件路径" },',
          '      content: { type: "string", description: "追加的内容" }',
          '    },',
          '    required: ["path", "content"]',
          '  },',
          '  run: async (args, ctx) => {',
          '    const fp = path.resolve(ctx.cwd, String(args.path || ""));',
          "    fs.mkdirSync(path.dirname(fp), { recursive: true });",
          '    fs.appendFileSync(fp, String(args.content ?? ""), "utf8");',
          '    return `已追加到 ${fp}`;',
          '  }',
          '};',
          ''
        ].join('\n'),
        reason: 'write 插件整文件覆盖的开销随文件增大；append 支持日志/流水类追加场景，减少内层 token 消耗'
      }]
    }),
    '```'
  ].join('\n');
  // 分片下发模拟流式
  for (let i = 0; i < text.length; i += 80) {
    onEvent({ type: 'text', text: text.slice(0, i + 80) });
    await new Promise(r => setTimeout(r, 30));
  }
  return { error: '', sessionId: '' };
}

// ---------- 建议 JSON 解析（```json 代码块 → proposals 数组） ----------
function parseProposals(text) {
  const out = [];
  const re = /```(?:json)?\s*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    let obj;
    try { obj = JSON.parse(m[1]); } catch { continue; }
    const list = Array.isArray(obj.proposals) ? obj.proposals : (obj.action ? [obj] : []);
    for (const p of list) {
      const action = ['create', 'update', 'delete'].includes(p.action) ? p.action : null;
      if (!action || !p.plugin) continue;
      out.push({
        action,
        plugin: String(p.plugin).trim(),
        code: String(p.code ?? ''),
        reason: String(p.reason ?? '').slice(0, 500)
      });
    }
  }
  return out;
}

module.exports = { SYSTEM_PROMPT, buildContext, detectOpencode, runOuter: (process.env.DUAL_AGENT_MOCK === '1' ? runOuterMock : runOuterReal), parseProposals };
