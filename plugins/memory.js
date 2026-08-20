// @name memory
// @desc 内层 Agent 跨会话持久记忆：save 记录 / search 检索 / list 最近 / delete 删除（存于当前工作区 .memory.json，随工作区隔离）
// @essential true
const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 500; // 记忆条数上限（超出裁掉最旧的）

function memFile(ctx) {
  // 记忆属于跨会话状态且按工作区隔离：存当前工作区下的隐藏文件
  return path.join(ctx.cwd, '.memory.json');
}

function load(ctx) {
  try {
    const arr = JSON.parse(fs.readFileSync(memFile(ctx), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function save(ctx, arr) {
  const fp = memFile(ctx);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  while (arr.length > MAX_ITEMS) arr.shift(); // 环形裁剪
  fs.writeFileSync(fp, JSON.stringify(arr, null, 1), 'utf8');
}

function fmt(item) {
  const tags = (item.tags || []).length ? ` [${item.tags.join(' ')}]` : '';
  return `#${item.id} ${new Date(item.ts).toISOString().slice(0, 16).replace('T', ' ')}${tags}\n${item.content}`;
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'search', 'list', 'delete'], description: '操作：save 记录 / search 关键词检索 / list 最近条目 / delete 按 id 删除' },
      content: { type: 'string', description: 'save 时必填：要记住的事实/偏好/结论（一句话一条，具体明确）' },
      tags: { type: 'array', items: { type: 'string' }, description: 'save 可选：标签（便于检索）' },
      query: { type: 'string', description: 'search 时必填：关键词（匹配内容与标签）' },
      id: { type: 'number', description: 'delete 时必填：条目 id' }
    },
    required: ['action']
  },
  run: async (args, ctx) => {
    const arr = load(ctx);
    if (args.action === 'save') {
      const content = String(args.content || '').trim();
      if (!content) throw new Error('content 为空');
      const item = { id: (arr.length ? arr[arr.length - 1].id : 0) + 1, ts: Date.now(), content: content.slice(0, 2000), tags: (args.tags || []).map(String).slice(0, 8) };
      arr.push(item);
      save(ctx, arr);
      return `已记住 #${item.id}：${item.content.slice(0, 100)}`;
    }
    if (args.action === 'search') {
      const q = String(args.query || '').trim().toLowerCase();
      if (!q) throw new Error('query 为空');
      const hit = arr.filter(m => m.content.toLowerCase().includes(q) || (m.tags || []).some(t => String(t).toLowerCase().includes(q)));
      if (!hit.length) return `没有匹配「${args.query}」的记忆`;
      return `匹配 ${hit.length} 条（新→旧）：\n\n${hit.slice(-10).reverse().map(fmt).join('\n\n')}`;
    }
    if (args.action === 'list') {
      if (!arr.length) return '记忆为空';
      return `共 ${arr.length} 条，最近 10 条（新→旧）：\n\n${arr.slice(-10).reverse().map(fmt).join('\n\n')}`;
    }
    if (args.action === 'delete') {
      const id = Number(args.id);
      const i = arr.findIndex(m => m.id === id);
      if (i < 0) throw new Error(`#${id} 不存在`);
      arr.splice(i, 1);
      save(ctx, arr);
      return `已删除 #${id}`;
    }
    return `未知操作：${args.action}`;
  }
};
