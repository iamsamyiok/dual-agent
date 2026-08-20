// @name code.analyze
// @desc 分析代码质量
// @essential false
const fs = require('fs');
const path = require('path');

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { 
        type: 'string', 
        description: '文件或目录路径'
      },
      metrics: { 
        type: 'array', 
        items: { type: 'string' },
        description: '分析的指标（cyclomatic-complexity/lines-of-code/maintainability）',
        default: ['lines-of-code']
      }
    },
    required: ['path']
  },
  
  run: async (args, ctx) => {
    const targetPath = path.resolve(ctx.cwd, String(args.path || ''));
    
    if (!fs.existsSync(targetPath)) {
      throw new Error(`路径不存在：${targetPath}`);
    }
    
    const stats = [];
    
    if (fs.statSync(targetPath).isDirectory()) {
      // 分析目录
      const files = fs.readdirSync(targetPath)
        .filter(f => f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.vue'))
        .map(f => path.join(targetPath, f));
      
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n').length;
        const chars = content.length;
        
        stats.push({
          file: file.replace(ctx.cwd + '/', ''),
          lines,
          chars,
          complexity: estimateComplexity(content)
        });
      }
    } else {
      // 分析文件
      const content = fs.readFileSync(targetPath, 'utf8');
      const lines = content.split('\n').length;
      
      stats.push({
        file: targetPath.replace(ctx.cwd + '/', ''),
        lines,
        chars: content.length,
        complexity: estimateComplexity(content)
      });
    }
    
    const report = stats.map(s => 
      `${s.file}: ${s.lines} 行, ${s.chars} 字符, 复杂度 ${s.complexity}`
    ).join('\n');
    
    return `代码分析结果：\n\n${report}`;
  }
};

function estimateComplexity(code) {
  // 简单的圈复杂度估算
  let complexity = 1;
  const patterns = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bcase\s+/g,
    /\?\s*/g,
    /\&\&/g,
    /\|\|/g
  ];
  
  for (const p of patterns) {
    const matches = code.match(p);
    if (matches) complexity += matches.length;
  }
  
  return complexity;
}
