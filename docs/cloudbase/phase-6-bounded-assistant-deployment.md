# 阶段六有限对话助手 CloudBase 部署与验收

阶段六新增独立 `assistant-api`、一个固定 LangGraph.js `StateGraph`、三项白名单领域命令和 schema v7 有界会话。模型只负责意图与参数提取；训练、食材克数、营养值、版本和安全约束仍由确定性应用服务产生并校验。

本文区分“本地自动化证据”和“真实 CloudBase/模型/微信设备证据”。本地 lint、类型检查、测试、构建、dry-run 和 smoke 通过，不代表目标环境已启用混元或 DeepSeek，也不代表 Provider 合同、权限、备案/登记、AI 内容标识、双账号隔离或真机页面已经验证。

## 本地运行与自动化门禁

环境要求为 Node.js `20` 或 `22`、pnpm `9.15.x`。在仓库根目录分别启动结构化规划 API 和有限对话 API：

```powershell
pnpm.cmd dev:api
pnpm.cmd dev:assistant
```

两个命令应在两个终端运行；本地地址分别是 `http://127.0.0.1:3000/` 和 `http://127.0.0.1:3001/`。执行 `pnpm.cmd open:miniprogram` 后，从规划建档页或餐单执行页进入 `pages/assistant/index`。本地助手使用明确隔离的确定性模型和餐单 fixture，只用于开发与自动化测试。

