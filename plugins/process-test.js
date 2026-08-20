// @name process.test
// @desc 运行项目测试
// @essential false
const { exec } = require('child_process');

module.exports = {
  params: {
    type: 'object',
    properties: {
      pattern: { 
        type: 'string', 
        description: '测试文件匹配模式（可选）'
      },
      coverage: { 
        type: 'boolean', 
        description: '是否生成覆盖率报告',
        default: false
      },
      watch: { 
        type: 'boolean', 
        description: '是否开启监视模式',
        default: false
      }
    },
    required: []
  },
  
  run: async (args, ctx) => {
    // 检测项目类型和测试框架
    let testCmd = '';
    
    // 检查 package.json
    const pkgPath = require('path').join(ctx.cwd, 'package.json');
    let pkg = {};
    try {
      pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf8'));
    } catch {}
    
    const scripts = pkg.scripts || {};
    const hasVitest = pkg.devDependencies?.vitest;
    const hasJest = pkg.devDependencies?.jest;
    const hasMocha = pkg.devDependencies?.mocha;
    
    if (scripts.test) {
      testCmd = `npm run test -- ${args.pattern || ''}`;
      if (args.coverage) testCmd += ' --coverage';
    } else if (hasVitest) {
      testCmd = `npx vitest${args.pattern ? ` ${args.pattern}` : ''}${args.coverage ? ' --coverage' : ''}${args.watch ? ' --watch' : ''}`;
    } else if (hasJest) {
      testCmd = `npx jest${args.pattern ? ` ${args.pattern}` : ''}${args.coverage ? ' --coverage' : ''}`;
    } else if (hasMocha) {
      testCmd = `npx mocha${args.pattern ? ` ${args.pattern}` : ''}`;
    } else {
      return '未检测到测试框架，请配置 package.json scripts.test';
    }
    
    return new Promise((resolve) => {
      exec(testCmd, {
        cwd: ctx.cwd,
        timeout: args.watch ? 0 : 120000,
        maxBuffer: 512 * 1024,
        encoding: 'utf8'
      }, (err, stdout, stderr) => {
        const output = stdout + stderr;
        if (err && !args.watch) {
          resolve(`测试失败（退出码 ${err.code}）：\n${output.slice(-2000)}`);
        } else {
          resolve(`测试完成：\n${output.slice(-2000)}`);
        }
      });
    });
  }
};
