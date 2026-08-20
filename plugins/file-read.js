// @name file-read
// @desc 读取文件完整内容
// @essential false
const fs = require('fs');
const path = require('path');

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { 
        type: 'string', 
        description: '文件路径（相对工作目录或绝对路径）'
      },
      encoding: { 
        type: 'string', 
        description: '文件编码，默认 utf8',
        default: 'utf8'
      }
    },
    required: ['path']
  },
  
  run: async (args, ctx) => {
    const fp = path.resolve(ctx.cwd, String(args.path || ''));
    
    if (!fs.existsSync(fp)) {
      throw new Error(`文件不存在：${fp}`);
    }
    
    if (fs.statSync(fp).isDirectory()) {
      throw new Error(`${fp} 是目录，请提供文件路径`);
    }
    
    const content = fs.readFileSync(fp, args.encoding || 'utf8');
    return `文件内容（${content.length} 字符）：\n${content}`;
  }
};
