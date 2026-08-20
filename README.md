# 双层 Agent 自迭代系统（dual-agent-loop）

轻量演示：内层 Agent（OpenAI 兼容 API + 插件执行）+ 外层 Agent（本机 opencode CLI）自闭环。
外层根据内层日志与插件状态提出插件增删改建议，经外层栏下方审批栏批准后自动快照、应用、热加载。

## 快速开始

### Windows（一键启动）

**方法一：双击启动**
```
双击 start.bat → 挑空闲端口 → 启动服务 → 自动打开浏览器
```

**方法二：演示模式（无需配置 API）**
```
双击 demo.bat → 使用模拟 LLM，体验完整功能
```

关闭全部网页约 1 分钟后服务自动退出；关闭启动窗口立即停止。

### Linux / macOS

```bash
./start.sh        # 正常模式
DUAL_AGENT_MOCK=1 ./start.sh  # 演示模式
```

### 手动启动

```bash
# 正常模式（需要内层 API + opencode）
node server.js

# 演示模式（无需 API）
DUAL_AGENT_MOCK=1 node server.js

# 指定端口
DUAL_AGENT_PORT=3800 node server.js

# 关闭自动退出 / 调整空闲时间
DUAL_AGENT_AUTOSTOP=0 node server.js
DUAL_AGENT_IDLE_MS=120000 node server.js
```

## 特性

- **VPN/代理兼容**：脚本内设置 NO_PROXY 直连本机，绝不修改系统代理或注册表
- **网页关即服务关**：全部网页关闭且无任务执行时约 1 分钟后自动退出（可 DUAL_AGENT_AUTOSTOP=0 常驻）
- **端口自动选择**：3788-3796 自动跳过被占端口；已有实例在跑时直接开浏览器复用
- **9 个原子级技能**：read / write / edit / bash / fetch / search / memory / skill / todo——单一职责、互不重叠、不可再分；search 免 key 多引擎降级（Bing → DuckDuckGo，可选 Serper key 升级）
- **AI 修复插件**：点击插件的"AI 修复"按钮，调用外层 OpenCode 自动修复
- **审批栏**：所有插件修改需人工批准，支持回滚

## 界面

- 左侧：工作区切换 + 插件管理（基础/业务分组、加载状态、手动增删改、导入导出）
- 中间：内层 Agent 对话（执行中输入锁定，插件调用实时展示并记入日志；会话随工作区隔离、重启恢复）
- 右侧：外层 OpenCode 对话（自动携带插件清单+内层日志；opencode 会话续聊，外层记得之前说过什么）
- 右栏顶部：自动评审提示（内层累计 12 次调用或 3 次失败未评审时出现）
- 右栏内下方：统一审批栏（行级 LCS diff 渲染、风险警告、批准/否决、回滚最近快照）

## 插件规范

`plugins/<name>.js`，文件头注释提供元信息（系统不 require 即可列清单，实现渐进式加载）：

```js
// @name fetch
// @desc 抓取网页内容
// @essential false   // true = 基础插件，启动即加载

module.exports = {
  params: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  run: async (args, ctx) => "返回字符串结果（回传给内层 LLM）"
  // ctx.cwd = 当前工作区目录；ctx.dataDir = 数据目录
};
```

- 预装 9 个插件：
  - 工具类：read / write / edit / bash / fetch（网页抓取转文本）/ search（免 key 多引擎搜索：Serper → Bing → DuckDuckGo 降级链）
  - 记忆类：memory（跨会话持久记忆，存工作区 `.memory-short.json` / `.memory-long.json`，单调递增 id）
  - 技能类：skill（任务方法论沉淀，markdown 存工作区 `skills/`）
  - 任务类：todo（跨轮任务清单，存工作区 `.todo.json`）
- 前端「新建插件」提供三类模板（工具 / 记忆 / 技能），一键预填骨架代码
- 热插拔：审批通过或手动保存后自动热加载（清 require 缓存），内层无需重启
- 渐进式加载：启动仅加载 essential 插件；业务插件首次被调用时才加载代码
- 单次执行兜底超时（默认 60 秒，`DUAL_AGENT_PLUGIN_TIMEOUT_MS` 可调），插件挂起不会卡死会话

## 安全模型

- 外层系统提示词软约束：仅修改插件目录、不碰核心 runtime、修改必须等用户批准
- 静态预检（应用前）：语法错误直接拒绝（vm 编译检查）；危险模式（子进程/网络监听/进程终止/递归删除等）转为审批栏黄色警告，用户知情后可批
- 快照仅保留最近 2 个版本（`.data/snapshots/`），所有操作记审计日志（`.data/audit.json`，环形 500 条）
- 内外层上下文隔离：仅内层日志与插件状态单向同步给外层
- 审批队列持久化：重启后待审批项不丢；内层会话历史也持久化（最近 60 条）

## 多工作区

每个工作区一个任务域（`workspaces/<name>/`）：内层会话（`inner-messages.json` 分片存档，切走再切回历史完整恢复）、记忆、技能、任务清单随工作区隔离；插件全局共享。

## 测试

```bash
node test/smoke.js
# 三段：全量语法检查 → 单元（lint/parse/插件/超时/审批管线）→ MOCK 模式 e2e（47 项断言）
```

## 环境变量

| 变量 | 说明 |
|---|---|
| PORT / --port | 服务端口（默认 3788） |
| DUAL_AGENT_MOCK=1 | 演示模式（假内层 LLM + 假外层 opencode） |
| DUAL_AGENT_AUTO_APPROVE=0 | 关闭 opencode --auto（可能因权限询问卡住） |
| DUAL_AGENT_OPENCODE_CMD | 显式指定 opencode 完整路径（Windows 检测失效时使用） |
| DUAL_AGENT_PLUGIN_TIMEOUT_MS | 单次插件执行兜底超时（默认 60000） |
| DUAL_AGENT_DATA / DUAL_AGENT_PLUGINS_DIR / DUAL_AGENT_WS_ROOT | 数据/插件/工作区目录覆盖（测试隔离用） |

Windows 注意：npm 全局安装的 opencode 是 `.cmd` 垫片，程序会自动从 `where` 结果中优先选择可执行垫片并以 shell 方式启动；若仍失败，用 `DUAL_AGENT_OPENCODE_CMD` 指定完整路径。bash 插件在 Windows 下自动先切 UTF-8 代码页（`chcp 65001`）防中文乱码。
