#!/usr/bin/env node
// hwj 终端智能体 — dual-agent 内层 Agent 能力的终端封装（零依赖 TUI）
// 用法：node hwj/hwj.js [--ws <工作区>] [--script "消息"]（--script 为非交互批处理，e2e 用）
// 环境变量与网页版一致：DUAL_AGENT_MOCK=1 演示模式；DUAL_AGENT_DATA / DUAL_AGENT_WS_ROOT 测试隔离
const core = require('./core');
const commands = require('./commands');
const { createTui } = require('./tui');
const PKG = require('../package.json');

const args = process.argv.slice(2);
function argOf(flag) { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; }
const SCRIPT_MSG = argOf('--script');
const WS_ARG = argOf('--ws');
const INTERACTIVE = !SCRIPT_MSG && process.stdin.isTTY && process.stdout.isTTY;

const BANNER = [
  `hwj 终端智能体 v${PKG.version} — 双层 Agent 自迭代系统（内层引擎 + 21 插件）`,
  '输入任务直接执行；/help 查看命令；Ctrl+C 中断任务（空闲时双击退出）'
];

function quit(code) { process.exit(code); }

async function main() {
  core.getConfig(); // 触发目录创建
  const state = core.hwjState();
  const ws = WS_ARG || state.ws || 'default';
  const mode = state.mode || 'build';

  // ---------- 非交互批处理模式（e2e / 管道） ----------
  if (!INTERACTIVE) {
    if (!SCRIPT_MSG) {
      console.error('hwj 需要在终端（TTY）中交互运行；批量执行用 --script "消息"');
      quit(2);
    }
    const ui = createTui({ plain: true, ws, mode, version: PKG.version });
    const ctx = { ws, mode, ui, abort: () => false };
    ui.printUser(SCRIPT_MSG);
    ui.beginTask();
    try {
      const r = await core.runTask(SCRIPT_MSG, ctx);
      ui.endTask();
      if (r.ok && r.finalText) ui.printAssistant(r.finalText);
      else if (r.aborted) ui.printInfo('已中断');
      quit(0);
    } catch (e) {
      ui.endTask();
      ui.printError(String((e && e.message) || e));
      quit(1);
    }
    return;
  }

  // ---------- 交互 TUI 模式 ----------
  const ui = createTui({ ws, mode, version: PKG.version });
  let busy = false;          // 任务执行中
  let exiting = false;
  let abortFlag = false;     // SIGINT 置位，runTask 的 callPlugin 边界消费
  const queue = [];          // 执行中排队的消息（≤5，对齐 server 语义）
  const QUEUE_MAX = 5;

  const cfg0 = core.getConfig();
  const unconfigured = process.env.DUAL_AGENT_MOCK !== '1' && !(cfg0.inner.base_url && cfg0.inner.api_key && cfg0.inner.model);

  // 首启横幅 + 会话恢复摘要
  BANNER.forEach(l => ui.printPlain(l));
  if (unconfigured) ui.printInfo('内层 API 未配置——先运行 /config 完成配置（与网页版共享）');
  const restored = core.loadSession(ws);
  if (restored.corrupted) ui.printInfo('检测到损坏的会话文件，已备份为 .bak 并重开');
  else if (restored.length) ui.printInfo(`已恢复会话（${restored.length} 条消息，/history 查看，/reset 清空）`);
  ui.printPlain(`工作区：${ws} · 模式：${mode} · DUAL_AGENT_MOCK=${process.env.DUAL_AGENT_MOCK === '1' ? '1（演示）' : '0'}`);

  const taskCtx = () => ({ ws: core.hwjState().ws || 'default', mode: core.hwjState().mode || 'build', ui, abort: () => abortFlag });

  async function drainQueue() {
    while (queue.length && !busy && !exiting) {
      const msg = queue.shift();
      ui.setMeta({ queueN: queue.length });
      await submit(msg);
    }
  }

  async function submit(line) {
    const text = String(line || '').trim();
    if (!text) { ui.refreshPrompt(); return; }
    if (commands.isCommand(text)) {
      const r = await commands.runCommand(text, {
        ui, ws: core.hwjState().ws,
        onModeChange: m => ui.setMeta({ mode: m }),
        onWorkspaceChange: w => { ui.setMeta({ ws: w }); },
        onReset: () => {}
      });
      if (r === 'exit') { exiting = true; ui.printInfo('会话已保存，再见'); ui.close(); quit(0); return; }
      ui.refreshPrompt();
      return;
    }
    if (busy) {
      if (queue.length >= QUEUE_MAX) { ui.printError(`排队已达上限（${QUEUE_MAX} 条），请等当前任务完成`); ui.refreshPrompt(); return; }
      queue.push(text);
      ui.setMeta({ queueN: queue.length });
      ui.printInfo(`任务执行中，本消息已排队（第 ${queue.length} 位），完成后自动执行`);
      ui.refreshPrompt();
      return;
    }
    busy = true; abortFlag = false;
    ui.printUser(text);
    ui.beginTask();
    const ctx = taskCtx();
    try {
      const r = await core.runTask(text, ctx);
      ui.endTask();
      if (r.aborted) ui.printInfo('已中断（已完成轮次已保留，可直接继续对话）');
      else if (r.ok && r.finalText) ui.printAssistant(r.finalText);
    } catch (e) {
      ui.endTask();
      ui.printError(String((e && e.message) || e));
    } finally {
      busy = false; abortFlag = false;
      ui.setMeta({ busy: '', queueN: queue.length });
      if (!exiting) { drainQueue().catch(() => {}); ui.refreshPrompt(); }
    }
  }

  ui.setHandlers({
    onLine: line => { submit(line).catch(e => ui.printError(String(e && e.message || e))); },
    onSigint: count => {
      if (busy) {
        if (!abortFlag) { abortFlag = true; ui.printInfo('正在中断（等待当前工具调用边界，已完成轮次将保留）…'); }
        return;
      }
      if (count >= 2) { exiting = true; ui.printInfo('会话已保存，再见'); ui.close(); quit(0); }
      else ui.printInfo('再按一次 Ctrl+C 退出');
    }
  });

  ui.start();
  // 未配置时自动进入向导（配置完直接可用）
  if (unconfigured) {
    await commands.runCommand('/config', { ui, ws, onModeChange: () => {}, onWorkspaceChange: () => {}, onReset: () => {} });
    ui.printInfo('配置完成，现在输入任务开始（/help 查看命令）');
    ui.refreshPrompt();
  }
}

main().catch(e => { console.error('[hwj] 启动失败:', e && (e.stack || e.message) || e); quit(1); });
