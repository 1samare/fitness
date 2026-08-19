# 阶段六：单 Agent 有限对话设计

## 1. 背景与目标

阶段一至五已经在 `feat/v1.0` 建立可信微信身份、不可变规划版本、确定性能量与营养计算、一周餐单联动、锁定/手改保护和食材图片确认。阶段六只在这些公开应用服务之上增加有限自然语言入口，不改变任何数值、来源、过敏原或版本规则。

本阶段交付以下能力：

- 使用 LangGraph.js 实现一个单 Agent 状态图，不引入多 Agent。
- 只支持移动训练日、换菜和调整份量三种白名单意图。
- 模型只负责意图和证据文本提取；确定性代码重新解析全部参数并调用公开应用服务。
- 严格校验模型输出，最多一次受控修复，二次失败明确降级。
- 服务端保存最近 12 条消息、确定性结构化摘要和可恢复的单个 pending turn。
- 通过同一个 CloudBase AI+ Provider 适配器支持混元和 DeepSeek 的显式环境配置切换，不自动跨供应商回退。
- 模型或 Agent 不可用时，现有结构化页面、确定性计算和既有计划继续独立可用。

## 2. 非目标

本阶段不实现：

- 开放式健康问答、医疗建议、伤病康复或知识库问答。
- 多 Agent、自主选择任意工具、模型生成工具调用或数据库查询。
- 模型生成热量、营养素、克数、MET、训练时长、动作、强度或身体数据。
- 客户端选择 Provider、模型、工具、身份或内部版本 ID。
- 自动在混元和 DeepSeek 之间转发同一段用户对话。
- 模型流式文本、推理过程展示或任意模型自然语言回复。
- 真实 CloudBase AI+ 部署、模型访问审批、备案/登记、内容标识和真机验收；这些继续作为阶段七外部门禁。

## 3. 已批准决策

1. 明确且完整的白名单命令在确定性校验通过后直接执行。缺少参数时追问；版本冲突、过去事实或营养/库存/过敏原冲突时拒绝或进入现有待确认流程。
2. 使用独立 `assistant-api` CloudBase 云函数；函数内直接组合公开应用服务，不通过 HTTP 或嵌套云函数调用 `planning-api`。
3. 新增 `@fitness/agent` 包，并引入 `@langchain/langgraph` 与 CloudBase 官方 Node SDK。不得引入额外 Agent 框架或常驻服务器。
4. 混元和 DeepSeek 通过服务端 Provider 标识与模型名显式切换。单次请求失败只降级到结构化页面，不自动跨供应商回退。
5. 模型只输出严格枚举和原文证据。所有用户可见回复由确定性代码从固定模板产生。
6. 会话存入现有用户规划聚合的 schema v7；v6→v7 只补空状态，不推断或伪造历史会话。

## 4. 总体架构

```text
微信小程序受限计划助手
  → assistant-api（可信 OpenID、严格跨端契约）
    → AssistantConversationService（版本、幂等、最近消息、摘要）
      → @fitness/agent（LangGraph 单状态图）
        → LanguageModelProvider（混元或 DeepSeek）
        → PlanningAssistantCommandService（仅三项白名单）
          → 现有训练重算 / 餐单编辑 / 营养复算服务
            → PlanningRepository
              → planning_user_states schema v7
```

依赖方向保持为：

```text
miniprogram
  → cloudfunctions/assistant-api
    → packages/agent
      → packages/application 的公开命令端口
    → packages/providers 的 LanguageModelProvider 实现
    → packages/persistence 的 PlanningRepository 实现
```

`packages/agent` 不导入 CloudBase SDK、数据库适配器或供应商 DTO。Agent 工具在云函数组合根绑定可信 `userId`，图状态和模型输出都不包含可信身份字段。

## 5. 组件边界

### 5.1 `packages/contracts`

新增 `assistant-api` 契约：

