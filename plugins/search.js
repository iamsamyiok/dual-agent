// @name search
// @desc 联网搜索并返回结果列表（标题+URL+摘要；免 key 多引擎自动降级，配 DUAL_AGENT_SEARCH_KEY 后优先走 Serper 正式接口）
// @essential false
// 设计参考 agent-reach 的免 key 哲学：无 key 时走公开通道（Bing → DuckDuckGo 自动降级），
// 有 key 时自动升级正式接口；本插件只负责"搜索"，打开网页用 fetch（职责正交）。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function decodeEnt(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } }) // 数字实体（&#174;=® 等）
    .replace(/\s+/g, ' ').trim();
}
async function httpGet(url, headers, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ac.signal, redirect: 'follow', headers });
    return { status: resp.status, body: await resp.text() };
  } finally { clearTimeout(timer); }
}

// ---------- 引擎 1：Serper（可选 key 升级通道；Google 官方结果质量最高） ----------
async function serperEngine(query, count) {
  const key = process.env.DUAL_AGENT_SEARCH_KEY;
  if (!key) return null; // 未配置 key：跳过，走免 key 通道
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const resp = await fetch('https://google.serper.dev/search', {
      method: 'POST', signal: ac.signal,
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: count, hl: 'zh-cn' })
    });
    if (!resp.ok) return null; // key 失效/配额尽：静默降级到免 key 通道
    const j = await resp.json();
    return (j.organic || []).slice(0, count).map(r => ({
      title: r.title, url: r.link, snippet: r.snippet || ''
    }));
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---------- 引擎 2：Bing 网页版（免 key，实测连通性最好） ----------
async function bingEngine(query, count) {
  const r = await httpGet(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.max(count, 10)}&setlang=zh-hans`,
    { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5' }, 12000);
  if (r.status !== 200) return null;
  const out = [];
  const blocks = r.body.split(/class="b_algo"/).slice(1);
  for (const b of blocks) {
    const m = b.match(/<h2[^>]*><a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m || /bing\.com|microsoft\.com\/bing/i.test(m[1])) continue;
    const sm = b.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      || b.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: decodeEnt(m[2]), url: m[1], snippet: decodeEnt(sm ? sm[1] : '') });
    if (out.length >= count) break;
  }
  return out.length ? out : null;
}

// ---------- 引擎 3：DuckDuckGo HTML 版（免 key 备用；部分地区网络不可达，失败自动跳过） ----------
async function ddgEngine(query, count) {
  const r = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { 'User-Agent': UA }, 10000);
  if (r.status !== 200) return null;
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(r.body))) {
    let url = m[1];
    const u = url.match(/[?&]uddg=([^&]+)/); // DDG 跳转链接解包真实 URL
    if (u) { try { url = decodeURIComponent(u[1]); } catch { /* 保留原样 */ } }
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ title: decodeEnt(m[2]), url, snippet: decodeEnt(m[3]) });
    if (out.length >= count) break;
  }
  return out.length ? out : null;
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（中英文均可）' },
      count: { type: 'number', description: '返回结果条数，默认 5（最大 10）' }
    },
    required: ['query']
  },
  run: async (args) => {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query 为空：请提供搜索关键词');
    const count = Math.min(10, Math.max(1, Number(args.count) || 5));
    // 引擎降级链：有 key 走 Serper（Google 结果）→ Bing 免 key → DDG 免 key
    const chain = [
      ['serper', serperEngine],
      ['bing', bingEngine],
      ['duckduckgo', ddgEngine]
    ];
    const errors = [];
    for (const [name, fn] of chain) {
      let results;
      try { results = await fn(query, count); }
      catch (e) { errors.push(`${name}: ${String((e && e.message) || e).slice(0, 80)}`); continue; }
      if (results && results.length) {
        const lines = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 150)}` : ''}`);
        return `搜索「${query}」via ${name}，${results.length} 条结果：\n\n${lines.join('\n\n')}\n\n需要看某个网页的完整内容时，用 fetch(url=...) 打开对应链接。`;
      }
    }
    throw new Error(`所有搜索引擎均不可用（${errors.join('；') || '网络出口受限'}）。` +
      `请稍后重试，或改用 fetch 直接抓取已知网址；本机可配置 DUAL_AGENT_SEARCH_KEY（serper.dev 免费 key）启用 Google 正式通道。`);
  }
};
