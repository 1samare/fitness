# 阶段五食材图片与 Vision Provider 设计

日期：2026-08-19
状态：用户已确认聊天版设计；书面规格已自审，等待用户复核
目标：在不让图片识别结果直接成为营养事实的前提下，完成私有图片上传、受控视觉候选、明确确认入库、供应商韧性和可重试原图清理。

## 1. 背景与成功标准

阶段四已经提供手动食材库存、确定性一周餐单和训练变化联动。阶段五只增加“食材照片辅助录入”，不能改变已有确定性营养与餐单边界。

阶段完成时必须满足：

1. 小程序只能把 JPEG 或 PNG 上传到服务端为可信用户创建的随机 CloudBase 私有路径。
2. `VisionProvider` 只产生受限候选；候选必须映射到审核营养快照对应的内部标准食材 ID。
3. 用户明确选择候选并填写克数前，不得创建正式库存版本、生成营养数值或触发餐单生成。
4. 视觉调用具备严格 schema、8 秒超时、一次有限重试、熔断、固定桩降级和脱敏观测。
5. 所有原图都有不晚于上传会话创建后 24 小时的应用清理路径；删除失败可重试，未登记 fileID 的孤儿对象仍可定位。
6. 用户隔离、候选确认、供应商失败、日志脱敏、清理幂等和失败恢复均有自动化测试。

真实混元视觉访问、CloudBase 规则发布和微信真机上传属于外部云端门禁。本阶段可以在固定桩、CloudBase 适配器契约和本地函数制品通过后完成代码验收，但不得声称真实供应商或生产环境已验证。

## 2. 方案选择

采用“规划聚合内不可变图片工作流 + 独立定时清理云函数”。

- 图片工作流版本和库存版本处于同一个 `PlanningAggregateState`，用户确认候选时可以原子追加图片版本和库存版本。
- 清理函数只通过应用服务和持久化端口读取到期目标，不直接修改集合中的领域状态。
- `VisionProvider`、私有存储和 CloudBase 函数调用分别通过端口隔离；领域层不导入 CloudBase 或供应商 SDK。

不采用以下方案：

- 独立图片集合与库存 saga：扩展性更高，但确认成功与库存写入需要跨聚合补偿，增加当前 MVP 不需要的中间状态。
- 云函数代理整个二进制上传：权限集中，但会增加图片二进制经过函数的时延、内存和请求大小风险，偏离微信小程序原生云存储路径。
- 整体复用 `phase1-local`：历史实现使用非规范化 JSON 幂等指纹、旧库存结构，并且无法可靠处理未登记 fileID 的孤儿对象，只能逐项审计后重新实现。

## 3. 架构与依赖方向

```text
小程序 ingredient-photo 页面
  → planning-api 创建/登记/识别/确认动作
    → IngredientPhotoService
      → PlanningRepository
      → VisionProvider
        → ResilientVisionProvider
          → CloudBaseFunctionVisionBackend 或显式测试桩
      → NutritionProvider 审核缓存
      → PrivatePhotoStorage

photo-cleanup 定时云函数
  → IngredientPhotoCleanupService
    → PlanningRepository 到期目标查询
    → PrivatePhotoStorage 删除
```

领域包只定义图片工作流、候选和 Provider/存储端口。应用包拥有状态转换、幂等、并发检查、标准食材映射和确认入库。Provider 包负责供应商响应校验、超时、重试、熔断、CloudBase 字段映射和存储错误转换。云函数只处理可信身份、运行时装配和公共错误映射。

## 4. 图片工作流模型

`PlanningAggregateState` 增加不可变 `ingredientPhotoVersions` 和派生调度字段 `nextPhotoCleanupAt`。每个逻辑图片以 `photoId` 标识，每次转换追加新 revision，不覆盖旧 revision。

`IngredientPhotoVersion` 至少包含：

```text
id
photoId
userId
revision
createdAt
uploadCreatedAt
deleteDueAt
expectedCloudPath
expectedPrivateFileId
mediaType
workflowStatus
storageStatus
candidates
confirmedCandidateId?
inventoryVersionId?
cleanupAttemptCount
nextCleanupAt?
lastCleanupFailureCode?
deletedAt?
```

`workflowStatus` 为：