- `getAssistantConversation`：无客户端身份参数，返回安全会话视图、版本和可恢复 pending 信息。
- `sendAssistantMessage`：只接受 `expectedVersion`、`idempotencyKey` 和一条 `message`。
- 消息正文去首尾空白后长度为 `1–2000`；客户端不能提交角色、历史消息、摘要、模型、Provider、工具或 `userId`。
- 响应是严格的成功/失败联合类型；所有错误码和恢复动作可穷举。

### 5.2 `packages/agent`

新增单个 LangGraph `StateGraph`，节点固定为：

```text
START
  → decide
  → validate
  → repair（仅首次校验失败）
  → validate_repair
  → route
    → clarify
    → reject
    → execute
  → END
```

图没有动态节点名、模型工具调用、多 Agent、任意循环或数据库节点。显式的 `repairAttempt: 0 | 1` 和固定边保证最多一次受控修复。

### 5.3 `packages/application`

新增两个聚焦服务：

- `AssistantConversationService`：管理 turn 生命周期、会话版本、最近消息、摘要和幂等重放。
- `PlanningAssistantCommandService`：暴露 `moveTrainingDay`、`replaceMeal` 和 `resizeMealPortion`，内部只复用或扩展当前公开规划服务。

现有 `createMealPlanEditingService` 增加显式份量调整入口。份量路径必须与换菜路径共用 Provider 图加载、来源 token 二次校验、库存/多样性/营养/过敏原检查、过去事实门禁、版本 CAS 和完整成功后激活规则。

### 5.4 `packages/providers`

新增：

- `LanguageModelProvider` 韧性包装器。
- CloudBase AI+ 文本模型后端。
- 本地确定性模型 fixture，仅本地入口可引用。
- 字段白名单观测事件。

### 5.5 `cloudfunctions/assistant-api`

独立函数负责：

- 从运行时 OpenID 建立可信用户范围。
- 严格解析请求和响应。
- 组合 PlanningRepository、应用服务、单 Agent 与 LanguageModelProvider。
- 把内部错误映射为固定公共错误，不泄漏供应商正文或内部 ID。
- 构建 local 和 cloud-only 两份制品；cloud-only 制品不得包含 fixture、本地身份入口或运行时模式开关。

### 5.6 小程序

新增 `pages/assistant/index` 和 `services/assistant-api.ts`。页面只展示受支持能力、最近安全消息、发送状态和结构化页面恢复入口，不显示模型原始文本或思考过程。

## 6. API 与客户端数据流

### 6.1 读取会话

页面进入时调用 `getAssistantConversation`。服务端按可信 OpenID 返回：

- `conversationVersion`
- 最多 12 条安全消息
- 当前是否有 pending turn
- 如果有 pending turn，返回同一用户可恢复所需的 idempotency key 和原用户消息
- 三种支持命令的固定说明

客户端不能请求其他用户的会话，也不能通过路径或 payload 指定会话 ID。

### 6.2 发送消息

客户端发送：

```text
expectedVersion
idempotencyKey
message
```

页面使用现有 pending-command 模式保存这三个值。网络或响应丢失后必须原样重放；不得为同一用户动作生成新 key。

### 6.3 完成后刷新

命令执行成功后，页面刷新 assistant 会话和 planning context。训练移动产生的锁定餐单差异继续由现有餐单页展示并由用户决定；助手不替用户自动覆盖锁定日。

## 7. 模型输出与证据校验

### 7.1 严格输出联合类型

模型输出只允许：

```text
command
clarify
reject
```

`command` 只允许以下意图和证据字符串：

- `move_training_day`：`sourceDateText`、`targetDateText`
- `replace_meal`：`businessDateText`、`mealSlotText`、`dishNameText`
- `resize_meal_portion`：`businessDateText`、`mealSlotText`、`multiplierText`

`clarify` 只允许缺失字段枚举；`reject` 只允许固定原因枚举。所有对象 `.strict()`，额外的 `userId`、数值字段、工具名、URL、代码、SQL、查询、内部 ID 或自然语言说明都会使 schema 失败。

### 7.2 确定性证据规则

任何命令参数必须满足以下之一：

