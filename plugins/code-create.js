// @name code.create
// @desc 基于模板创建新文件
// @essential false
const fs = require('fs');
const path = require('path');

// 内置模板
const TEMPLATES = {
  'react-ts': `import React from 'react';

interface Props {
  children: React.ReactNode;
}

export const Component: React.FC<Props> = ({ children }) => {
  return <div>{children}</div>;
};`,

  'vue-ts': `<template>
  <div>{{ message }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const message = ref('Hello');
</script>

<style scoped>
div { color: #333; }
</style>`,

  'python': `def main():
    print("Hello, World!")

if __name__ == "__main__":
    main()`,

  'node': `const fs = require('fs');

function main() {
  console.log('Hello, World!');
}

main();`,

  'markdown': `# Title

## Section

Content here.`
};

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { 
        type: 'string', 
        description: '新文件路径'
      },
      template: { 
        type: 'string', 
        description: '模板类型（react-ts/vue-ts/python/node/markdown）或自定义内容',
        default: 'markdown'
      }
    },
    required: ['path', 'template']
  },
  
  run: async (args, ctx) => {
    const fp = path.resolve(ctx.cwd, String(args.path || ''));
    
    // 检查是否已存在
    if (fs.existsSync(fp)) {
      throw new Error(`文件已存在：${fp}`);
    }
    
    // 获取内容
    let content = '';
    if (TEMPLATES[args.template]) {
      content = TEMPLATES[args.template];
    } else {
      content = args.template;
    }
    
    // 创建文件
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
    
    return `已创建文件 ${fp}（${content.length} 字符）`;
  }
};