- `awaiting_upload`
- `uploaded`
- `recognized`
- `recognition_failed`
- `confirmed`

`storageStatus` 与业务状态正交，取值为：

- `retained`
- `cleanup_pending`
- `cleanup_failed`
- `deleted`

公开 DTO 永不包含 `userId`、`expectedPrivateFileId`、临时 URL、供应商正文或内部清理错误。创建上传会话的响应只额外返回小程序上传所需的随机相对 `cloudPath`；后续上下文不再返回存储定位符。

`nextPhotoCleanupAt` 必须等于所有最新图片 revision 中最早的待处理清理时间；没有待处理图片时为 `null`。持久化不变量校验这个派生值，CloudBase 清理查询据此避免固定频率全表扫描。

## 5. 存储路径与最小权限

服务端先持久化上传会话，再向客户端返回路径：

```text
ingredient-photos/<random-photo-id>/<random-upload-id>.<jpg|png>
```

路径不包含 OpenID、手机号、用户名或可预测的用户散列。`photoId` 与 `uploadId` 使用安全随机 UUID。服务端通过非秘密环境配置 `CLOUDBASE_STORAGE_FILE_ID_PREFIX` 组合并持久化预期完整 fileID：

```text
<CLOUDBASE_STORAGE_FILE_ID_PREFIX>/<cloudPath>
```

小程序上传成功后把 CloudBase 返回的完整 fileID 登记到 `planning-api`。应用服务要求它与会话中预期 fileID 完全相等，并通过 `PrivatePhotoStorage.inspectPrivateFile` 校验对象存在、文件签名与声明媒体类型均为 JPEG/PNG 且大小不超过 10 MiB。任何不匹配都使用相同公共错误，不能形成跨用户对象探测接口。

仓库增加 CloudBase 存储规则源，`ingredient-photos/` 仅允许文件创建者和管理员读写；其他路径保持拒绝。客户端不获取临时公开 URL，视觉供应商只从服务端访问私有 fileID。CloudBase 官方说明客户端安全规则不限制服务端管理员访问，因此清理和视觉适配器仍可访问私有对象。

## 6. Provider 契约与标准食材映射

领域端口：

```ts
interface VisionProvider {
  recognize(input: {
    privateFileId: string;
    requestId: string;
  }): Promise<{
    providerRequestId: string;
    candidates: readonly VisionCandidate[];
  }>;
}
```

供应商候选只允许：

- `providerCandidateId`：非空受限字符串。
- `name`：去首尾空白后 1–40 个字符。
- `confidence`：`0–1` 有限数。
- 可选 `foodState`：`raw`、`cooked`、`dry` 或 `unknown`。

一次响应最多五个候选，额外字段由严格 Zod schema 拒绝。Provider 不返回克数、热量、宏量营养素或用户身份。

应用服务按置信度稳定排序候选，然后逐项调用现有 `NutritionProvider.resolveCanonicalName` 并加载对应 `NutritionDataSnapshot`。只有以下条件同时成立才持久化标准候选：

- `foodId`、`nutritionSnapshotId` 和快照身份一致。
- 快照来源、版本、原始单位和食物状态完整。
- 生产模式只接受 `qualityStatus: reviewed`；显式测试模式才接受 `test_fixture`。

持久化候选包含内部 `foodId`、`nutritionSnapshotId`、审核中文名、置信度和食物状态，不保存无法映射的供应商名称。全部候选无法映射时记录 `recognition_failed/no_supported_candidate`，页面提供重试和手动录入。

## 7. 视觉韧性策略

命名策略对象 `vision-provider-policy-v1` 固定以下默认值：

- 单次超时：8 秒。
- 最大重试：一次；只重试超时或供应商传输错误。
- schema 非法、鉴权错误和明确不可重试错误：立即失败。
- 连续三个完整识别操作失败后开启熔断。
- 熔断冷却：60 秒；冷却后只允许一个半开探测。
- 成功操作清零连续失败计数。
- 最大候选数：5。
- 最大对象大小：10 MiB。

熔断状态为单个云函数温实例内的进程状态，不宣称跨实例全局熔断。阶段七可根据供应商限流能力决定是否迁移为共享状态；MVP 不为此新增基础设施。

