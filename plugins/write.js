// @name write
// @desc 写入文本文件（自动创建父目录，覆盖已有内容）
// @essential true
const fs = require('fs');
const path = require('path');

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
      content: { type: 'string', description: '完整文件内容' }
    },
    required: ['path', 'content']
  },
  run: async (args, ctx) => {
    const fp = path.resolve(ctx.cwd, String(args.path || ''));
    // 纵深防御：目标已存在且是目录（如 path 恰好指向工作区本身）时给明确提示
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) {
      return `写入失败：${fp} 是目录。请提供完整文件路径（需包含文件名，如 game.html）。`;
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, String(args.content ?? ''), 'utf8');
    return `已写入 ${fp}（${String(args.content ?? '').length} 字符）`;
  }
};
