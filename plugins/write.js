// @name write
// @desc 写入文本文件（自动创建父目录；默认覆盖，append=true 追加到末尾——长文分段写入用）
// @essential true
const fs = require('fs');
const path = require('path');

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
      content: { type: 'string', description: '要写入的内容（append 模式下为要追加的片段）' },
      append: { type: 'boolean', description: 'true 时追加到文件末尾（文件不存在则创建），长文分段写入必须用此模式' },
      confirm: { type: 'boolean', description: '覆盖已有大段内容（≥200 字符）时的二次确认，传 true 才允许整体覆盖' }
    },
    required: ['path', 'content']
  },
  run: async (args, ctx) => {
    const fp = path.resolve(ctx.cwd, String(args.path || ''));
    // 软失败一律 throw：框架据此标记失败并计入评审统计
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) {
      throw new Error(`${fp} 是目录，请提供完整文件路径（需包含文件名，如 game.html）`);
    }
    const body = String(args.content ?? '');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    if (args.append === true) {
      const existed = fs.existsSync(fp);
      fs.appendFileSync(fp, body, 'utf8');
      const total = fs.statSync(fp).size;
      // 带回末尾摘要：模型无需再 read 就能衔接下一段
      const tail = body.length > 120 ? '…' + body.slice(-120) : body;
      return `已追加 ${body.length} 字符到 ${fp}${existed ? '' : '（新建）'}，文件现共 ${total} 字节。本次追加末尾：${JSON.stringify(tail)}`;
    }
    // 覆盖保护：目标已有实质内容且与本次不同时强警告（实测模型会忘记 append 语义导致前文静默丢失）
    if (fs.existsSync(fp)) {
      const old = fs.readFileSync(fp, 'utf8');
      if (old.length >= 200 && old !== body) {
        if (!args.confirm) {
          throw new Error(`拒绝覆盖：${fp} 已有 ${old.length} 字符内容，普通 write 会整体覆盖。` +
            `续写请用 append=true 重发本次内容（content 无需改动，加上 path 和 append:true 即可）；` +
            `确实要整体替换文件才加 confirm=true。`);
        }
        fs.writeFileSync(fp, body, 'utf8');
        return `已覆盖 ${fp}（原 ${old.length} 字符 → 新 ${body.length} 字符，confirm=true 已确认）`;
      }
    }
    fs.writeFileSync(fp, body, 'utf8');
    return `已写入 ${fp}（${body.length} 字符）`;
  }
};
