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
  try { fs.writeFileSync(fp, JSON.stringify(data, null, 1), 'utf8'); }
  catch (e) { console.error('[memory] 记忆落盘失败:', e && e.message || e); return false; }
  return true;
}

// 单调递增 id：seq 文件持久化计数器；兜底不低于现存最大 id（防手改/迁移回退）
// 旧版用 arr.length + 1，删除条目后 id 冲突会命中错条目
function allocId(file) {
  const seqFp = file + '.seq';
  let seq = 0;
  try { seq = Number(JSON.parse(fs.readFileSync(seqFp, 'utf8')).seq) || 0; } catch { /* 首次初始化 */ }
  const maxExisting = loadJSON(file, []).reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0);
  seq = Math.max(seq, maxExisting) + 1;
  try { fs.writeFileSync(seqFp, JSON.stringify({ seq }), 'utf8'); } catch (e) { console.error('[memory] id 计数器落盘失败:', e && e.message || e); }
  return seq;
}

// tags 归一化：模型偶发传字符串（"['a','b']" 或 "a,b"），统一转字符串数组
function normTags(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map(t => String(t).trim()).filter(Boolean);
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.map(t => String(t).trim()).filter(Boolean);
  } catch { /* 继续分隔解析 */ }
  return s.split(/[,;，；]\s*/).map(t => t.replace(/^['"\\[\\]]+|['"\\[\\]]+$/g, '').trim()).filter(Boolean);
}

// ---------- 检索：轻量 TF-IDF ----------
// 中英混合分词：英文按词、中文按 2-gram（零依赖，对短查询/短记忆召回远好于子串匹配）
function tokenize(s) {
  const out = [];
  const en = String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,30}/g) || [];
  out.push(...en);
  const zh = String(s || '').match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seg of zh) {
    for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
    if (seg.length === 2) out.push(seg); // 完整双字词去重无害
  }
  return out;
}

// 打分：query 词频 × IDF（记忆库维度）；命中数相同按 id 新→旧
function scoreMemory(queryTokens, m, idf) {
  const toks = tokenize(`${m.content} ${(m.tags || []).join(' ')}`);
  if (!toks.length) return 0;
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  let s = 0;
  for (const q of queryTokens) {
    const f = tf.get(q);
    if (f) s += (1 + Math.log(f)) * (idf.get(q) || 1.5); // 未见词给中性 IDF
  }
  return s;
}

