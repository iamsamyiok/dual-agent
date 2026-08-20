// @name file.list
// @desc 列出目录内容
// @essential false
const fs = require('fs');
const path = require('path');

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { 
        type: 'string', 
        description: '目录路径，默认当前工作目录'
      },
      recursive: { 
        type: 'boolean', 
        description: '是否递归列出子目录',
        default: false
      },
      includeHidden: { 
        type: 'boolean', 
        description: '是否包含隐藏文件',
        default: false
      }
    },
    required: []
  },
  
  run: async (args, ctx) => {
    const dirPath = args.path 
      ? path.resolve(ctx.cwd, args.path) 
      : ctx.cwd;
    
    if (!fs.existsSync(dirPath)) {
      throw new Error(`目录不存在：${dirPath}`);
    }
    
    if (!fs.statSync(dirPath).isDirectory()) {
      throw new Error(`${dirPath} 不是目录`);
    }
    
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];
    
    for (const entry of entries) {
      // 过滤隐藏文件
      if (!args.includeHidden && entry.name.startsWith('.')) {
        continue;
      }
      
      const fullPath = path.join(dirPath, entry.name);
      const stat = fs.statSync(fullPath);
      
      result.push({
        name: entry.name,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        modified: stat.mtimeMs
      });
    }
    
    // 递归列出
    if (args.recursive) {
      for (const entry of [...result].filter(e => e.type === 'directory')) {
        const subPath = path.join(dirPath, entry.name);
        const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
        
        for (const sub of subEntries) {
          if (!args.includeHidden && sub.name.startsWith('.')) continue;
          
          const subFull = path.join(subPath, sub.name);
          const subStat = fs.statSync(subFull);
          
          result.push({
            name: `${entry.name}/${sub.name}`,
            type: subStat.isDirectory() ? 'directory' : 'file',
            size: subStat.size,
            modified: subStat.mtimeMs
          });
        }
      }
    }
    
    return `目录内容（${result.length} 项）：\n${result.map(e => 
      `${e.type === 'directory' ? '📁' : '📄'} ${e.name}${e.type === 'file' ? ` (${e.size} bytes)` : ''}`
    ).join('\n')}`;
  }
};