1. 证据字符串逐字存在于最新用户消息；或
2. 参数来自上一轮已经由同一确定性规则验证并存入 `pendingClarification` 的白名单字段。

确定性代码而非模型负责：

- 解析 `YYYY-MM-DD` 业务日期。
- 把“早餐/早饭、午餐/午饭、晚餐/晚饭、加餐”映射到固定 MealSlot。
- 把 `0.5–1.5 倍` 或 `50%–150%` 转换为倍率，并要求属于当前 `WEEKLY_MEAL_SERVING_MULTIPLIERS` 的 0.05 步进集合。
- 精确匹配当前服务端 `selectableRecipes` 中的 `dishNameZh`。

模型返回的任何数值表现都只是待核对文本，不能直接进入领域命令。

### 7.3 一次修复

首次 JSON 解析、schema 或证据失败时，Provider 接收固定错误类别：

- `invalid_json_or_schema`
- `evidence_not_explicit`
- `unsupported_parameter`

修复 prompt 不包含校验堆栈、身体档案或供应商错误正文。第二次失败立即返回 `model_output_invalid`，不调用工具。

## 8. 白名单命令

### 8.1 移动训练日

输入只有原日期和目标日期。应用服务必须：

- 读取当前活动训练计划。
- 要求两个日期都属于同一活动周，且严格晚于用户业务时区中的今天。
- 要求原日期恰有一个已计划 session，目标日期没有 session。
- 原样复制 `sessionCode` 和 `durationMinutes`；不接受模型提供的 MET、时长、动作或强度。
- 使用当前训练计划版本和由 turnId 派生的领域幂等键调用现有重算服务的 `saveTrainingPlan`。
- 保留过去事实；只移动训练日时整周净训练消耗守恒。
- 未锁定餐单按现有规则原子更新；锁定/手改日只产生差异待确认。

### 8.2 换菜

应用服务只接受业务日期、餐次和当前可选菜名：

- 菜名必须精确解析到服务端当前 `selectableRecipes` 中唯一的食谱版本。
- 使用当前餐单版本调用现有 `updateMealPlanDay`。
- 继续执行来源、Provider 图摘要、库存、食物多样性、营养、过敏原、忌口、过去事实和版本检查。
- 成功后当天自动锁定且标记为手动修改；失败时不产生新餐单版本。

### 8.3 调整份量

应用服务只接受业务日期、餐次和确定性解析的倍率：

- 倍率范围 `0.50–1.50`，步进 `0.05`。
- 当前餐次食谱 ID 来自活动餐单，不由模型或客户端提供。
- 食材克数由审核食谱模板克数乘倍率后按现有规则舍入。
- 重新计算该日每餐展示快照、食材总克数、营养总数和来源快照 ID。
- 重新校验整日营养、整周库存、整周多样性、过敏原、忌口和来源闭包。
- Provider 数据在事务外加载，并在提交前执行完整图 token 二次校验。
- 成功后只创建一个完整餐单后继版本，当天锁定并标记手动修改；任何冲突都不产生部分写入。

## 9. 会话状态、幂等与恢复

schema v7 在 `PlanningAggregateState` 增加单个 `assistantConversation`：

```text
version: non-negative integer
recentMessages: max 12
summary: deterministic safe summary
pendingTurn: null | received | validated
recentReceipts: max 32
```

### 9.1 安全摘要

摘要只包含：

- 当前周起始日（可空）
- 当前训练计划版本号
- 当前餐单版本号
- 最多 7 个锁定日期
- 可空的 `pendingClarification`，且只含已验证的意图和白名单字段

摘要不得包含年龄、身高、体重、性别、健康确认、过敏原、忌口、完整身体档案、自由文本或供应商数据。

### 9.2 Turn 生命周期

1. `beginTurn` 事务校验 expected version、幂等 key、指纹和单 pending 限制，保存 `received`。
2. 事务外调用模型。
3. 通过校验的命令先以 CAS 写为 `validated`。竞争请求必须读取并使用已持久化的权威命令，不能执行自己的非权威模型结果。
4. 工具使用从 `turnId` 确定性派生的领域幂等键执行。
5. `finalizeTurn` 事务追加用户消息和固定 assistant 消息、刷新安全摘要、写 receipt、清除 pending，并裁剪最近 12 条消息和最近 32 条 receipt。

