// @name memory
// @desc 三层记忆系统：session（会话）/ short（近期）/ long（长期），支持自动检索与手动管理
// @essential true
const fs = require('fs');
const path = require('path');

const MAX_SHORT = 20;
const MAX_LONG = 20;

function memFiles(ctx) {
  return {
    short: path.join(ctx.cwd, '.memory-short.json'),
    long: path.join(ctx.cwd, '.memory-long.json')
  };
}

function loadJSON(fp, fallback = []) {
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(d) ? d : fallback;
  } catch { return fallback; }
}

function saveJSON(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 1), 'utf8');
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'search', 'list', 'delete'],
        description: '操作类型'
      },
      level: {
        type: 'string',
        enum: ['session', 'short', 'long'],
        description: '记忆级别：session=会话级（不持久化）/ short=近期（任务摘要）/ long=长期（永久）'
      },
      content: { type: 'string', description: '记忆内容（save 时必填）' },
      query: { type: 'string', description: '检索关键词（search 时必填）' },
      id: { type: 'number', description: '删除时的条目 ID' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签（save 时可选）' }
    },
    required: ['action']
  },
  
  run: async (args, ctx) => {
    const files = memFiles(ctx);
    const action = args.action;
    const level = args.level || 'short';
    
    // ========== save ==========
    if (action === 'save') {
      const content = String(args.content || '').trim();
      if (!content) return 'content 为空';
      
      if (level === 'session') {
        // 会话级：不持久化，只返回提示
        return '会话级记忆由框架自动管理，无需手动保存';
      }
      
      // 去重检查：搜索是否已存在相似内容（前50字模糊匹配 + 关键标签）
      const checkContent = content.slice(0, 50);
      const checkLevel = level === 'long' ? 'long' : 'short';
      const existing = loadJSON(files[checkLevel], []).filter(m => {
        const existingContent = m.content.slice(0, 50);
        // 模糊匹配：检查是否包含相同关键词
        const checkWords = checkContent.split(/\s+/).filter(w => w.length > 2);
        if (checkWords.some(w => existingContent.includes(w))) return true;
        // 标签完全匹配
        const existingTags = new Set(m.tags || []);
        const newTags = new Set(args.tags || []);
        if (newTags.size > 0 && [...newTags].every(t => existingTags.has(t))) return true;
        return false;
      });
      if (existing.length > 0) {
        // 找到重复，返回现有ID
        return `记忆已存在（#${existing[0].id}），无需重复保存`;
      }
      
      // 新增：保存到长期记忆时，检查是否已有相同标签的记忆，合并而非重复
      if (level === 'long') {
        const longMem = loadJSON(files.long, []);
        const sameTagMem = longMem.filter(m => {
          const existingTags = new Set(m.tags || []);
          const newTags = new Set(args.tags || []);
          return newTags.some(t => existingTags.has(t)) && m.content !== content;
        });
        if (sameTagMem.length > 0) {
          // 更新现有记忆，而不是创建重复
          const toUpdate = sameTagMem[0];
          const arr = longMem.map(m => {
            if (m.id === toUpdate.id) {
              return { ...m, content: content.slice(0, 500), ts: Date.now() };
            }
            return m;
          });
          saveJSON(files.long, arr);
          return `已更新长期记忆 #${toUpdate.id}：${content.slice(0, 50)}...`;
        }
      }
      
      if (level === 'short') {
        const arr = loadJSON(files.short, []);
        const item = {
          id: arr.length + 1,
          ts: Date.now(),
          content: content.slice(0, 500),
          tags: (args.tags || []).slice(0, 3),
          taskId: args.taskId || null
        };
        arr.push(item);
        while (arr.length > MAX_SHORT) arr.shift();
        saveJSON(files.short, arr);
        return `已保存到近期记忆 #${item.id}：${content.slice(0, 50)}...`;
      }
      
      if (level === 'long') {
        const arr = loadJSON(files.long, []);
        const item = {
          id: arr.length + 1,
          ts: Date.now(),
          content: content.slice(0, 1000),
          tags: (args.tags || []).slice(0, 5),
          priority: args.priority || 'normal'
        };
        arr.push(item);
        while (arr.length > MAX_LONG) arr.shift();
        saveJSON(files.long, arr);
        return `已保存到长期记忆 #${item.id}：${content.slice(0, 50)}...`;
      }
    }
    
    // ========== search ==========
    if (action === 'search') {
      const query = String(args.query || '').trim();
      if (!query) return 'query 为空';
      
      const q = query.toLowerCase();
      const results = [];
      
      // 搜索近期记忆
      if (level === 'short' || level === 'all') {
        const arr = loadJSON(files.short, []);
        const hit = arr.filter(m =>
          m.content.toLowerCase().includes(q) ||
          (m.tags || []).some(t => t.toLowerCase().includes(q))
        );
        results.push(...hit.map(m => ({ level: 'short', ...m })));
      }
      
      // 搜索长期记忆
      if (level === 'long' || level === 'all') {
        const arr = loadJSON(files.long, []);
        const hit = arr.filter(m =>
          m.content.toLowerCase().includes(q) ||
          (m.tags || []).some(t => t.toLowerCase().includes(q))
        );
        results.push(...hit.map(m => ({ level: 'long', ...m })));
      }
      
      if (!results.length) {
        return `没有匹配「${query}」的记忆`;
      }
      
      const lines = results.slice(-5).reverse().map(m => {
        const tagStr = (m.tags || []).length ? ` [${m.tags.join(' ')}]` : '';
        return `#${m.id} [${m.level}]${tagStr} ${m.content}`;
      });
      return `匹配 ${results.length} 条（新→旧）：\n${lines.join('\n')}`;
    }
    
    // ========== list ==========
    if (action === 'list') {
      const short = loadJSON(files.short, []);
      const long = loadJSON(files.long, []);
      
      if (!short.length && !long.length) {
        return '记忆库为空';
      }
      
      const lines = [];
      if (short.length) {
        lines.push(`【近期记忆】共 ${short.length} 条：`);
        lines.push(...short.slice(-5).reverse().map(m => `  #${m.id} ${m.content.slice(0, 60)}`));
      }
      if (long.length) {
        lines.push(`【长期记忆】共 ${long.length} 条：`);
        lines.push(...long.slice(-5).reverse().map(m => `  #${m.id} [${m.priority}] ${m.content.slice(0, 60)}`));
      }
      return lines.join('\n');
    }
    
    // ========== delete ==========
    if (action === 'delete') {
      const id = Number(args.id);
      const target = level === 'long' ? files.long : files.short;
      const arr = loadJSON(target, []);
      const idx = arr.findIndex(m => m.id === id);
      if (idx < 0) return `#${id} 不存在`;
      arr.splice(idx, 1);
      saveJSON(target, arr);
      return `已删除 #${id}`;
    }
    
    return `未知操作：${action}（支持 save/search/list/delete）`;
  }
};