`CloudBaseFunctionVisionBackend` 只调用配置白名单中的函数名，传递私有 fileID，不接受客户端工具名或任意 URL。未配置真实视觉函数时，生产运行时装配显式 `UnavailableVisionProvider`，页面回退手动录入；测试桩只有 `allowTestFixtures=true` 时可加载。

## 8. API 与用户流程

`planning-api` 增加四个严格动作：

1. `createIngredientPhotoUpload`
2. `registerIngredientPhotoUpload`
3. `recognizeIngredientPhoto`
4. `confirmIngredientCandidate`

所有写操作包含可信服务端身份、`expectedVersion` 和 `idempotencyKey`。客户端不得提交 `userId`、标准食材 ID、营养快照 ID、供应商函数名或清理时间。

主流程：

1. 用户从“一周餐单与执行”进入食材拍照页。
2. 页面使用 `wx.chooseMedia` 选择或拍摄一张图片，并在上传前检查客户端可见的类型和大小。
3. 页面请求上传会话，再以返回的随机 `cloudPath` 调用 `wx.cloud.uploadFile`。
4. 页面登记 CloudBase 返回的 fileID；服务端完成可信检查后才允许识别。
5. 页面发起识别，展示“AI 识别候选，必须确认”的候选列表，不显示或推断克数。
6. 用户选择一个候选并输入大于零的整数克数，页面再次明确确认。
7. 服务端重新加载候选引用的审核营养快照并验证身份，然后在一个规划聚合事务中追加图片确认 revision 和新库存版本。
8. 确认只更新库存，不自动生成餐单或营养数值。既有餐单按当前库存版本一致性规则显示 stale，用户仍通过原有显式生成流程处理。

识别失败、熔断开启、超时、无映射候选或上传检查失败时，页面保留可操作错误、允许重新选择图片，并提供跳转到现有手动库存录入的入口。手动路径不依赖视觉 Provider。

`getCurrentContext` 增加最新未删除图片工作流的公开恢复快照和图片逻辑计数，使响应丢失或页面重启后能够恢复候选确认，但不返回私有存储定位符。

## 9. 确认门禁与库存版本

确认命令必须同时匹配：

- 当前可信用户作用域内的最新图片 revision。
- `workflowStatus: recognized`。
- 请求中的受控 `candidateId`。
- 当前库存 `expectedInventoryVersion`。
- 候选所引用的审核营养快照身份。

确认时把候选克数合并到当前活动库存：相同 `foodId + nutritionSnapshotId` 累加克数，其他项目原样保留，结果按稳定键排序。新库存使用现有 `InventoryVersion` 结构和连续版本号。确认操作采用版本化 SHA-256 规范指纹；相同幂等键和相同载荷重放返回同一图片与库存版本，不增加版本数，不同载荷返回幂等键复用错误。

候选确认前，图片工作流事务不得修改：

- `inventories`
- `activeInventoryVersionId`
- `mealPlans`
- `dailyEnergyTargets`
- `dailyNutritionTargets`
- 任何重算任务或 outbox 事件

Provider 调用和营养快照加载均在事务外完成；事务内重新检查图片 revision、库存版本、账户状态和快照身份 token。并发变化时返回 `version_conflict`，不提交部分状态。

## 10. 原图清理与孤儿处理

创建上传会话时设置：

```text
deleteDueAt = uploadCreatedAt + 23 hours
nextCleanupAt = deleteDueAt
```

`photo-cleanup` 每 15 分钟触发一次，因此正常情况下在创建后 23–23.25 小时删除，为 24 小时上限保留至少三次调度机会。用户确认候选后将 `nextCleanupAt` 提前为当前时间，下一次调度即可删除；识别失败或未确认图片仍按原期限处理。

清理步骤：

1. 以 `nextPhotoCleanupAt <= now` 分页读取最多固定批量的用户目标。
2. 对每个用户只选每个 `photoId` 的最新 revision。
3. 使用创建会话时已保存的 `expectedPrivateFileId` 删除对象，不依赖登记请求是否成功。
4. CloudBase 返回成功或对象不存在时，事务内追加 `storageStatus: deleted` revision。
5. 删除失败时追加 `storageStatus: cleanup_failed` revision，仅保存稳定脱敏错误码，并把 `nextCleanupAt` 设置为 15 分钟后。
6. 如果对象删除成功但状态事务发生并发冲突，下一次删除把“对象不存在”视为成功并完成状态提交。