若命令完成后最终写入或响应丢失，同一 idempotency key 会恢复权威 validated command，并用同一领域 key 重放。不同 key 在 pending 存在时返回 `conversation_busy`。页面可从 `getAssistantConversation` 恢复原 pending 请求。

Provider 不可用、二次模型校验失败或命令被领域规则拒绝时也必须通过 `finalizeTurn` 记录固定安全结果并释放 pending；不能让模型失败永久锁住会话。

## 10. Provider 与模型配置

云端必须显式配置：

```text
CLOUDBASE_ENV_ID
FITNESS_LLM_PROVIDER_ID
FITNESS_LLM_MODEL
```

缺少或格式非法时 Provider fail closed。代码不得静默默认到另一个模型。

- CloudBase 托管混元：`FITNESS_LLM_PROVIDER_ID=cloudbase`，模型名取目标环境已启用的混元 ID。
- CloudBase 托管 DeepSeek：`FITNESS_LLM_PROVIDER_ID=cloudbase`，模型名取目标环境已启用的 DeepSeek ID，例如目标环境实际列出的 `deepseek-v4-flash`。
- 自有 DeepSeek：在 CloudBase 控制台登记第三方 Provider、BaseURL 和 API Key；代码只读取控制台 Provider 标识与实际模型名。

模型 ID 必须以目标环境控制台或管理 API 返回值为准，不能在代码中猜测。模型密钥不得进入小程序包、仓库、日志或提示词。

单次生成调用采用：

- 20 秒超时。
- 只对传输或超时错误有限重试一次。
- 连续 3 次完整操作失败后熔断 60 秒。
- 冷却后只允许一次半开探测；成功关闭熔断，失败重新打开。
- 不自动调用第二 Provider。

字段白名单观测仅记录 Provider 标识、模型标识、供应商请求 ID、repair attempt、传输 attempt、延迟、状态和 token/费用单位。不得记录消息、prompt、模型正文、完整错误或用户身份。

## 11. 错误与降级

公共结果使用固定错误码和固定中文恢复文案：

- `invalid_request`
- `unauthenticated`
- `conversation_version_conflict`
- `conversation_busy`
- `model_output_invalid`
- `request_not_allowed`
- `provider_unavailable`
- `command_rejected`
- `nutrition_constraints_infeasible`
- `internal_error`

Provider 不可用、schema 失败、熔断或 Agent 内部错误都不能修改训练、营养或餐单。命令执行中的版本冲突、过去事实、不可选菜品、库存不足、来源断裂、过敏原和营养无解继续由现有领域规则关闭输出。

小程序错误状态必须给出结构化训练页或餐单页入口。模型故障时 `planning-api`、确定性计算、图片确认、现有计划读取和结构化修改仍可运行。

## 12. 隐私与安全

- 身份只取云函数运行时 OpenID。
- 客户端不能提交 userId、历史角色消息、摘要、内部版本 ID、Provider、模型或工具名。
- 模型原始输出和完整 prompt 不持久化。
- 日志不记录自由文本、身体数据、过敏原、访问令牌、Provider 密钥或供应商错误正文。
- 不使用公共知识库、跨用户向量记忆或共享 checkpointer。
- 会话和规划状态位于同一用户哈希文档；将来删除该文档时不会遗留独立会话集合。
- 所有 assistant 写操作带 expected version、幂等 key 和服务端可信身份。
- cloud-only 构建不得包含固定模型 fixture、本地 user ID 或环境变量切换的本地入口。

## 13. 小程序体验

入口名称为“受限计划助手”。首屏固定说明：

- 仅支持移动训练日、换菜和调整份量。
- 日期使用 `YYYY-MM-DD`。
- 份量使用 `0.5–1.5 倍`或 `50%–150%`。
- 所有修改仍受过去事实、版本、库存、营养和过敏原规则约束。

