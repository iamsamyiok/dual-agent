# 双层 Agent 自迭代系统（dual-agent-loop）

轻量演示：内层 Agent（OpenAI 兼容 API + 插件执行）+ 外层 Agent（本机 opencode CLI）自闭环。
外层根据内层日志与插件状态提出插件增删改建议，经外层栏下方审批栏批准后自动快照、应用、热加载。

> **v1.0.0 里程碑**：五层记忆系统（三层日常 + 任务归档 BM25 + 语义向量 RRF 混合检索）+ 框架级预取注入/自动归档 + hwj 终端智能体 + 一键安装发布链。零依赖（仅 Node 内置模块），Embedding 对接硅基流动免费 bge-m3。

## 安装（npm，v1.1.0 起）

```bash
# 全局安装（推荐）
npm i -g hwj-agent
hwj-agent                # 检测配置 → 选择 TUI / GUI（见下方首次体验）
hwj-agent tui            # 直达终端 TUI（跳过检测与选择）
hwj-agent run "创建 hello.txt 写入问候语"   # 非交互单次任务
hwj-agent gui            # 直达 Web 界面（自动挑端口）
hwj-agent install        # 可选：把 hwj 短命令装入 PATH（喜欢短命令的用户）

# 免安装试跑
npx hwj-agent run "演示任务"
```

**首次体验流程**（`hwj-agent` 一条命令）：

1. 检测 API 配置完整性 + 有效性（GET `/models` 实探，Key 错/服务不通当场发现）
2. 未配置/无效 → 自动打开浏览器配置页（表单填写保存）→ 回终端按回车重新检测
3. 检测通过 → 选择界面：回车进终端 TUI，输 2 开网页 GUI

TUI 状态栏实时显示：模型名 · 本次任务时长（运行中走秒，完成定格）· 程序运行时长 · token 用量 · 排队数。

无 npm 环境：Windows 双击 `hwj.bat` / `install.bat`，macOS/Linux 双击 `hwj.command`。

### SDK（两行代码调用）

```js
const { chat } = require('hwj-agent');

const answer = await chat({ baseUrl, apiKey, model, message: '一句话解释 RRF' });
```

- `chat(opts)` 单轮问答（`tools: true` 开启插件工具流）
- `run(opts)` 单任务完整编排（注入/工具流/核验/自动归档，返回 `{ ok, finalText }`）
- `create(preset)` 预置配置的可复用实例
- API 三项可省略：回落共享 `.data/config.json`（与 TUI/网页版互通）；`DUAL_AGENT_MOCK=1` 离线演示
- 详见 `lib/sdk.js` 头注释

## Embedding 配置（语义记忆，推荐免费 bge-m3）

语义记忆（`remember`/`recall` 混合检索）需要一个 OpenAI 兼容的 Embedding API，推荐硅基流动免费模型：

| 配置项 | 填写值 |
|---|---|
| Base URL | `https://api.siliconflow.cn/v1` |
| API Key | 你自己的 `sk-` 开头密钥 |
| 模型名 | `BAAI/bge-m3` |