相同清理任务重复执行不得重复计数有效删除，也不得重新创建已删除对象。单个用户失败不能阻断其他用户；函数公共结果只返回扫描数、删除数、待重试数和失败用户数，不返回用户、图片、fileID 或路径。

COS 前缀生命周期规则可以作为管理员配置的灾难兜底，但不能作为 24 小时验收证据，因为按天生命周期执行可能晚于严格 24 小时。阶段五的主证明来自应用调度、派生 fileID、重试状态和幂等测试。

## 11. 持久化与迁移

CloudBase 聚合写入 schema v6。读取 schema v5 时只补：

```text
ingredientPhotoVersions: []
nextPhotoCleanupAt: null
```

迁移不得制造历史照片、候选、确认、fileID 或清理结果。v2–v4 继续按现有迁移链升级，再执行 v5→v6 结构迁移和统一不变量校验。

新增不变量至少验证：

- 图片 revision 连续、ID 唯一，且全部属于聚合可信用户。
- 同一 `photoId` 的路径、预期 fileID、媒体类型和上传创建时间不可在后续 revision 改变。
- 状态转换合法；已删除对象不能回到 retained。
- 标准候选 ID 唯一，置信度和字段范围合法。
- `confirmedCandidateId` 必须引用当前图片候选，`inventoryVersionId` 必须引用同用户存在的库存版本。
- 已确认 revision 与库存版本必须在同一提交中出现，且库存包含已确认的食材快照和克数。
- `nextPhotoCleanupAt` 与所有最新 revision 的派生最早时间一致。
- 幂等记录引用存在的图片或库存结果。

CloudBase 清理查询只返回内部可信调度目标；常规客户端仍被数据库规则完全拒绝直读。

## 12. 公共错误与脱敏观测

公共错误沿用或增加以下稳定类别：

- `invalid_request`
- `unauthenticated`
- `version_conflict`
- `idempotency_key_reused`
- `provider_unavailable`
- `storage_unavailable`
- `candidate_confirmation_required`

不存在、跨用户、路径不匹配和 fileID 不匹配统一映射为不暴露对象存在性的中文提示。供应商正文、存储签名 URL和 CloudBase 内部错误不得透传。

Provider 观察事件只允许：

```text
provider
requestId
attempt
latencyMs
status
stableErrorCode?
estimatedCostUnits?
```

清理观察只允许任务 ID、批次计数、耗时和稳定状态。禁止记录 OpenID、匿名散列前的 userId、fileID、cloudPath、Base64、临时 URL、提示词、候选名称、完整图片元数据或自由文本错误正文。测试以敏感哨兵值断言所有观察输出不包含上述数据。

## 13. 小程序页面

新增 `pages/ingredient-photo/index`，并从现有 `pages/meal-execution/index` 提供入口。页面职责限制为：

- 选择一张图片并显示本地预览。
- 串联创建会话、上传、登记和识别。
- 展示标准中文候选、估算置信度和 AI 候选标识。
- 要求用户选择候选并输入克数；不自动选中最高置信度候选。
- 显示上传、识别、确认和清理隐私说明。
- 供应商失败时支持重试、重新选图和跳转手动录入。

请求构造、恢复中的幂等命令和显示 view-model 使用独立纯 TypeScript 文件测试。控制器不自行生成标准食材 ID、营养值或 fileID，不在日志打印 `tempFilePath`。

## 14. 云函数与构建

新增独立工作区 `cloudfunctions/photo-cleanup`，使用与 `planning-api` 一致的 Node.js 20、严格 TypeScript、tsup 单文件制品和无运行时安装部署方式。

`cloudbaserc.json` 声明：

- `planning-api`：保持可信登录调用，超时调整为容纳两次受限视觉尝试。
- `photo-cleanup`：定时触发，拒绝普通客户端调用，每 15 分钟执行。

构建脚本必须为两个云函数生成 `.build/cloudfunctions/<name>` 制品，并拒绝缺少入口或 package 元数据的产物。增加 `dry-run:photo-cleanup`，验证制品能加载并在无到期目标时返回空汇总；常规测试和 dry-run 不访问实时云、存储或付费视觉服务。

