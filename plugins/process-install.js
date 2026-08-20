// @name process.install
// @desc 安装项目依赖包
// @essential false
const { exec } = require('child_process');

module.exports = {
  params: {
    type: 'object',
    properties: {
      package: { 
        type: 'string', 
        description: '包名（如 react、express）'
      },
      manager: { 
        type: 'string', 
        description: '包管理器（npm/yarn/pnpm/pip/go）',
        default: 'npm'
      },
      dev: { 
        type: 'boolean', 
        description: '是否作为开发依赖',
        default: false
      },
      global: { 
        type: 'boolean', 
        description: '是否全局安装',
        default: false
      }
    },
    required: ['package']
  },
  
  run: async (args, ctx) => {
    const pkg = String(args.package || '');
    if (!pkg) {
      throw new Error('包名不能为空');
    }
    
    const manager = args.manager || 'npm';
    const devFlag = args.dev ? (manager === 'npm' ? '-D' : manager === 'pip' ? '--editable' : '--dev') : '';
    const globalFlag = args.global ? '-g' : '';
    
    let installCmd = '';
    switch (manager) {
      case 'npm':
        installCmd = `npm install ${globalFlag} ${devFlag} ${pkg}`;
        break;
      case 'yarn':
        installCmd = `yarn add ${globalFlag} ${devFlag} ${pkg}`;
        break;
      case 'pnpm':
        installCmd = `pnpm add ${globalFlag} ${devFlag} ${pkg}`;
        break;
      case 'pip':
        installCmd = `pip install ${globalFlag ? '--break-system-packages ' : ''}${pkg}`;
        break;
      case 'go':
        installCmd = `go get ${pkg}`;
        break;
      default:
        throw new Error(`不支持的包管理器：${manager}`);
    }
    
    return new Promise((resolve) => {
      exec(installCmd, {
        cwd: ctx.cwd,
        timeout: 60000,
        maxBuffer: 512 * 1024,
        encoding: 'utf8'
      }, (err, stdout, stderr) => {
        if (err) {
          resolve(`安装失败：${stderr || err.message}`);
        } else {
          resolve(`安装成功：${pkg}\n输出：${stdout.slice(-500)}`);
        }
      });
    });
  }
};