function searchRanked(query, items) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return [];
  // IDF：在候选集中
  const df = new Map();
  for (const m of items) {
    const seen = new Set(tokenize(`${m.content} ${(m.tags || []).join(' ')}`));
    for (const t of seen) if (qTokens.includes(t)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + items.length / n));
  return items
    .map(m => ({ m, s: scoreMemory(qTokens, m, idf) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.m.id || 0) - (a.m.id || 0))
    .map(x => x.m);
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'search', 'list', 'delete', 'consolidate'],
        description: '操作类型；consolidate=整理：相似短期记忆归并为一条长期记忆（释放容量）'
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
    const tags = normTags(args.tags); // 字符串/数组归一化（模型常传字符串）
    
    // ========== save ==========
    if (action === 'save') {
      const content = String(args.content || '').trim();
      if (!content) throw new Error('content 为空'); // 软失败统一 throw → 框架标记 ok=false，防模型误读成功
      
      if (level === 'session') {
        // 会话级：不持久化，只返回提示
        return '会话级记忆由框架自动管理，无需手动保存';
      }
      
      // 去重检查：仅精确内容匹配视为重复（旧版关键词/标签模糊命中会把不同事实误判为已存在，静默丢数据）
      const checkLevel = level === 'long' ? 'long' : 'short';
      const existing = loadJSON(files[checkLevel], []).filter(m => m.content === content);
      if (existing.length > 0) {
        return `记忆已存在（#${existing[existing.length - 1].id}），内容完全相同，无需重复保存`;
      }

      // 同标签/相似记忆一律追加（旧版“同标签覆盖第一条”会静默覆盖不同事实）
      if (level === 'short') {
        const arr = loadJSON(files.short, []);
        const item = {
          id: allocId(files.short),
          ts: Date.now(),
          content: content.slice(0, 500),
          tags: tags.slice(0, 3),
          taskId: args.taskId || null
        };
        arr.push(item);
        while (arr.length > MAX_SHORT) arr.shift();
        if (!saveJSON(files.short, arr)) return '近期记忆保存失败：磁盘写入异常';
        return `已保存到近期记忆 #${item.id}：${content.slice(0, 50)}...`;
      }

      if (level === 'long') {
        const arr = loadJSON(files.long, []);
        const item = {
          id: allocId(files.long),
          ts: Date.now(),
          content: content.slice(0, 1000),
          tags: tags.slice(0, 5),
          priority: args.priority || 'normal'
        };
        arr.push(item);
        while (arr.length > MAX_LONG) arr.shift();
        if (!saveJSON(files.long, arr)) return '长期记忆保存失败：磁盘写入异常';
        return `已保存到长期记忆 #${item.id}：${content.slice(0, 50)}...`;
      }
    }
    
    // ========== search：TF-IDF 语义排序（中英混合分词，中文 2-gram；子串匹配升级） ==========
    if (action === 'search') {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query 为空'); // 软失败统一 throw → 框架标记 ok=false

      const pool = [];
      if (level === 'short' || level === 'all') {
        loadJSON(files.short, []).forEach(m => pool.push({ level: 'short', ...m }));
      }
      if (level === 'long' || level === 'all') {
        loadJSON(files.long, []).forEach(m => pool.push({ level: 'long', ...m }));
      }
      const ranked = searchRanked(query, pool);
      if (!ranked.length) {
        return `没有匹配「${query}」的记忆`;
      }
      const lines = ranked.slice(0, 5).map(m => {
        const tagStr = (m.tags || []).length ? ` [${m.tags.join(' ')}]` : '';
        return `#${m.id} [${m.level}]${tagStr} ${m.content}`;
      });
      return `匹配 ${ranked.length} 条（相关度排序）：\n${lines.join('\n')}`;
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
    
    // ========== consolidate：相似短期记忆归并 ==========
    // 病根：MAX_SHORT=20 滚动淘汰，同一任务的多条过程记忆会被新任务挤出且碎片化。
    // 归并策略：Jaccard 相似（分词集合）≥0.45 的短期记忆簇 → 合并为一条长期记忆
    //（保留全部原文要点与最新 id/ts），原条目从短期库移除释放容量
    if (action === 'consolidate') {
      const short = loadJSON(files.short, []);
      if (short.length < 2) return '近期记忆不足 2 条，无需归并';
      const long = loadJSON(files.long, []);
      const tokensOf = m => new Set(tokenize(`${m.content} ${(m.tags || []).join(' ')}`));
      const zhGram = s => new Set((String(s).match(/[\u4e00-\u9fff]{2}/g) || []));
      const asciiWord = s => new Set((String(s).toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || []));
      const jaccard = (a, b) => {
        if (!a.size || !b.size) return 0;
        let inter = 0;
        for (const t of a) if (b.has(t)) inter++;
        return inter / (a.size + b.size - inter);
      };
      // 同主题判定（双通道）：
      // 1) 2-gram Jaccard ≥ 0.3（表述相近的归并）
      // 2) 强信号：共同中文 2-gram ≥1 且共同 ASCII 词 ≥1（「任务weather：xxx」这类混排前缀主题）
      const sameTopic = (a, b) => {
        if (jaccard(tokensOf(a), tokensOf(b)) >= 0.3) return true;
        const za = zhGram(a.content), zb = zhGram(b.content);
        const aa = asciiWord(a.content), ab = asciiWord(b.content);
        let zhHit = false, enHit = false;
        for (const g of za) if (zb.has(g)) { zhHit = true; break; }
        for (const w of aa) if (ab.has(w)) { enHit = true; break; }
        return zhHit && enHit;
      };
      const clusters = [];
      const used = new Set();
      for (let i = 0; i < short.length; i++) {
        if (used.has(i)) continue;
        const cluster = [i];
        for (let j = i + 1; j < short.length; j++) {
          if (used.has(j)) continue;
          if (cluster.some(ci => sameTopic(short[ci], short[j]))) {
            cluster.push(j);
            used.add(j);
          }
        }
        used.add(i);
        if (cluster.length >= 2) clusters.push(cluster);
      }
      if (!clusters.length) return '未发现足够相似的短期记忆簇（阈值 0.3），无需归并';
      const mergedIds = [];
      const keep = short.filter((m, i) => !used.has(i) || !clusters.some(c => c.includes(i)));
      for (const cluster of clusters) {
        const items = cluster.map(i => short[i]).sort((a, b) => (a.id || 0) - (b.id || 0));
        const tags = [...new Set(items.flatMap(m => m.tags || []))].slice(0, 5);
        const topic = items[0].content.slice(0, 30);
        const merged = {
          id: allocId(files.long),
          ts: Date.now(),
          content: `【归并 ${items.length} 条】主题：${topic}\n${items.map(m => `- ${m.content}`).join('\n')}`.slice(0, 1000),
          tags: tags.length ? tags : ['归并'],
          priority: 'normal',
          mergedFrom: items.map(m => m.id),
        };
        long.push(merged);
        mergedIds.push(`#${merged.id} ← ${items.map(m => '#' + m.id).join(' + ')}`);
      }
      while (long.length > MAX_LONG) long.shift();
      saveJSON(files.short, keep);
      saveJSON(files.long, long);
      return `已归并 ${clusters.length} 簇（近期 ${short.length} → ${keep.length} 条）：\n${mergedIds.join('\n')}`;
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
