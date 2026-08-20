// @name task-breakdown
// @desc 拆解复杂任务为子任务列表
// @essential false
module.exports = {
  params: {
    type: 'object',
    properties: {
      task: { 
        type: 'string', 
        description: '要拆解的复杂任务描述'
      },
      maxSteps: { 
        type: 'number', 
        description: '最大子任务数量',
        default: 10
      }
    },
    required: ['task']
  },
  
  run: async (args, ctx) => {
    const task = String(args.task || '').trim();
    if (!task) {
      throw new Error('任务描述不能为空');
    }
    
    // 简单规则拆解（实际应调用 LLM）
    const steps = [];
    
    // 检测常见任务模式
    if (task.includes('创建') || task.includes('生成')) {
      steps.push('分析需求，确定项目结构');
      steps.push('创建目录和基础文件');
      steps.push('实现核心功能');
      steps.push('编写测试用例');
      steps.push('验证并优化');
    } else if (task.includes('修复') || task.includes('debug')) {
      steps.push('复现问题，定位根因');
      steps.push('分析影响范围');
      steps.push('制定修复方案');
      steps.push('实施修复');
      steps.push('回归测试');
    } else if (task.includes('重构')) {
      steps.push('分析现有代码结构');
      steps.push('识别重构点');
      steps.push('制定重构计划');
      steps.push('分步实施重构');
      steps.push('验证功能不变');
    } else {
      steps.push('理解任务需求');
      steps.push('制定执行计划');
      steps.push('实施解决方案');
      steps.push('验证结果');
    }
    
    // 限制数量
    const limited = steps.slice(0, args.maxSteps);
    
    return `任务拆解结果：\n\n${limited.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  }
};
