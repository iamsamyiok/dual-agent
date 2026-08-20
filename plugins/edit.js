// @name edit
// @desc 精确替换文件内容（在文件中查找 oldText 并替换为 newText，可指定替换第几处）
// @essential true
const fs = require('fs');
const path = require('path');

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
      oldText: { type: 'string', description: '要查找的原文（精确匹配）' },
      newText: { type: 'string', description: '替换后的内容' },
      occurrence: { type: 'number', description: '替换第几处匹配（默认 1，-1 表示最后一处）' }
    },
    required: ['path', 'oldText', 'newText']
  },
  run: async (args, ctx) => {
    const fp = path.resolve(ctx.cwd, String(args.path || ''));
    const src = fs.readFileSync(fp, 'utf8');
    const oldText = String(args.oldText ?? '');
    const newText = String(args.newText ?? '');
    const occ = args.occurrence === undefined ? 1 : Number(args.occurrence);
    // 收集全部匹配位置
    const hits = [];
    let i = 0;
    while ((i = src.indexOf(oldText, i)) !== -1) { hits.push(i); i += oldText.length; }
    if (!hits.length) {
      // 必须以"执行出错"前缀回传（框架据此标记失败并计入评审统计）：
      // 曾发生模型把"未找到"误读为替换成功，连锁后续 edit 全部基于错误前提
      const brief = oldText.length > 60 ? oldText.slice(0, 60) + '…' : oldText;
      throw new Error(`在 ${fp} 中未找到要替换的原文（找了 ${JSON.stringify(brief)}）。` +
        `文件共 ${src.length} 字符。请先用 read 重新读取文件，从返回内容中逐字符精确复制 oldText（注意空格缩进与转义），再重试。`);
    }
    const idx = occ === -1 ? hits[hits.length - 1] : (hits[Math.max(0, occ - 1)] ?? hits[0]);
    const nth = hits.indexOf(idx) + 1;
    const out = src.slice(0, idx) + newText + src.slice(idx + oldText.length);
    fs.writeFileSync(fp, out, 'utf8');
    return `已替换 ${fp} 第 ${nth}/${hits.length} 处匹配，文件现 ${out.length} 字符`;
  }
};
