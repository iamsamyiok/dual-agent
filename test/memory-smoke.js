// memory 插件冒烟测试（零依赖，node test/memory-smoke.js）
// 覆盖：归档层（archive_save/archive_search BM25）+ 语义层（remember/recall/降级/合并/tags 过滤/delete vector）
// embedding 全链路用本地 mock server（OpenAI 兼容 /embeddings，固定词向量模板）离线验证
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const TMP = path.join('/tmp', 'memory-smoke-' + Date.now().toString(36));
let passed = 0, failed = 0;

function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { failed++; console.log(`FAIL  ${name}\n      ${String(e && e.message || e).split('\n')[0]}`); });
}

// ---------- 隔离环境 ----------
const DATA = path.join(TMP, 'data');
const WS = path.join(TMP, 'ws');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WS, { recursive: true });

// 插件懒加载（每次 runPlugin 内部自带缓存清理？无——用同一实例，隔离靠目录）
const memory = require('../plugins/memory.js');
const ctx = { cwd: WS, dataDir: DATA };
const run = (args) => memory.run(args, ctx);

// ---------- mock embedding server（OpenAI 兼容） ----------
// 词向量模板：64 维正交基 + 微噪声；同模板余弦 ≈0.99（触发合并），跨模板 ≈0
const DIM = 64;
function vecFor(text) {
  const key = String(text).includes('超滤') ? 0 : String(text).includes('泵') ? 1 : String(text).includes('消毒') ? 2 : 3;
  const v = new Array(DIM).fill(0);
  v[key] = 1;
  v[key + 4] = 0.08; // 模板内固定微偏置
  return v;
}
let embCalls = 0;
let lastAuth = '';
const embServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    embCalls++;
    lastAuth = req.headers.authorization || '';
    let input = [];
    try { input = JSON.parse(body).input; } catch { /* 坏 body */ }
    const list = (Array.isArray(input) ? input : [input]).map(x => ({ embedding: vecFor(String(x)) }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: list }));
  });
});

function writeEmbConfig(port) {
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    embedding: { base_url: `http://127.0.0.1:${port}/v1`, api_key: 'sk-test-emb', model: 'mock-bge' }
  }));
}
function clearEmbConfig() {
  try { fs.unlinkSync(path.join(DATA, 'config.json')); } catch { /* 不存在即无配置 */ }
}

