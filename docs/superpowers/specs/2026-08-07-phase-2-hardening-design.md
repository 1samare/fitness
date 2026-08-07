# 阶段二补强设计

**状态：** 已批准

**批准日期：** 2026-08-06

**适用分支：** `codex/phase-2`

## 目标

补齐阶段二在原子首次建档、可信身份、不可变版本链、幂等重试、业务日期保护、训练变更事件、每日目标追溯和结构化周训练录入方面的缺口，使代码可以进入真实 CloudBase 开发环境验收。

## 范围

本设计包含：

- 原子保存身体档案、目标、一周训练计划和受影响日期的每日目标。
- 保留身体档案、目标和训练计划的独立版本化编辑命令。
- 保证当前上下文只暴露引用链一致的活动版本，同时返回各聚合的最新版本号。
- 对真实日历日期、过去事实、目标有效期和训练变更影响范围执行确定性校验。
- 在同一事务中持久化 `TrainingPlanChanged` 事件，供后续阶段的饮食重算消费。
- 将小程序训练输入扩展为七天结构化表单。
- 为每日目标补充营养策略版本引用。

本设计不包含：

- 食谱生成、餐单锁定、库存、图片识别或大模型编排。
- 跨周训练历史浏览和训练完成度反馈；这些属于后续阶段。
- 真实 CloudBase 生产环境发布。阶段二只部署到指定开发环境。

## 方案选择

首次建档采用一个服务端复合命令，而不是客户端串行调用三个写命令。复合命令在单个仓储事务中校验并追加全部版本；任何校验、计算或持久化失败都不产生部分状态。

继续保留三个独立写命令，用于首次建档完成后的单项编辑。这样既解决首次流程的原子性和网络重试问题，也不把后续所有编辑耦合成一个大命令。

未选择的方案：

- 客户端保存三个稳定幂等键并断点续传：仍会形成用户可见的部分状态，客户端恢复逻辑也更复杂。
- 引入草稿和发布状态：能够覆盖更复杂协作流程，但阶段二没有相应产品需求。

## API 与事务边界

新增 `completePlanningSetup` 动作。请求包含：

- 一个 `idempotencyKey`。
- `expectedVersions.bodyProfile`、`expectedVersions.goal` 和 `expectedVersions.trainingPlan`。
- 身体档案、目标和训练计划三个结构化 payload。

请求 schema 必须是 strict；客户端不得提供 `userId`、版本 ID、策略版本或创建时间。云函数只使用 `cloud.getWXContext().OPENID` 形成可信服务端身份。

复合命令在一个 `PlanningRepository.transact(userId, operation)` 中执行：

1. 检查复合幂等记录；相同键和相同规范化请求返回原结果，不写新版本。
2. 检查三个 `expectedVersion` 与各自历史数组长度一致。
3. 校验身体档案、目标和训练计划以及它们的跨版本引用。
4. 追加身体档案版本、目标版本和训练计划版本。
5. 为允许变更的业务日期追加每日目标版本。
6. 追加 `TrainingPlanChanged` outbox 事件。
7. 同时更新活动指针并提交聚合文档。

任何步骤失败时，事务保持原状态。复合命令的幂等结果保存创建的三个版本 ID、每日目标版本 ID 列表和事件 ID。

## 幂等指纹

请求指纹使用确定性 JSON 规范化：

- 对象键采用明确的 UTF-16 code-unit 全序排序，不使用受语言环境影响的 `localeCompare`。
- 数组顺序保持不变。
- 对象属性中的 `undefined` 与 JSON 序列化行为一致地忽略。
- 运行时 schema 在进入指纹逻辑前排除 `NaN`、无穷数和非 JSON 值。
- 规范化结果只用于计算 SHA-256，不写入日志或数据库；指纹记录格式固定为 `v2:sha256:<lowercase-hex>`。

阶段二代码尚未部署到任何 CloudBase 环境，因此不迁移旧格式指纹。首次真实部署只能使用新格式；部署记录必须注明这一前提。

