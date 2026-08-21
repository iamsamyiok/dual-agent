// @name skill
// @desc 技能库（兼容 Agent Skills 开放标准）：list 列出（仅名称+描述，渐进式）/ get 读全文 / save 沉淀 / delete 删除。支持目录型 skills/<name>/SKILL.md 与单文件 skills/<name>.md，社区技能直接拷入即用
// @essential false
const fs = require('fs');
const path = require('path');

// 技能名支持中英文（单文件旧格式）
const NAME_RE = /^[a-zA-Z0-9\u4e00-\u9fa5-]{1,64}$/;
// Agent Skills 标准名（目录型）：小写字母/数字/连字符，无连续连字符
const STD_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// 技能搜索根：工作区 skills/ 优先，项目根 skills/ 全局共享（社区技能统一放这里，所有工作区可用）
// __dirname = <root>/plugins，故 .. 即项目根；DUAL_AGENT_SKILLS_SHARED 可覆盖（测试隔离）
function skillRoots(ctx) {
  const roots = [path.join(ctx.cwd, 'skills')];
  const shared = process.env.DUAL_AGENT_SKILLS_SHARED || path.join(__dirname, '..', 'skills');
  if (path.resolve(shared) !== path.resolve(roots[0])) roots.push(shared);
  return roots;
}

function toSlug(name) {
  return name.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .slice(0, 64);
}

// 解析 SKILL.md 的 YAML frontmatter（name/description 等简单键值；无需完整 YAML 实现）
// 兼容社区技能常见多行写法（Agent Skills 规范允许 YAML 折叠标量）：
// - 块标量 description: >- / > / | / |-（后续更缩进行为值）
// - 普通标量续行（下一行以空格开头则并入）
function parseFrontmatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const lines = m[1].split('\n');
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!kv) continue; // 列表项（- xxx）与嵌套结构不支持（本系统用不到）
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if (/^[>|][+-]?$/.test(val)) {
      // 块标量：收集比键更深缩进的连续行；首行缩进决定剥离量
      const keyIndent = line.length - line.replace(/^\s+/, '').length;
      const block = [];
      let blockIndent = -1;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) { block.push(''); j++; continue; }
        const ind = l.length - l.replace(/^\s+/, '').length;
        if (ind <= keyIndent) break;
        if (blockIndent < 0) blockIndent = ind;
        block.push(l.slice(Math.min(blockIndent, l.length)));
        j++;
      }
      i = j - 1;
      if (val.startsWith('>')) {
        // 折叠标量：换行折成空格（忽略 chomping 细节，本场景足够）
        val = block.join(' ').replace(/\s+/g, ' ').trim();
      } else {
        val = block.join('\n').replace(/\n+$/, ''); // 字面量：保留换行
      }
    } else if (val) {
      // 普通标量续行：后续更缩进行并入（YAML 多行 plain scalar）
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l || !/^\s+\S/.test(l)) break;
        val += ' ' + l.trim();
        j++;
      }
      i = j - 1;
    }
    fm[key] = val.replace(/^["']|["']$/g, '').trim();
  }
  return Object.keys(fm).length ? fm : null;
}

// 描述截断：优先在词/句边界断开并加省略号，避免截在词中间
function clipDesc(s, max = 160) {
  const str = String(s || '').trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf('、'));
  return (boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd() + '…';
}

// 扫描一个根下的全部技能：目录型（含 SKILL.md）+ 单文件型
// 返回 [{ name, desc, kind: 'dir'|'file', dir, entry }]；目录型 name 取 frontmatter.name（回退目录名）
function scanRoot(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      const entry = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(entry)) continue;
      let name = e.name;
      let desc = '';
      try {
        const text = fs.readFileSync(entry, 'utf8');
        const fm = parseFrontmatter(text);
        if (fm && fm.name && STD_NAME_RE.test(fm.name)) name = fm.name;
        if (fm && fm.description) desc = fm.description;
        if (!desc) desc = text.split('\n').find(l => l.trim() && !l.startsWith('---')).replace(/^#+\s*/, '').slice(0, 120);
      } catch { /* 读失败按目录名列出 */ }
      out.push({ name, desc: clipDesc(desc), kind: 'dir', dir, entry });
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const name = e.name.replace(/\.md$/, '');
      let head = '';
      try {
        const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
        const fm = parseFrontmatter(text); // 单文件也兼容 frontmatter（description 优先）
        head = (fm && fm.description) || text.split('\n').find(l => l.trim() && !l.startsWith('---')).replace(/^#+\s*/, '');
      } catch { /* ignore */ }
      out.push({ name, desc: clipDesc(head), kind: 'file', dir, entry: path.join(dir, e.name) });
    }
  }
  return out;
}

