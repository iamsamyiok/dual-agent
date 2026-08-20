// @name skill
// @desc 内层 Agent 技能库：save 沉淀任务方法论 / list 列出 / get 取全文 / delete 删除（markdown 存于工作区 skills/）
// @essential true
const fs = require('fs');
const path = require('path');

// 技能名只允许小写字母/数字/连字符（防路径穿越，与插件名规则一致）
const NAME_RE = /^[a-z0-9-]{1,40}$/;

function skillDir(ctx) {
  return path.join(ctx.cwd, 'skills');
}

function skillFile(ctx, name) {
  return path.join(skillDir(ctx), `${name}.md`);
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'list', 'get', 'delete'], description: '操作：save 保存技能 / list 列出技能 / get 读取全文 / delete 删除' },
      name: { type: 'string', description: '技能名（小写字母/数字/连字符），save/get/delete 必填' },
      content: { type: 'string', description: 'save 必填：技能全文（markdown，首行一句话概述，其后分步骤写清做法与注意事项）' }
    },
    required: ['action']
  },
  run: async (args, ctx) => {
    if (args.action === 'list') {
      const dir = skillDir(ctx);
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { /* 目录不存在 */ }
      if (!files.length) return '技能库为空。完成任务后用 save 把可复用的方法沉淀下来';
      const lines = files.map(f => {
        let head = '';
        try { head = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')[0].replace(/^#+\s*/, ''); } catch { /* ignore */ }
        return `- ${f.replace(/\.md$/, '')}：${head.slice(0, 60)}`;
      });
      return `共 ${files.length} 个技能：\n${lines.join('\n')}`;
    }
    const name = String(args.name || '').trim();
    if (!NAME_RE.test(name)) throw new Error(`技能名不合法（限小写字母/数字/连字符）：${name || '(空)'}`);
    const fp = skillFile(ctx, name);
    if (args.action === 'save') {
      const content = String(args.content || '').trim();
      if (!content) throw new Error('content 为空');
      const existed = fs.existsSync(fp);
      fs.mkdirSync(skillDir(ctx), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
      return `${existed ? '已更新' : '已保存'}技能 ${name}（${content.length} 字符）`;
    }
    if (args.action === 'get') {
      if (!fs.existsSync(fp)) throw new Error(`技能 ${name} 不存在，可先 action=list 查看已有技能`);
      return fs.readFileSync(fp, 'utf8');
    }
    if (args.action === 'delete') {
      if (!fs.existsSync(fp)) throw new Error(`技能 ${name} 不存在`);
      fs.unlinkSync(fp);
      return `已删除技能 ${name}`;
    }
    throw new Error(`未知操作：${args.action}（支持 list/save/get/delete）`);
  }
};