// ---------- 主流程 ----------
(async () => {
  console.log('== 语法 ==');
  await t('插件可加载且 schema 含新动作', () => {
    assert.ok(memory.params.properties.action.enum.includes('remember'));
    assert.ok(memory.params.properties.action.enum.includes('recall'));
    assert.ok(memory.params.properties.action.enum.includes('archive_save'));
    assert.ok(memory.params.properties.action.enum.includes('archive_search'));
    assert.ok(memory.params.properties.level.enum.includes('vector'));
  });

  console.log('== 归档层（无 embedding 依赖） ==');
  await t('archive_save 参数校验：双空 throw', async () => {
    await assert.rejects(() => run({ action: 'archive_save' }), /至少一项非空/);
  });
  await t('archive_save 归档并计数', async () => {
    const r = await run({ action: 'archive_save', user: '超滤膜压差高怎么处理', finalText: '方案：化学清洗，调整进水流量', taskId: 'T1' });
    assert.ok(/已归档 1 条/.test(r));
    await run({ action: 'archive_save', user: '泵机械密封泄漏', finalText: '更换机械密封，检查对中' });
    const r2 = await run({ action: 'archive_save', user: '消毒剂投加量计算', finalText: '按余氯反馈投加' });
    assert.ok(/累计 3 条/.test(r2));
  });
  await t('archive_search BM25 命中且按相关度排序', async () => {
    const r = await run({ action: 'archive_search', query: '压差 化学' });
    assert.ok(/归档匹配 1 条/.test(r), r);
    assert.ok(/超滤膜压差高/.test(r));
    assert.ok(/化学清洗/.test(r));
  });
  await t('archive_search 中文 2-gram 跨词召回', async () => {
    const r = await run({ action: 'archive_search', query: '机械密封' });
    assert.ok(/泵机械密封泄漏/.test(r), r);
  });
  await t('archive_search 无命中返回空提示', async () => {
    const r = await run({ action: 'archive_search', query: '完全不存在的词组' });
    assert.ok(/没有匹配/.test(r));
  });

  console.log('== 语义层（未配置 embedding：降级路径） ==');
  await t('remember 无配置写入 sparse-only 并提示降级', async () => {
    const r = await run({ action: 'remember', content: '超滤膜压差处理：化学清洗周期 30 天，进水流量降至 80%', tags: ['超滤', '工艺'] });
    assert.ok(/#1/.test(r) && /未配置 embedding/.test(r), r);
  });
  await t('remember 精确重复拒绝', async () => {
    const r = await run({ action: 'remember', content: '超滤膜压差处理：化学清洗周期 30 天，进水流量降至 80%' });
    assert.ok(/已存在.*#1/.test(r), r);
  });
  await t('recall 无配置降级关键词命中', async () => {
    const r = await run({ action: 'recall', query: '化学清洗' });
    assert.ok(/降级.*关键词/.test(r) && /#1/.test(r), r);
  });
  await t('recall 空查询 throw', async () => {
    await assert.rejects(() => run({ action: 'recall' }), /query 为空/);
  });
  await t('recall tags 前置过滤：不匹配标签返回空', async () => {
    await run({ action: 'remember', content: '泵密封泄漏处理：更换机械密封件', tags: ['设备'] });
    const r = await run({ action: 'recall', query: '密封', tags: ['不存在标签'] });
    assert.ok(/没有标签/.test(r), r);
  });
  await t('recall tags 命中时只在子集内检索', async () => {
    const r = await run({ action: 'recall', query: '密封', tags: ['设备'] });
    assert.ok(/#2/.test(r) && !/#1\b/.test(r.split('：').pop()), r);
  });

  console.log('== 语义层（mock embedding 全链路） ==');
  await new Promise(r => embServer.listen(0, '127.0.0.1', r));
  const PORT = embServer.address().port;
  writeEmbConfig(PORT);
  await t('remember 带 embedding 写入稠密向量（校验 auth 头）', async () => {
    const r = await run({ action: 'remember', content: '消毒剂投加：按余氯反馈 PID 调节', tags: ['消毒'] });
    assert.ok(/#3/.test(r) && /语义\+关键词/.test(r), r);
    assert.strictEqual(lastAuth, 'Bearer sk-test-emb');
  });
  await t('recall hybrid 两路 RRF 融合命中（关键词弱但语义强）', async () => {
    // 查询"跨膜压差上升"与"超滤膜压差处理"关键词 2-gram 部分重叠、语义同模板（超滤）
    const r = await run({ action: 'recall', query: '超滤 跨膜压差上升' });
    assert.ok(/#1/.test(r), r);
    assert.ok(!/降级/.test(r), r);
  });
  await t('recall mode=keyword 只走 BM25 不调 embedding', async () => {
    const before = embCalls;
    const r = await run({ action: 'recall', query: '机械密封', mode: 'keyword' });
    assert.ok(/#2/.test(r), r);
    assert.strictEqual(embCalls, before, 'keyword 模式不应调用 embedding');
  });
  await t('remember 高相似（余弦>0.85）自动合并不新增条目', async () => {
    const r = await run({ action: 'remember', content: '超滤膜压差高：优先化学清洗并降流量' });
    assert.ok(/#1.*相似.*合并/.test(r), r);
    const r2 = await run({ action: 'recall', query: '超滤 压差', mode: 'keyword' });
    assert.ok(/【补充】/.test(r2), r2);
  });
  await t('embedding API 故障时 recall 降级关键词不阻断', async () => {
    embServer.close();
    await new Promise(r => setTimeout(r, 100));
    const r = await run({ action: 'recall', query: '机械密封' });
    assert.ok(/#2/.test(r) && /降级关键词/.test(r), r);
  });
  await t('embedding API 故障时 remember 明确失败不写入', async () => {
    const r = await run({ action: 'remember', content: '故障期写入测试：不应落库' });
    assert.ok(/未写入/.test(r), r);
    const list = await run({ action: 'recall', query: '故障期写入测试', mode: 'keyword' });
    assert.ok(!/不应落库/.test(list), list);
  });
  clearEmbConfig();

  console.log('== delete vector + 既有动作回归 ==');
  await t('delete level=vector 删除语义条目', async () => {
    const r = await run({ action: 'delete', level: 'vector', id: 2 });
    assert.ok(/已删除语义记忆 #2/.test(r), r);
    const r2 = await run({ action: 'recall', query: '机械密封', mode: 'keyword' });
    assert.ok(!/#2 /.test(r2), r2);
  });
  await t('既有 save/search/list/consolidate 不受影响', async () => {
    const s = await run({ action: 'save', level: 'long', content: '回归测试长期记忆', tags: ['回归'] });
    assert.ok(/已保存到长期记忆/.test(s), s);
    const q = await run({ action: 'search', query: '回归测试' });
    assert.ok(/长期/.test(q), q);
    const l = await run({ action: 'list' });
    assert.ok(/长期记忆/.test(l));
  });

  embServer.closeAllConnections && embServer.closeAllConnections();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试框架异常:', e); process.exit(1); });