## 15. 测试策略

所有生产行为按 RED → GREEN → REFACTOR 实现。

### 15.1 契约与 Provider

- 严格请求/响应 schema、额外字段拒绝、候选上限、置信度、名称和媒体范围。
- 超时只重试一次；schema 错误、鉴权错误不重试。
- 三个连续完整操作失败后熔断、60 秒半开探测和成功复位。
- 观察事件不含 fileID、路径、URL、Base64、用户标识、提示词或候选名。
- 生产模式不加载固定桩；未配置 Provider 明确降级。

### 15.2 应用与领域

- 创建、登记、识别、失败重试、确认的合法状态转换。
- 识别成功但确认前库存、营养目标、餐单和重算任务完全不变。
- 未识别候选、错误候选、零/负数/小数克数和过期 revision 被拒绝。
- 标准食材与营养快照身份映射；无审核来源不进入候选或库存。
- 确认原子追加图片和库存版本；同食材稳定合并。
- 响应丢失幂等重放、相同键不同载荷、并发库存或图片变化回滚。
- 跨用户 photoId/fileID 不可读取、识别、确认或清理。

### 15.3 持久化与清理

- schema v5→v6 纯结构迁移及 v2–v5 兼容链。
- 图片 revision、固定存储身份、确认引用和派生清理时间不变量。
- 已登记图片、未登记孤儿、对象不存在、删除失败、状态事务竞态和重复执行。
- 清理失败 15 分钟重试，单用户失败隔离和分页。
- 到期边界证明正常调度在创建后 24 小时前至少产生删除尝试。

### 15.4 API、小程序与端到端

- API 只使用可信身份，公共响应不泄露 fileID/path/userId。
- 创建→上传登记→识别→确认的公共 handler 时间线。
- 候选确认前库存计数不变，确认后只增加一个库存版本。
- 页面不自动选择候选、不估算克数，并在 Provider 失败时展示手动入口。
- 页面重启从公开上下文恢复候选与幂等命令。
- 构建产物包含新页面、存储规则和两个云函数，生产构建不包含测试桩。

## 16. 完成验证

阶段五完成前必须运行并记录：

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd dry-run:photo-cleanup
pnpm.cmd smoke:api
```

还必须检查 `git diff`、未跟踪文件、构建制品内容和敏感字符串扫描。`.pnpm-store/` 是既有未跟踪目录，不纳入提交。

微信开发者工具实际渲染、真机拍照上传、CloudBase 存储规则发布、定时触发器执行、两个真实微信身份的图片隔离、真实混元调用和内容标识合规无法由本地命令替代，必须作为外部未验证事项写入 `DEVELOPMENT_PROGRESS.md`，不得宣称 production ready。

## 17. 阶段验收映射

| `DEVELOPMENT_PROGRESS.md` 阶段五要求 | 设计证据 |
|---|---|
| 用户私有路径与最小权限 | 第 5 节、第 14 节 |
| `VisionProvider`、名称/置信度/标准食材映射 | 第 6、7 节 |
| 用户确认门禁 | 第 8、9 节 |
| 手动降级、超时、一次重试、熔断、脱敏观测 | 第 7、8、12 节 |
| 24 小时清理、失败重试、孤儿对象 | 第 10、11、14 节 |
| 确认、隔离、供应商、日志和清理测试 | 第 15、16 节 |

## 18. 明确不做

- 不根据图片估算重量、克数、热量或营养素。
- 不识别训练计划截图、人体、病症或药物。
- 不把原图、Base64、临时 URL 或供应商提示词写入数据库或日志。
- 不引入新的前端框架、数据库、常驻服务器或多 Agent。
- 不把测试 fixture 或未审核营养数据加载到生产模式。
- 不在本阶段实现开放式对话；有限单 Agent 对话属于阶段六。
- 不把 COS 按天生命周期结果当作应用 24 小时删除证明。

## 19. 平台依据

- CloudBase 云存储安全规则：<https://docs.cloudbase.net/storage/security-rules>
- CloudBase Node.js 服务端存储 API：<https://docs.cloudbase.net/api-reference/server/node-sdk/storage>
- 腾讯云 COS 生命周期配置元素：<https://cloud.tencent.com/document/product/436/17029>