**免费申请三步**：
1. 打开 [cloud.siliconflow.cn/account/ak](https://cloud.siliconflow.cn/account/ak)，注册/登录硅基流动（手机号即可）
2. 点「新建 API 密钥」→ 复制 `sk-` 开头的密钥
3. 网页版右上角「设置 → Embedding API」填入三项 → 点「测试连接」看到"连接成功"即就绪（hwj 终端则运行 `/config` 向导）

说明：`BAAI/bge-m3` 免费（1024 维，单条 8192 tokens），付费加速版为 `Pro/BAAI/bge-m3`；密钥仅存本机 `.data/config.json`（权限 600），与内层 API 同文件。未配置时 remember/recall 自动降级纯关键词检索，功能不阻断。

## hwj 终端智能体（v0.9.28 新增）

内层 Agent 完整能力的终端封装（类 opencode TUI 形态，零依赖）：双击即用、双模式、意图闭环。

```
安装（一次）：双击 install.bat   # 或 node bin\hwj.js install，装入用户 PATH，任意目录可用

hwj                    # 终端交互（同 hwj tui；--ws 指定工作区）
hwj gui                # Web 界面（自动挑端口 3788-3796；已在跑直接开浏览器）
hwj run "创建文件 hello.txt 写入问候语"   # 非交互单次任务：过程+结果，退出码 0/1
hwj run -q "…"          # 安静模式：仅输出最终结果（脚本/管道友好）
echo 任务 | hwj run -   # 提示词从 stdin 读入
hwj help                # 全部命令

终端内：
> /mode plan                          # 只读分析模式（拦截 write/edit）
> /tools                              # 查看折叠的插件调用（/tools 3 展开详情）
> /help                               # 全部 14 个命令

卸载：hwj uninstall（或双击 uninstall.bat）
未安装时：Windows 双击 hwj.bat（菜单：1 永久安装 / 2 临时使用 / 3 直接启动）；macOS/Linux 双击 hwj.command
```

安装原理：往 `%LOCALAPPDATA%\Microsoft\WindowsApps`（默认已在用户 PATH、用户可写）写入 hwj.cmd 指向仓库调度器
`bin/hwj.js`——零管理员权限、不改注册表、已打开的终端立即生效；仓库移动后在新目录重跑 install 即可。

## 数据存储位置（集中式）

在**任意目录**运行 hwj（tui/gui/run），所有数据都集中保存在**安装目录**内，不在调用目录留任何文件：

| 数据 | 位置（安装目录内） |
|---|---|
| API 配置（与网页版共享） | `.data/config.json` |
| 会话 / 记忆 / 技能 / 任务清单 | `workspaces/<工作区>/`（如 `hwj-messages.json`） |
| 过程留痕（每次调用的完整入参与结果） | `workspaces/<工作区>/process.md` |
| 内层调用日志 / 审计 | `.data/inner-log.jsonl`、`.data/audit.json` |
| 任务产出的文件（bash/写文件默认沙箱） | `workspaces/<工作区>/` |

好处：三端（tui/gui/run）共享同一套工作区与记忆，备份/清理只需处理安装目录，不会在用户各处目录里散落文件。
在任意目录执行 `hwj run "…"` 时，框架会自动把**调用目录**注入任务上下文，Agent 可用绝对路径直接操作你所在目录的文件。

特性：与网页版共享 API 配置（`.data/config.json`）与任务域（记忆/技能/清单/过程留痕），
三种入口共享同一套工作区：`hwj run` 的结果可在 `hwj tui` 里 `/history` 回看，网页版同样可见；
会话独立落盘（`workspaces/<ws>/hwj-messages.json`）互不污染；任务中断（Ctrl+C）保留已完成轮次；
终端显示专为长任务优化：插件调用实时转圈、完成即折叠为一行（失败附错误摘要），流式回复只在预览区滚动、
最终一次性沉降（首行 hwj 前缀，续行无前缀），`/tools [序号]` 随时展开任意调用的参数与结果详情；
支持排队（≤5 条）、多工作区（`--ws`）、会话导出、MOCK 演示（`DUAL_AGENT_MOCK=1`）。
详细设计见 `docs/specs/2026-08-22-hwj-terminal-agent/`。

## 下载与安装（Release 用户）

1. 下载并解压 `dual-agent-<版本>.zip`（如 `dual-agent-0.9.29.zip`）
2. 双击 `install.bat` —— 将 `hwj` 命令装入用户 PATH（无需管理员、不改注册表），任意目录可用
3. 首次使用：终端输入 `hwj` 按引导配置内层 API；或双击 `demo.bat` 免配置体验完整流程

所有数据（API 配置、会话、记忆）保存在解压目录内，卸载双击 `uninstall.bat` 即可。
不想安装也可直接双击：`hwj.bat`（出现选择菜单：**1 永久安装（默认）/ 2 临时使用（专用窗口，关窗即失效、不留文件）/ 3 直接启动**）、
`start.bat`（Web 版）、`demo.bat`（演示）。

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
  - 工具类：read / write（覆盖走原子写、append 带重试幂等保护、智能区分续写误用与整体重构）/ edit / bash / fetch（网页抓取转文本）/ search（免 key 多引擎搜索：Serper → Bing → DuckDuckGo 降级链）
  - 记忆类：memory（五层记忆：short/long TF-IDF + 任务归档 BM25 + 语义向量 remember/recall 混合检索，见「记忆检索与整理」）
  - 技能类：skill（方法论沉淀 + **兼容 Agent Skills 开放标准**：社区技能目录直接拷入即用，详见下文）
  - 任务类：todo（跨轮任务清单，存工作区 `.todo.json`）
- 前端「新建插件」提供三类模板（工具 / 记忆 / 技能），一键预填骨架代码
- 热插拔：审批通过或手动保存后自动热加载（清 require 缓存），内层无需重启
- 渐进式加载：启动仅加载 essential 插件；业务插件首次被调用时才加载代码
- 单次执行兜底超时（默认 60 秒，`DUAL_AGENT_PLUGIN_TIMEOUT_MS` 可调），插件挂起不会卡死会话

## 安全模型

- 外层系统提示词软约束：仅修改插件目录、不碰核心 runtime、修改必须等用户批准
- 静态预检（应用前）：语法错误直接拒绝（vm 编译检查）；危险模式（子进程/网络监听/进程终止/递归删除等）转为审批栏黄色警告，用户知情后可批
- 快照仅保留最近 2 个版本（`.data/snapshots/`），所有操作记审计日志（`.data/audit.json`，环形 500 条）
- 内外层上下文隔离：仅内层日志与插件状态单向同步给外层；失败日志带较完整错误原文（成功条目压缩），首次评审自动附带全部插件源码（续聊时外层可用文件工具自行读取 `plugins/`），并附最近审批栏决定避免重复提议
- 审批队列持久化：重启后待审批项不丢；内层会话历史也持久化（最近 60 条）

## 多工作区

每个工作区一个任务域（`workspaces/<name>/`）：内层会话（`inner-messages.json` 分片存档，切走再切回历史完整恢复）、记忆、技能、任务清单随工作区隔离；插件全局共享。

## Agent Skills 兼容（开放标准）

内层技能库兼容 [Agent Skills](https://agentskills.io/) 开放标准（Claude Code / OpenCode / Cursor 等通用），社区现成技能**零适配直接使用**：

- **目录型（标准）**：`skills/<name>/SKILL.md`（YAML frontmatter 至少含 `name` + `description`），可捆绑 `scripts/` `references/` `assets/`，把技能目录直接拷进来即被发现
- **单文件型（本系统简化格式）**：`skills/<name>.md`，首行标题即描述
- **两个搜索根**：工作区 `workspaces/<ws>/skills/`（就近优先）+ 项目根 `skills/`（全局共享，放通用技能）
- **渐进式加载**（与标准三阶段一致）：`skill.list()` 只载名称+描述（约 100 token/技能）→ 相关时 `skill.get(name)` 读全文（目录型自动附捆绑资源清单）→ 捆绑资源按需用 `read` 插件读取
- **`skill:` 协议**（read 插件）：SKILL.md 正文里的相对路径引用（如 `templates/viewer.html`）直接加前缀照抄可读——`read(path="skill:<技能名>/templates/viewer.html")`，框架自动定位技能目录（工作区优先），技能名与 frontmatter `name` 或目录名匹配均可；`skill:<名>` 不带路径则读 SKILL.md 本体
- **脚本类技能 bash 执行**：`skill.get` 资源清单每项同时给绝对路径（`skill:名/rel → /abs/path`），正文指示运行脚本时用 `→` 后的路径（bash 无法解析 `skill:` 协议）；清单自动过滤 `__pycache__`/`.pyc`
- **一键安装**（`skill install`）：`skill(action="install", url="owner/repo[/子目录]")` 直接从 GitHub 拉取安装（codeload tarball + 内存解包，零依赖）。支持仓库简写 / 子目录 / 完整 URL（含 tree/branch）；仓库级安装自动发现全部含 SKILL.md 的技能目录（实测一次装入 obra/superpowers 14 个技能）；版本记录在 `skills/.installed.json`（来源/ref/文件数/时间），重装即更新
- 同名技能工作区版本覆盖全局共享版本
- `DUAL_AGENT_SKILLS_SHARED` 环境变量可覆盖全局共享目录位置

实测案例：拷入官方仓库 [anthropics/skills](https://github.com/anthropics/skills) 的 `algorithmic-art` 技能（SKILL.md + templates/），内层自动完成 发现 → get 读全文 → `skill:` 协议读出 viewer.html / generator_template.js 模板 → 基于模板产出含交互参数面板的生成艺术（跳过模板凭空自写的问题由资源清单 + 技能执行纪律规则根治）。

第二轮实测（skill-creator 元技能，33K 正文 + agents/assets/eval-viewer/references/scripts 五层捆绑资源）：内层按其流程 读 references/schemas.md 格式规范 → 创建目录型新技能（frontmatter + evals 用例），新技能即刻被 `skill.list()` 发现——零适配闭环。frontmatter 解析兼容多行 YAML（折叠 `>-` / 字面 `|` / 普通续行），社区技能常见写法无需修改。

第三轮实测（自研 pdf-to-md 技能，脚本型）：内层按 SKILL.md 四步执行——确认输入 → bash 用清单绝对路径运行 `pdf_to_md.py`（pdftotext 优先 / pypdf 回退；标题层级映射、列表规范化、页眉脚剔除、连字符断词合并、表格自动转换与不规则块保守保留）→ read 质检 → edit 把"疑似表格"按原文人工转成规范 Markdown 表格并复核交付。规则转换 + Agent 润色的分工在脚本型技能上闭环。

第四轮实测（skill install 一键安装）：用户一句话"安装 anthropics/skills 里的 pdf 技能"，内层自主构造 `install(url="github.com/anthropics/skills/tree/main/skills/pdf")` → 4.8s 装入 12 文件 57KB → `skill.list()` 确认 27 个技能在库。装技能从"手动 cp"变为对话内一句安装。

## 审批质量闸门与插件记分

- **预检两阶段**（lib/regression.js，apply 前强制）：① 结构冒烟——沙盒加载（Node 内建放行、第三方模块拦截——零依赖保护）、params JSONSchema 与 run 函数校验；② 全量回归——待审变更 + 现役插件复制进隔离沙盒跑完整 smoke，破坏其他插件依赖的建议进不了运行时。审计记录 `preflight-blocked`
- **插件质量记分**：从内层日志统计每插件总失败率与近期失败率（近 50 次）；近期 ≥5 次调用且成功率 <60% 标记低质量，注入外层评审上下文并指示优先诊断（读源码与失败原文定位根因再提建议）
- `DUAL_AGENT_NO_PREFLIGHT=1` 跳过预检（测试/演示）；MOCK 模式自动跳过

## 记忆检索与整理

五层记忆体系（v0.9.30 起，对齐 Hermes agent 记忆架构）：

- **三层日常记忆**（`.memory-short.json` / `.memory-long.json`，每层 20 条滚动）
  - **TF-IDF 相关度排序**：中英混合分词（英文按词、中文 2-gram），IDF 加权，子串匹配升级为语义排序——"界面主题"同时召回"主题色""深色主题界面"且更相关者在前，无关记忆（Ubuntu 部署）不再误召回
  - **consolidate 归并**：`memory(action="consolidate")` 把同主题短期记忆簇归并为一条长期记忆（Jaccard ≥0.3 或「共同中文 2-gram + 共同英文词」强信号双通道判定），释放 MAX_SHORT 滚动容量。实测「任务weather：xxx」三条过程记忆正确聚簇、「部署服务器」独立保留
- **任务归档层**（`workspaces/<ws>/memory-archive.jsonl`，无上限）
  - `archive_save` 归档完整任务记录（用户消息 + 最终交付），`archive_search` BM25 全文检索（k1=1.5/b=0.75，文档长度归一）；中文 2-gram 分词，"机械密封"跨词召回历史任务
- **语义向量层**（`.memory-vector.json`，需配置 Embedding API）
  - `remember` 写入长期语义记忆：Embedding 生成稠密向量（L2 归一化 + Int8 量化，体积比 float JSON 小 5 倍）；高相似条目（余弦 >0.85）自动合并；存量无向量条目每次批量补嵌 10 条（渐进迁移）
  - `recall` 混合检索：稠密余弦 + BM25 稀疏两路召回 → RRF 倒数排名融合（k=60）；支持 `tags` 前置过滤与 `mode`（hybrid/vector/keyword）；**未配置 embedding 自动降级纯关键词，功能不阻断**
  - Embedding 配置：网页版设置面板或 hwj `/config` 向导的「Embedding API」段（见顶部[申请指引](#embedding-配置语义记忆推荐免费-bge-m3)），存 `.data/config.json` 与内层 API 同文件；配置界面的「测试连接」（网页按钮 / hwj 向导自动测试，即 `memory emb_test`）实时验证连通性并返回维度与耗时
  - 硅基流动对接细节：批量嵌入每条截 480 字符（API 批量限 512 tokens、数组 ≤32 条的保护），单条调用上限 8192 tokens；Int8 量化适配任意维度返回（bge-m3 为 1024 维）
  - 规模建议：Int8 量化后每条 ~4KB，1 万条内全量加载毫秒级；更大规模建议按工作区分库
- **框架级 push 注入与自动归档**（v0.9.31，对齐 Hermes 全对话生命周期记忆时序；server 与 hwj 同步生效）
  - **启动预取**：任务开始前用用户消息自动跨层检索（语义 recall top3 + 任务归档），命中即注入消息尾部并提示"已预取相关记忆"——pull 模型下模型不主动 search 的遵循度问题由此根治；整体 4s 超时保护，检索失败/为空静默跳过
  - **自动归档**：任务交付后自动把 用户消息+最终交付 归档进 memory-archive.jsonl（异步不阻塞交付），每个任务天然进入归档库，无需手动 archive_save

## 上下文预算管理

内层会话无限增长最终撞 token 上限 → API 400 无法自愈。发 API 前构造压缩副本（落盘会话保持完整）：预算默认 60000 字符（`DUAL_AGENT_CTX_BUDGET` 可调），超出时从最旧 tool 结果压缩为「头 300 + 尾 100 + 折叠标记」；绝不删除条目（assistant.tool_calls 与 tool 配对完整性）；system 与最近 4 个 tool 结果保持全文。

## LLM 限流自动重试

内层 LLM 请求（建连 + 流式读取整体）与外层 opencode 评审会话共用指数退避重试（lib/llmRetry.js）：

- **触发条件**：HTTP 429/402/503、响应体限流特征词（rate limit / quota / 限流 等）、网络抖动（ECONNRESET/ETIMEDOUT 等）
- **退避序列**：3s → 9s → 27s → 81s（3^n），共 4 次重试；全部耗尽才报错，单次限流不再中断任务
- **过程可见**：每次退避经 `info` 事件实时显示在前端对话流与 process 过程页（"X 秒后自动重试（第 n/4 次）"）
- 非限流错误（如 400 参数错）立即失败不重试；`DUAL_AGENT_RETRY_BASE_MS` 可覆盖退避基数（测试注入）

## 测试

```bash
node test/smoke.js
# 三段：全量语法检查 → 单元（lint/parse/插件/超时/审批管线）→ MOCK 模式 e2e（69 项断言）
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

## 发布打包（维护者）

```
双击 release.bat          # 或 node tools/release.js
node tools/release.js --check   # 仅安全自检
node tools/release.js --list    # 查看白名单
```

产物 `dist/dual-agent-<版本>.zip`（约 700KB，零依赖）。采用**白名单机制**：只有显式列入
`tools/release.js` 中 INCLUDE 清单的文件才进包，API 配置（`.data/`）、会话数据（`workspaces/`）、
node_modules 等永远不会泄入；打包前后各做一次泄漏扫描（含 `sk-` 密钥模式检查），失败自动中止。
包内附 `VERSION.txt`（版本 + 构建时间 + 入口说明）。

发布检查单：`node test/hwj-smoke.js` 全绿 → `node tools/release.js --check` 通过 → 打包 → 上传 Release。