## 版本链和当前上下文

保存新身体档案后：

- 新档案成为活动版本。
- 活动目标和活动训练计划指针置空。
- 历史目标、训练计划和每日目标保留且不可改写。

保存新目标后：

- 新目标必须引用当前活动身体档案。
- 新目标成为活动版本。
- 活动训练计划指针置空。
- 历史训练计划和每日目标保留。

保存新训练计划后：

- 新计划必须引用当前活动档案和目标。
- 新计划成为活动版本。

`getCurrentContext` 只返回引用链一致的活动档案、目标和训练计划。不一致或已失效的下游实体返回 `null`，每日目标返回空数组。响应另含只读版本计数：

```text
latestVersions.bodyProfile
latestVersions.goal
latestVersions.trainingPlan
```

客户端使用计数构造 `expectedVersion`，不依赖活动指针是否为空。

## 业务日期与过去事实

所有日期先通过严格公历校验，`2026-02-30`、非闰年 `02-29` 和格式不符的值都被拒绝。日期比较使用 `YYYY-MM-DD` 规范字符串，不依赖 JavaScript `Date` 的静默归一化。

应用服务通过已注入的 UTC `now()` 和训练计划的 `businessTimezone` 计算用户业务日期。允许生成或重算每日目标的起点为：

```text
max(用户业务今日, 目标 effectiveDate, 计划 weekStartDate)
```

训练计划中早于该起点的会话不得新增、移动、取消或修改；这类请求返回结构化 `past_training_change_forbidden`，历史版本保持不变。计划日期不得超过目标 `targetDate`。目标周期只覆盖部分计划周时，只生成有效期内且非过去日期的每日目标。

## 训练计划变更和每日目标

首次为某周创建计划时，所有处于允许范围内的日期均为受影响日期，包括休息日，以建立初始每日目标。

更新同一周计划时，以业务日期为键比较旧、新会话的 `sessionCode` 和 `durationMinutes`：

- 新增或修改训练：该日期受影响。
- 取消训练：原日期受影响。
- 移动训练：原日期和新日期都受影响。
- 完全相同的日期：不追加每日目标版本。
- 过去日期：不允许改变，也不追加版本。

每个受影响日期追加新的每日目标版本；未受影响日期继续使用其已有最新版本。每日目标始终引用实际触发该次计算的身体档案版本、目标版本、训练计划版本、`calculation-policy-v2` 和 `nutrition-policy-v1`。

当前上下文按业务日期选择最新每日目标，而不是要求所有日期都引用当前训练计划版本。这保留了逐日重算范围和准确的来源链。

当新计划的 `weekStartDate` 与当前活动计划不同时，它被视为另一周的初始计划：旧周版本和每日目标保持不变，新周只为允许范围内的日期创建初始目标。当周内编辑时才比较旧、新 session 并生成最小受影响日期集合。

## 聚合不变量

CloudBase 文档通过结构 schema 后，还必须通过聚合不变量校验：

- 所有版本和事件都属于当前可信用户。
- 实体 ID、事件 ID 和幂等键在各自作用域内唯一。
- 身体档案、目标和训练计划版本号为从 1 开始的连续整数。
- 每个业务日期的每日目标版本号为从 1 开始的连续整数。
- 活动指针引用存在的版本；目标、训练和每日目标的跨实体引用存在且属于同一用户。
- 幂等结果引用存在且与记录的操作类型一致。
- outbox 事件引用存在的训练计划、身体档案和目标版本。

仓储在读取已有文档和提交新文档前都执行该校验；损坏状态失败关闭，不尝试猜测或自动修复。

## `TrainingPlanChanged` outbox 事件

事件与计划版本在同一聚合事务中持久化，至少包含：

```text
eventId
eventType = TrainingPlanChanged
userId
previousTrainingPlanVersionId | null
trainingPlanVersionId
bodyProfileVersionId
goalVersionId
affectedDates[]
occurredAt
status = pending
```