页面提供三个示例但不自动提交。发送期间禁用重复提交，保存 pending request；成功后刷新会话和规划上下文。无模型流式输出、任意 Markdown、链接、代码块或推理展示。

## 14. 持久化迁移

CloudBase 文档升级为 schema v7：

- v2–v6 继续按既有路径迁移旧字段。
- v6→v7 只增加空 `assistantConversation`，版本为 0、消息为空、摘要为空安全值、pending 为 null、receipts 为空。
- 不根据规划历史构造伪造消息或模型结果。
- encode 始终写 v7；decode 对 v2–v7 做严格校验。
- InMemory 和 CloudBase 两种 repository 使用同一个 aggregate invariant。

回滚到不识别 v7 的旧构建前，必须先部署兼容 v7 读取但不写 assistant 的回滚版本；不得直接用只识别 v6 的二进制读取 v7 文档。

## 15. 测试策略

### 15.1 契约与 Agent

- 请求拒绝 userId、角色、历史消息、摘要、Provider、模型、工具名、URL 和额外字段。
- 图只包含一个 Agent 的固定节点与边。
- 模型输入最多 12 条，结构化摘要不含敏感字段。
- 三种意图的明确证据可执行；缺参进入固定 clarify。
- 非法 JSON、额外字段、任意工具、SQL/URL、身份字段和模型生成数值最多修复一次，二次失败不调用工具。
- pending clarification 只合并此前已验证字段。

### 15.2 应用服务

- 移动、目标日占用、过去/当天、跨周、整周守恒、锁定差异、重算失败和响应丢失。
- 换菜的唯一菜名解析、不可选菜、来源变化竞态、过敏原、忌口、库存、营养和版本冲突。
- 份量 `0.50/1.50` 边界、0.05 步进、克数与营养独立复算、整周库存、多样性、来源 token、过敏原属性和事务回滚。

### 15.3 Provider

- 混元和 DeepSeek 配置都映射到同一个受控 CloudBase 后端。
- 缺配置 fail closed。
- 20 秒超时、一次传输重试、完整操作失败计数、熔断、半开和恢复。
- Provider envelope 严格校验。
- 观测事件和日志不含消息、prompt、输出、userId 或密钥。

### 15.4 持久化、API 与 E2E

- v6→v7 空迁移和 v2–v7 兼容读取。
- 不同用户消息、summary、pending 和 receipt 隔离。
- 同 key 重放、不同 payload 复用 key、并发不同 key、模型后 CAS 竞态、命令完成后 finalize 失败恢复。
- 真实 authenticated handler + InMemory repository + 固定模型/营养 fixture 覆盖三种命令、一次修复、二次失败、Provider 不可用和结构化核心独立可用。
- cloud-only 构建不加载 fixture 或本地身份路径。

## 16. 最终验收

完成前必须在 `feat/v1.0` fresh 运行并通过：

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
```

此外必须：

- 对阶段六六项验收逐项指向当前代码和测试证据。
- 运行 `git diff --check` 并检查没有覆盖 `.pnpm-store/` 或其他用户改动。
- 扫描真实密钥、私钥头、用户自由文本 fixture、真实 OpenID、环境 ID 和本地绝对路径。
- 更新 README、CloudBase 部署文档和 `DEVELOPMENT_PROGRESS.md`，如实列出未验证的真实模型、CloudBase、内容标识、微信 IDE 和真机事项。

## 17. 外部门禁

以下事项不阻塞阶段六本地代码完成，但阻塞阶段七受控内测：

- 目标 CloudBase 环境实际启用的混元/DeepSeek 模型 ID 和访问权限。
- 自有 DeepSeek Provider 的服务协议、数据处理、API Key 和费用配置。
- 公开服务所需备案/登记、模型备案号公示和 AI 内容标识。
- 双账号真实会话隔离、函数 IAM、日志脱敏和费用观测。
- 微信开发者工具渲染、页面恢复和物理设备交互。
