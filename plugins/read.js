// @name read
// @desc 读取文本文件内容（相对路径以工作目录为基准）
// @essential true
const fs = require('fs');
const path = require('path');

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' }
    },
    required: ['path']
  },
  run: async (args, ctx) => {
    const fp = path.resolve(ctx.cwd, String(args.path || ''));
    if (!fs.existsSync(fp)) return `读取失败：文件不存在 ${fp}`;
    const st = fs.statSync(fp);
    if (st.isDirectory()) return `读取失败：${fp} 是目录。请提供具体文件路径（如 notes/todo.txt）。`;
    if (st.size > 512 * 1024) return `文件过大（${st.size} 字节），仅支持读取 512KB 以内的文本文件`;
    const content = fs.readFileSync(fp, 'utf8');
    return `已读取 ${fp}（${st.size} 字节，${content.split('\n').length} 行）：\n\n${content}`;
  }
};
