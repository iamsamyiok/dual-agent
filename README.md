# 双层 Agent 自迭代系统（dual-agent-loop）

轻量 demo：内层 Agent（OpenAI 兼容 API + 插件执行）+ 外层 Agent（本机 opencode CLI）自闭环。
外层根据内层日志与插件状态提出插件增删改建议，经底部审批栏批准后自动快照、应用、热加载。

## 快速开始

```bash
# 真实模式（需要：内层 OpenAI 兼容 API + 本机 opencode）
node server.js
# 浏览器打开 http://localhost:3788，右上角「配置」填内层 API

# 演示模式（无需任何 API，体验完整审批闭环）
DUAL_AGENT_MOCK=1 node server.js
```

## 界面

- 左侧：插件管理（基础/业务分组、加载状态、手动增删改——同样自动快照可回滚）
- 中间：内层 Agent 对话（执行中输入锁定，插件调用实时展示并记入日志）
- 右侧：外层 OpenCode 对话（自动携带插件清单+内层日志，输出结构化修改建议）
- 底部：统一审批栏（diff 预览、批准/否决、回滚最近快照）

## 插件规范

`plugins/<name>.js`，文件头注释提供元信息（系统不 require 即可列清单，实现渐进式加载）：

```js
// @name fetch
// @desc 抓取网页内容
// @essential false   // true = 基础插件，启动即加载

module.exports = {
  params: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  run: async (args, ctx) => "返回字符串结果（回传给内层 LLM）"
  // ctx.cwd = 工作区目录；ctx.dataDir = 数据目录
};
```

- 预装 6 个无特权基础插件：
  - 工具类：read / write / edit / bash
  - 记忆类：memory（内层跨会话持久记忆，save/search/list/delete，存 `.data/memory.json`）
  - 技能类：skill（内层任务方法论沉淀，save/list/get/delete，markdown 存 `workspace/skills/`）
- 前端「新建插件」提供三类模板（工具 / 记忆 / 技能），一键预填骨架代码
- 热插拔：审批通过或手动保存后自动热加载（清 require 缓存），内层无需重启
- 渐进式加载：启动仅加载 essential 插件；业务插件首次被调用时才加载代码

## 软约束与安全模型

- 外层系统提示词软约束：仅修改插件目录、不碰核心 runtime、修改必须等用户批准
- 无路径白名单硬编码；服务端按审批结果机械应用（先快照后写入）
- 快照仅保留最近 2 个版本（.data/snapshots/），所有操作记审计日志（.data/audit.json）
- 内外层上下文隔离：仅内层日志与插件状态单向同步给外层

## 环境变量

| 变量 | 说明 |
|---|---|
| PORT | 服务端口（默认 3788） |
| DUAL_AGENT_MOCK=1 | 演示模式（假内层 LLM + 假外层 opencode） |
| DUAL_AGENT_AUTO_APPROVE=0 | 关闭 opencode --auto（可能因权限询问卡住） |
| DUAL_AGENT_OPENCODE_CMD | 显式指定 opencode 完整路径（Windows 检测失效时使用） |

Windows 注意：npm 全局安装的 opencode 是 `.cmd` 垫片，程序会自动从 `where` 结果中优先选择可执行垫片并以 shell 方式启动；若仍失败，用 `DUAL_AGENT_OPENCODE_CMD` 指定完整路径。
