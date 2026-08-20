// @name bash
// @desc 执行 shell 块命令并返回输出（默认在工作目录执行，限时 30 秒）
// @essential true
const { exec } = require('child_process');

module.exports = {
  params: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令（shell 单条或 && 串联）' }
    },
    required: ['command']
  },
  run: async (args, ctx) => {
    let cmd = String(args.command || '');
    // Windows 控制台默认 GBK 编码，中文输出会乱码：先切 UTF-8 代码页再执行
    if (process.platform === 'win32') cmd = 'chcp 65001 >nul & ' + cmd;
    return await new Promise((resolve) => {
      exec(cmd, {
        cwd: ctx.cwd,
        timeout: 30000,
        maxBuffer: 512 * 1024,
        killSignal: 'SIGKILL',
        windowsHide: true,
        encoding: 'utf8'
      }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errOut = String(stderr || '').trim();
        const tail = (out + (out && errOut ? '\n' : '') + errOut).slice(-6000);
        if (err && err.killed) resolve(`命令超时被终止（30 秒）。部分输出：\n${tail}`);
        else if (err) resolve(`命令退出码 ${err.code ?? '?'}。输出：\n${tail || '（无输出）'}`);
        else resolve(`命令执行成功（退出码 0）。输出：\n${tail || '（无输出）'}`);
      });
    });
  }
};