// 全根合并去重：先扫到者赢——roots[0] 是工作区，故工作区覆盖全局共享（同名技能就近优先）
function listAll(ctx) {
  const merged = new Map();
  for (const root of skillRoots(ctx)) {
    for (const s of scanRoot(root)) {
      const key = s.name;
      if (!merged.has(key)) merged.set(key, { ...s, root });
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function findBySlug(ctx, name) {
  const slug = toSlug(name);
  return listAll(ctx).find(s => s.name === name || s.name === slug);
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'save', 'delete'], description: '操作：list 列出（名称+描述）/ get 读全文 / save 保存 / delete 删除' },
      name: { type: 'string', description: '技能名（list/get/save/delete 用；get 传 list 返回中的名称）' },
      content: { type: 'string', description: 'save 必填：技能全文（markdown；建议 YAML frontmatter 含 name/description，首行一句话概述，其后分步骤写清做法与注意事项）' }
    },
    required: ['action']
  },

  run: async (args, ctx) => {
    const action = args.action;

    // ========== list：渐进式第一级——只给名称+描述（≈100 token/技能） ==========
    if (action === 'list') {
      const all = listAll(ctx);
      if (!all.length) {
        return '技能库为空。社区技能（Agent Skills 标准：含 SKILL.md 的目录）直接拷入 skills/ 或 <项目根>/skills/ 即可被识别；完成任务后也可用 save 沉淀自己的方法';
      }
      const lines = all.map(s => `- ${s.name}：${s.desc || '（无描述）'}${s.kind === 'dir' ? '' : ''}`);
      return `共 ${all.length} 个技能（get(name) 读全文后按其指引执行）：\n${lines.join('\n')}`;
    }

    const name = String(args.name || '').trim();
    if (!name) throw new Error('name 为空');
    const found = findBySlug(ctx, name);

    // ========== save：保存为单文件格式（工作区 skills/<slug>.md） ==========
    if (action === 'save') {
      const content = String(args.content || '').trim();
      if (!content) throw new Error('content 为空');
      if (!NAME_RE.test(name)) {
        throw new Error(`技能名不合法（限 1-64 位字母/数字/中文/连字符）：${name}`);
      }
      const slug = toSlug(name);
      const fp = path.join(ctx.cwd, 'skills', `${slug}.md`);
      const existed = fs.existsSync(fp);
      fs.mkdirSync(path.join(ctx.cwd, 'skills'), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
      return `${existed ? '已更新' : '已保存'}技能 ${name}（${content.length} 字符）`;
    }

    if (!found) {
      throw new Error(`技能 ${name} 不存在，可先 action=list 查看已有技能`);
    }

    // ========== get：渐进式第二级——载入全文（SKILL.md 或单文件） ==========
    if (action === 'get') {
      const text = fs.readFileSync(found.entry, 'utf8');
      let resDir = '';
      if (found.kind === 'dir') {
        // 框架自动扫描捆绑资源，生成可直接照抄的 skill: 路径清单（把"按正文引用读文件"变成具体行动项）
        // 每行同时给绝对路径：bash 执行脚本（python3/node/sh）时用 → 后的路径（bash 无法解析 skill: 协议）
        const skillDir = path.dirname(found.entry);
        const files = [];
        (function walk(dir, rel) {
          let entries = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name === 'SKILL.md' || e.name.startsWith('.') || e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
            const p2 = path.join(dir, e.name);
            const r2 = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(p2, r2);
            else files.push({ rel: r2, abs: p2, size: fs.statSync(p2).size });
          }
        })(skillDir, '');
        const list = files.map(f => `  - skill:${found.name}/${f.rel} → ${f.abs}（${f.size} 字节）`).join('\n');
        resDir = `【目录型技能】捆绑资源清单（read 用 skill: 前缀；bash 执行用 → 后的绝对路径；正文引用其中文件时必须先读再用，禁止跳过或凭空自造替代）：\n${list || '  （无捆绑文件）'}\n\n`;
      }
      return `${resDir}${text}`;
    }

    // ========== delete：单文件直接删；目录型整目录删（含捆绑资源） ==========
    if (action === 'delete') {
      if (found.kind === 'file') {
        fs.unlinkSync(found.entry);
        return `已删除技能 ${found.name}`;
      }
      fs.rmSync(path.dirname(found.entry), { recursive: true, force: true });
      return `已删除目录型技能 ${found.name}（含捆绑资源）`;
    }

    throw new Error(`未知操作：${action}（支持 list/get/save/delete）`);
  }
};
