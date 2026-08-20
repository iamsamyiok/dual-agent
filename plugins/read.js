// @name read
// @desc 读取文本文件内容（支持 offset/limit 分段与 tail 读末尾）
// @essential true
const fs = require('fs');
const path = require('path');

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
      offset: { type: 'number', description: '从第几个字符开始读（默认 0，配合 limit 分段读大文件）' },
      limit: { type: 'number', description: '最多读取的字符数（默认 8000）' },
      tail: { type: 'number', description: '只读文件末尾 N 个字符（查看追加位置/结尾时用，优先于 offset）' }
    },
    required: ['path']
  },
  run: async (args, ctx) => {
    const fp = path.resolve(ctx.cwd, String(args.path || ''));
    // 软失败一律 throw：框架据此标记失败并计入评审统计（返回字符串会被误读为成功）
    if (!fs.existsSync(fp)) throw new Error(`文件不存在：${fp}`);
    const st = fs.statSync(fp);
    if (st.isDirectory()) throw new Error(`${fp} 是目录，请提供具体文件路径（如 notes/todo.txt）`);
    if (st.size > 512 * 1024) throw new Error(`文件过大（${st.size} 字节），仅支持读取 512KB 以内的文本文件；大文件请用 offset/limit 分段读`);
    const content = fs.readFileSync(fp, 'utf8');
    const total = content.length;
    const lines = content.split('\n').length;
    if (args.tail !== undefined && args.tail !== null) {
      const n = Math.max(1, Math.min(Number(args.tail) || 2000, 32000));
      const start = Math.max(0, total - n);
      return `已读取 ${fp} 末尾 ${total - start}/${total} 字符（全文 ${total} 字符 ${lines} 行）：\n\n${content.slice(start)}`;
    }
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 8000), 32000));
    const slice = content.slice(offset, offset + limit);
    if (!slice) throw new Error(`offset ${offset} 超出文件长度（全文仅 ${total} 字符）`);
    const head = offset === 0 && slice.length === total
      ? `已读取 ${fp}（${total} 字符，${lines} 行）：\n\n`
      : `已读取 ${fp} 第 ${offset}-${offset + slice.length}/${total} 字符（未读完整，继续读用 offset=${offset + slice.length}）：\n\n`;
    return head + slice;
  }
};