重复处理同一幂等命令不得生成第二个事件。阶段二只负责可靠记录事件和验证影响日期；事件消费和饮食计划重算在后续阶段实现。

## 营养策略追溯

新增版本化策略元数据 `nutrition-policy-v1`：

```text
policyVersion = nutrition-policy-v1
sourceIds = [CN-DRI-2023, CN-DRI-MACRO-2017]
applicableAgeRange = 18–45
applicableBmiRange = 18.5–<24.0
effectiveDate = 2026-08-07
reviewedAt = 2026-08-07
```

阶段二不新增宏量营养素计算，但每日目标必须保存 `nutritionPolicyVersion: 'nutrition-policy-v1'`，为后续营养目标和餐单版本建立稳定引用。生产上线前仍须按仓库约束复核《中国居民膳食营养素参考摄入量（2023 版）》正式表格；差异通过新策略版本处理，不改写历史目标。

## 小程序结构化周训练表单

首次设置页展示计划周的七个业务日期。每行包含：

- 是否安排训练。
- 从仓库内已审核 MET 会话目录选择 `sessionCode`。
- 训练时长（分钟）。

过去或目标有效期外日期禁用编辑并说明原因。关闭某日训练时不提交该日 session。页面允许零到七个训练日，不推断动作、MET、强度或克数。

页面只调用一次 `completePlanningSetup`。在调用完成前保留同一幂等键；成功后清除。网络错误后以相同 payload 和键重试。业务校验错误展示结构化提示，不自动修改用户数据。

## 错误模型

新增或细化以下稳定错误码：

- `invalid_calendar_date`
- `version_conflict`
- `idempotency_key_reused`
- `planning_prerequisite_missing`
- `past_training_change_forbidden`
- `training_date_outside_goal_period`
- `invalid_training_plan`

未知异常映射为不包含敏感正文的 `internal_error`。日志不得记录完整身体档案、OpenID、自由文本或请求 payload。

## CloudBase 配置

- 真实微信 AppID 仅保留在本地微信开发者工具项目配置，不纳入阶段二提交。
- 用户指定的 CloudBase 开发环境通过微信开发者工具或受控 CLI 在本地选择；仓库不保存真实 EnvId、云密钥或微信 AppSecret。
- 客户端数据库规则继续默认拒绝；业务数据只经 `planning-api` 云函数访问。
- 第二个微信测试身份可在部署后加入体验成员；在加入前不能完成真实跨用户隔离验收。

## 测试与验收

自动化测试必须覆盖：

- 复合命令成功时一次提交全部版本，任一步失败时零写入。
- 响应丢失后的相同键重试不增加任何版本或事件；不同 payload 复用键被拒绝。
- 对象键顺序不影响指纹，数组顺序保持语义，Unicode 键使用确定全序。
- 更新档案或目标后，下游活动指针失效；版本计数仍允许正确提交下一命令。
- 真实日历日期和闰年边界。
- 用户业务日期、目标生效日、目标结束日和过去日期门禁。
- 初始周、训练新增、修改、取消、移动和无关日期不变的影响范围。
- 每日目标完整引用档案、目标、训练、能量策略和营养策略版本。
- 七日表单可生成零到七个 session，并拒绝缺少类别或时长的启用行。
- 客户端携带 `userId` 被 schema 拒绝，CloudBase 存储跨用户污染被拒绝。
- 聚合版本不连续、悬空指针、缺失幂等结果和断裂事件引用在仓储边界失败关闭。

完成实现后必须重新运行：

```text
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd build:miniprogram:local
pnpm.cmd dry-run:api
pnpm.cmd smoke:api
git diff --check
```

真实云端验收记录至少包含 EnvId、云函数版本、日期、执行账号、幂等结果、版本冲突结果和双微信隔离结果。第二个微信未加入前，阶段二不能声明完整云端验收完成。