提交或部署前按顺序执行：

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd dry-run:photo-cleanup
pnpm.cmd dry-run:assistant
pnpm.cmd smoke:api
pnpm.cmd smoke:assistant
git diff --check
```

`pnpm.cmd build` 必须只在忽略的 `.build/cloudfunctions` 下生成 `planning-api`、`assistant-api` 和 `photo-cleanup` 三个目录；每个目录只包含 `index.js` 和 `package.json`。不得部署本地 `dist` 入口、源码映射、测试、fixture、`node_modules` 或工作区源码。`assistant-api` 的 cloud-only 制品不得包含 `FITNESS_RUNTIME_MODE`、`FITNESS_LOCAL_USER_ID`、本地模型 fixture 或测试餐单/营养数据。

## 服务端环境配置

真实值只写入目标 CloudBase 的受控服务端配置，不写入仓库、小程序包、发布命令、日志或提示词：

- `CLOUDBASE_ENV_ID`：当前目标 CloudBase 环境标识。
- `FITNESS_LLM_PROVIDER_ID`：传给 CloudBase AI+ `createModel` 的已审核 Provider 标识。
- `FITNESS_LLM_MODEL`：该 Provider 在目标环境实际启用的精确模型 ID。

三个值缺少、为空或格式非法时，`assistant-api` 启动失败关闭。代码没有默认 Provider、默认模型或候选列表；一次请求失败只返回固定降级结果，不会从混元切到 DeepSeek，也不会从 DeepSeek 切到混元。

### 混元与 DeepSeek 选择

| 场景 | `FITNESS_LLM_PROVIDER_ID` | `FITNESS_LLM_MODEL` | 发布前证据 |
|---|---|---|---|
| CloudBase 托管混元 | 目标环境的 CloudBase 托管 Provider 标识 | 控制台或管理 API 返回的已启用混元模型 ID | 模型可见、调用权限、区域和配额 |
| CloudBase 托管 DeepSeek | 目标环境的 CloudBase 托管 Provider 标识 | 控制台或管理 API 返回的已启用 DeepSeek 模型 ID | 模型可见、调用权限、区域和配额 |
| 自有 DeepSeek Provider | 控制台创建的受控第三方 Provider 标识 | 该 Provider 实际接受的精确模型 ID | BaseURL、密钥、服务协议、数据处理和费用均已审核 |

仓库测试中的模型名只验证透传合同，不是生产可用性证明。管理员必须以目标环境控制台或管理 API 的返回值为准，禁止根据文档示例猜测模型 ID。自有 DeepSeek 的 BaseURL 和 API Key 只保存在 CloudBase 的第三方 Provider/密钥配置中，应用运行时只读取 Provider 标识和模型 ID。

CloudBase Node SDK 的 AI 调用方式见 [CloudBase Node SDK AI 参考](https://docs.cloudbase.net/api-reference/server/node-sdk/ai)，第三方 Provider 配置见 [CloudBase 第三方模型配置](https://docs.cloudbase.net/ai/quickstart/third-party-model)。部署时仍需现场核对目标环境所使用 SDK/控制台的当前合同。

## 运行时、权限与观察性

- `assistant-api` 使用 `Nodejs20.19`、`index.main`、`installDependency: false` 和 120 秒函数超时。每次模型传输尝试仍独立限制为 20 秒；只对超时/传输失败重试一次。
- 连续三个完整模型操作失败后，温实例内熔断 60 秒；半开状态只允许一个探测。熔断与传输重试不会选择第二个 Provider。
- 助手执行前的内部异常只在一个仓库事务内确认 turn 仍为 `received` 后终结；已 `validated` 的 turn 保留并以同一领域幂等键重放。客户端遇到版本冲突或 busy 时必须读取并比较服务端 pending，不得原样循环本地旧 envelope。
- `cloudbase/function.rules.json` 只允许已认证用户调用 `planning-api` 和 `assistant-api`，普通客户端不能调用 `photo-cleanup`；数据库业务集合继续拒绝客户端直接读写。
- 身份只取自云函数可信 OpenID。客户端请求不能提交 `userId`、历史角色消息、摘要、Provider、模型、工具、URL、查询或内部版本 ID。
- Provider 观察日志只允许 Provider、模型、供应商请求 ID、repair attempt、传输 attempt、延迟、成功/失败状态和可选 token/费用单位。不得记录用户消息、prompt、模型输出、完整错误、身体数据、过敏原、OpenID 或密钥。
- 上线观察需要按 Provider/模型分别建立调用量、token/费用单位、延迟、固定错误码、重试和熔断告警；不得通过采集消息正文补充可观测性。

## schema v7 前向部署

schema v7 在现有 `planning_user_states` 聚合中增加有界 `assistantConversation`，保留最近 12 条消息、一个 pending turn、结构化摘要和最近 32 个幂等回执。读取 v2–v6 时只补空会话；不推断旧对话、身份、计划或营养事实。第一次成功写入会把文档整体保存为 v7。

受控发布顺序：

1. 记录当前三个函数的版本、制品校验值、规则、环境配置、IAM、定时器和目标环境身份，并备份 `planning_user_states`；证据保存在受控发布系统，不复制到仓库。
2. 完成阶段五的复合索引、early-v6 可信身份和原图清理连续性门禁；清理 worker 在整个发布期间不得中断。
3. 先部署能同时读取 schema v6/v7 的 `photo-cleanup`，确认既有定时器仍使用同一受审配置并能处理 v6 文档。
4. 再部署能读取 v2–v7 且写入 v7 的 `planning-api`。从此刻起不得让任何只认识 v6 的旧 planning/cleanup 制品重新接管流量。
5. 配置并复核三个服务端环境变量、模型访问权限、调用配额和日志脱敏；发布当前 `cloudbase/function.rules.json`。
6. 最后部署 `assistant-api`，确认 `cloudbaserc.json` 中 Node.js 20、`index.main`、120 秒和 `installDependency: false` 已生效，再开放小程序入口。
7. 用两个真实微信账号完成隔离与恢复验收后，才扩大内测范围。

只使用组织预先安装、固定版本并完成安全审核的 CloudBase CLI；禁止通过即时网络执行下载未知 CLI。管理员必须先核对登录身份和目标环境，命令不内嵌真实环境 ID：

```powershell
pnpm.cmd build
tcb -v
tcb fn deploy photo-cleanup
tcb fn detail photo-cleanup
tcb fn deploy planning-api
tcb fn detail planning-api
tcb fn deploy assistant-api
tcb fn detail assistant-api
```

函数代码部署成功不等于环境变量、Provider、规则、IAM、配额、备案/登记或内容标识已经生效；这些控制面项目必须逐项留存匿名化发布证据。

## 部署后 smoke 与人工验收

先重复本地 dry-run 和进程 smoke：

```powershell
pnpm.cmd dry-run:api
pnpm.cmd dry-run:photo-cleanup
pnpm.cmd dry-run:assistant
pnpm.cmd smoke:api
pnpm.cmd smoke:assistant
```

真实环境至少记录以下匿名证据：

1. 账号 A 与账号 B 各自从零打开助手；A 的消息、摘要、pending、回执、训练/餐单版本均不出现在 B 的响应中，反向同样成立。
2. 客户端伪造 `userId`、Provider、模型、工具、URL、查询、内部版本或额外字段时请求失败关闭；错误不泄露另一账号是否存在。
3. 同一幂等键在响应丢失后重放，不重复调用模型或增加会话、训练、餐单、重算任务、领域提交或回执版本；授权前异常原子释放 `received`，授权后的 `validated` pending 保留；页面重启、版本冲突和 busy 都以服务端 pending 为准恢复。
4. 混元配置与 DeepSeek 配置分别验证严格 JSON 合同、一次受控修复、二次非法输出降级、20 秒超时、一次传输重试、三次完整失败熔断和固定安全错误；每轮只观察到一个显式 Provider。
5. 移动训练日、按精确中文菜名换菜和以 `0.50–1.50`、`0.05` 步长调份量都只通过公开应用服务执行；过去事实、版本冲突、锁定/手改、库存、来源、营养、忌口和过敏原继续失败关闭。
6. 模型不可用时，结构化 `planning-api` 和确定性份量调整仍可独立使用；活动训练与餐单不会被非法模型输出修改。
7. Provider/模型权限、区域、配额、费用告警、日志字段白名单、公开服务所需备案/登记和 AI 内容标识均由负责人复核。
8. 微信开发者工具完成页面渲染、禁用/加载状态、12 条消息上限、失败恢复按钮和入口跳转；物理设备完成真实云函数调用及网络中断恢复。

验收记录不得包含真实 OpenID、身体档案、自由文本消息、完整模型输出、供应商错误正文、密钥、环境 ID 或内部数据库文档。

## 回滚

1. 先隐藏或停用助手入口，并收紧 `assistant-api` 调用权限，避免回滚期间创建新会话；结构化规划入口继续保留。
2. 保持一个已知良好的、可读取 schema v7 的 `photo-cleanup` 持续运行，不能制造原图清理空窗。
3. 只回滚到“v7-aware”制品：它必须读取并原样保留 `assistantConversation`，即使暂时禁用模型调用。阶段五原始的只识别 v6 制品不能直接覆盖已经写入 v7 的环境。
4. 如需恢复规划函数，先部署受控保存的上一组 v7-aware `planning-api`，再恢复其配套规则、IAM 和配置；不得把 v7 文档原地降级为 v6，也不得删除会话、幂等回执、训练、营养、餐单、图片或库存历史。
5. 如需更换模型，只修改受控的 `FITNESS_LLM_PROVIDER_ID` 与 `FITNESS_LLM_MODEL`，然后验证该单一配置；故障中不得临时加入跨 Provider 自动回退。
6. 回滚后重新执行三个 dry-run、两个本地 smoke、真实双账号隔离、幂等重放和到期图片清理审计。不能证明旧制品读取 v7 时，应向前修复而不是强制降级。

## 本地不能声明已验证的事项

截至阶段六本地退出，本次没有部署或访问真实 CloudBase AI+、混元、DeepSeek、自有 Provider、微信 IDE 或物理设备，因此以下项目仍未验证：

- 目标环境实际启用的混元/DeepSeek 精确模型 ID、访问权限、区域、配额、响应合同和费用；
- 自有 DeepSeek Provider 的 BaseURL/API Key 管理、服务协议、数据处理、商业授权和退出策略；
- 中国大陆公开服务所需备案/登记、模型合规状态和 AI 内容标识；
- 目标 CloudBase 的函数/数据库/存储规则、嵌套函数 IAM、定时器、复合索引和两个真实微信账号隔离；
- 微信开发者工具页面渲染、页面重启恢复和物理设备网络调用；
- 生产餐单/营养数据 Provider、授权、缓存许可和正式 `CN-DRI-2023` 表格复核。

这些项目属于阶段七受控集成与发布门禁。关闭前不得称为 production ready 或已完成真实云端验收。
