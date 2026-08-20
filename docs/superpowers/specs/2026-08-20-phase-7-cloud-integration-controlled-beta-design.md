# Phase 7 Cloud Integration and Controlled Beta Design

日期：2026-08-20

状态：用户已批准设计方向，等待书面规范复核

目标：把阶段三至六的完整 MVP 安全部署到受控 CloudBase 内测环境，使测试人员能够从微信小程序正常完成核心流程，并以可审计证据关闭隔离、数据权利、供应商降级、恢复、容量、隐私和发布门禁。

## 1. 背景与当前基线

阶段一至六已经在 `feat/v1.0` 上完成本地实现和自动化门禁。当前主线具备：

- 可信微信 OpenID、schema v7 单用户规划聚合和不可变版本历史；
- `calculation-policy-v2`、`nutrition-policy-v1` 和确定性训练/营养计算；
- 手动库存、七日餐单、锁定/手改保护、训练完成度和重算回滚；
- 私有食材图片、候选确认、24 小时内清理路径和 `VisionProvider` 韧性；
- 独立 `assistant-api`、固定 LangGraph.js 单 Agent、三项白名单命令和有界会话；
- planning、assistant、photo-cleanup 三个 CloudBase 部署制品及本地 smoke。

当前实现仍不能供受控内测人员正常完成完整流程：云端餐单 Provider 明确失败关闭，没有已授权的生产审核数据；没有个人数据查看/导出/删除入口；没有阶段七发布预检和证据闭环；真实 CloudBase、供应商、双账号、真机和外部审批均未关闭。当前工作站还没有真实 AppID 私有配置、CloudBase 环境配置或预先审核安装的 `tcb` CLI。这些事实是发布门禁，不会用 fixture、文档声明或本地测试替代。

## 2. 方案选择

### 2.1 采用：同一阶段完成代码就绪与真实受控发布

阶段七分为连续的两个工作面，但仍以一个阶段交付：

1. 在主线实现数据权利、生产审核数据读取、事务一致性加固、隐私/AI 标识和发布验证工具，并通过 fresh 本地全量门禁。
2. 在指定 CloudBase 内测环境完成真实部署、两个微信身份、供应商/故障、备份恢复、容量、真机和合规证据；只有全部核心门禁及外部审批关闭才更新为“受控内测已发布”。

这能让代码证据和真实控制面证据各自可追溯，也不会把“本地可构建”误报为“测试人员可用”。

### 2.2 不采用：只完成本地代码

只增加页面、脚本和测试不能证明 CloudBase 规则、真实身份、供应商、定时器、设备或恢复有效，不满足阶段七退出条件。

### 2.3 不采用：向测试人员开放 fixture 模式

生产部署制品继续禁止测试身份、测试餐单、测试营养和本地模型路径。把 fixture 暴露给其他测试人员会破坏来源、授权、数值追溯和生产边界，不能作为受控内测降级方案。

## 3. 总体架构

```text
微信小程序
  ├─ 规划/餐单/图片/助手现有页面
  ├─ 隐私说明页
  └─ 个人数据页（查看、更正入口、导出、删除）
        ↓ 严格运行时合同 + 可信云函数身份
planning-api / assistant-api
  ├─ 现有公开应用服务
  ├─ PersonalDataService
  ├─ AccountDeletionGuardedRepository
  └─ 同事务助手摘要投影
        ↓
CloudBase
  ├─ planning_user_states（schema v8）
  ├─ planning_reviewed_datasets（只读审核数据集）
  └─ 用户私有 ingredient-photos/

管理员发布路径（不向客户端暴露）
  ├─ 审核数据集离线验证/校验和
  ├─ release:check / release:preflight
  ├─ CloudBase 备份、索引、规则、IAM、函数和定时器
  └─ 匿名化阶段七证据矩阵
```

依赖方向保持“小程序 → 云函数/API → 应用服务 → 领域/计算 → Provider → CloudBase/供应商适配器”。`domain` 和 `calculation` 不导入 CloudBase、模型或供应商 SDK。个人数据服务只依赖应用层仓库和私有文件删除接口；Agent 仍不能直接访问数据库。

## 4. schema v8 与账户删除状态

### 4.1 新字段

`PlanningAggregateState` 增加唯一的内部字段：

```ts
interface PendingAccountDeletion {
  readonly status: 'pending';
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly snapshotToken: string;
  readonly requestedAt: string;
  readonly privateFileIds: readonly string[];
}

interface PlanningAggregateState {
  // 既有 schema v7 字段
  readonly accountDeletion: PendingAccountDeletion | null;
}
```

v2–v7 迁移只补 `accountDeletion: null`，不推断历史删除、身份、照片、会话或业务事实。schema v8 文档仍由服务端保存可信 `state.userId`，但成功完成账户删除后整个 `planning_user_states` 文档会被事务删除，不保留用户 ID、业务内容或删除回执。

### 4.2 删除专用仓库能力

普通 `PlanningRepository` 继续只暴露 `read` 和 `transact`。新增只注入 `PersonalDataService` 的 `PersonalDataRepository`：

```ts
interface PersonalDataRepository extends PlanningRepository {
  readExisting(userId: string): Promise<PlanningAggregateState | null>;
  deleteExisting<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => TResult
  ): Promise<TResult>;
}
```

CloudBase 实现使用服务端单文档事务的删除操作；内存实现删除对应 map 项。普通规划、图片和助手服务获得一个 guard 包装器：当 `accountDeletion` 为 pending 时，普通读写均返回稳定的 `account_deletion_pending`，只有个人数据页的删除重试和状态读取可以继续。外部存储删除永远不在数据库事务内执行。

### 4.3 账户快照令牌

个人数据摘要返回一个不透明的 `snapshotToken`。它是服务端对当前规范化聚合（排除 `accountDeletion`）计算的 SHA-256，不暴露 OpenID、私有路径或内部记录。删除命令必须携带该令牌、幂等键、确认常量和用户输入的中文确认短语。

如果数据在确认和删除间发生变化，令牌不匹配并返回 `version_conflict`。成功删除文档后，响应丢失重试会得到 `already_absent` 幂等成功；如果用户随后重新建档，新的聚合令牌与旧请求不同，旧删除请求只能得到冲突，不能删除重建账户。

## 5. 个人数据能力

### 5.1 API 合同

`planning-api` 新增三个已认证动作：

- `getPersonalDataSummary`：返回数据是否存在、当前活动版本号、历史计数、会话消息数、照片数、`snapshotToken` 和是否有 pending 删除；不返回身份和私有定位符。
- `exportPersonalData`：要求当前 `snapshotToken`，返回严格 `PersonalDataExportV1` 结构。
- `deleteAccount`：要求 `snapshotToken`、幂等键、`confirmation: 'DELETE_MY_ACCOUNT'`，并由页面另行校验用户输入“删除我的账户”。

响应继续使用可穷举成功/失败联合类型。新增稳定错误包括 `account_deletion_pending`、`personal_data_snapshot_conflict` 和 `account_capacity_exceeded`；错误文本不泄露其他身份或对象是否存在。受支持的新聚合必须在写入预算内，因此正常数据权利流程不能用“导出过大”拒绝用户；部署前容量测试负责证明该不变量。

### 5.2 白名单式导出

导出通过显式 DTO 投影构建，禁止用 JSON replacer 黑名单删除字段。导出包括用户提供的档案/偏好、目标、训练、完成事实、营养目标、库存、餐单、差异/决定、图片候选与确认状态、助手消息和必要版本关系；不包括：

- `userId`、OpenID 或数据库文档 ID；
- `expectedCloudPath`、`expectedPrivateFileId`、临时 URL 或供应商原始响应；
- 幂等记录、pending turn、请求指纹、Provider 请求 ID、内部错误正文或秘密；
- 跨用户或管理员数据。

导出顶层包含 schema 版本、导出时间、策略/数据集版本和显式 AI 内容说明。每条助手消息与视觉候选标记 `contentOrigin: 'user' | 'ai_assisted' | 'deterministic'`，确保导出文件仍能识别 AI 辅助内容。

为保证同步云函数 6 MB 响应上限内可导出，schema v8 写入在序列化后执行 `3_000_000` UTF-8 字节的应用级聚合预算。超过预算的普通写入失败关闭，但读取、导出和删除仍可执行。该预算低于 CloudBase 16 MB 数据库单次出包/文档上限，为响应封装、UTF-8 和 JSON 开销保留余量；容量测试必须证明最大允许聚合的导出仍低于实际 6 MB 响应限制。任何既有超预算文档都进入管理员受控导出/迁移流程，不能静默裁剪历史。

### 5.3 删除状态机

删除严格执行：

1. 事务读取现有聚合，验证确认、快照令牌、幂等键和当前无其他 pending 删除。
2. 从全部图片历史中去重收集所有 `expectedPrivateFileId`，写入 pending 删除；此后 guard 阻止规划、图片和助手读写。
3. 事务外逐一删除私有文件；`deleted` 和 `not_found` 都收敛为成功，任何其他失败保留完整聚合和 pending 请求，供同一命令重试。
4. 文件全部收敛后，数据库事务重新验证 pending 指纹和快照令牌，再删除整个聚合文档。
5. 数据库删除失败时不伪报成功；重试会安全重复 `not_found` 文件删除。数据库删除成功但响应丢失时，重试返回 `already_absent`。

删除清除身体档案、目标、训练、完成事实、营养、库存、餐单、重算、outbox、图片历史、助手消息/摘要/pending/回执和所有派生数据。不存在后台静默保留的业务 tombstone。

## 6. 小程序隐私与数据权利体验

新增：

- `pages/privacy/index`：展示适用人群、处理数据与目的、最小化健康确认、照片和会话保留、外部 Provider、估算/非医疗边界、AI 标识方式、导出/删除和内测联系信息。
- `pages/data-rights/index`：查看当前版本摘要；链接到现有规划页以保存新版本完成更正；生成并分享 JSON 导出；通过文本确认和系统二次 modal 永久删除。

规划、餐单、图片和助手页都提供隐私/个人数据入口。助手响应和视觉候选使用用户可感知的“AI 辅助”标识；确定性数值继续标注“估算”，不把确定性计算错误标成模型生成。页面删除成功后清理本地 pending 命令、库存工作流、助手恢复和图片草稿缓存，再回到空账户状态。

内测发布构建必须注入三个公开而非秘密的值：运营主体名称、隐私联系渠道和隐私说明版本。普通本地构建使用明确的“仅限本地开发、不得发布”占位状态；`release:preflight` 在任何值缺失时失败。真实值不必作为秘密处理，但只进入受控发布制品和微信平台材料，仓库不虚构运营主体。

## 7. 生产审核餐单数据

### 7.1 CloudBase 数据集

新增服务端只读集合 `planning_reviewed_datasets`。活动文档由环境变量 `FITNESS_REVIEWED_DATASET_ID` 精确选择，不提供默认值。严格 `ReviewedPlanningDatasetV1` 包含：

- 数据集 ID/版本、schema 版本、状态 `approved`、激活/审核时间和 SHA-256；
- 来源 ID、供应商/正式表格记录 ID、原始单位和食物状态；
- 授权证据引用、允许的缓存/展示用途、到期时间或无到期依据、退出处理状态；
- 已审核营养快照、食谱模板、七个日菜单和活动目录的完整闭合版本图。

授权证据引用只保存受控证据系统中的不透明编号，不把合同、密钥或个人信息提交仓库。

### 7.2 运行时 Provider

`CloudBaseReviewedPlanningDataProvider` 在冷实例首次使用时读取精确文档，执行现有 nutrition/recipe/menu schema、生产 `qualityStatus: 'reviewed'`、闭合引用图、许可状态和整体校验和验证，再以只读 promise 缓存。每次对外读取仍按当前服务端时间复核授权/缓存期限，不能因为温实例缓存跨过许可到期点。读取超时、数据库失败、非法 schema、过期许可、校验和或引用链错误均失败关闭；不会使用 fixture、旧猜测值或模型补齐。

CloudBase 读取是已审核缓存，不在用户请求中实时调用外部营养供应商。供应商获取/更新属于发布时离线流程：新数据集先在隔离环境校验和人工审核，完整成功后再切换 `FITNESS_REVIEWED_DATASET_ID`；失败时旧活动数据集继续有效。供应商超时、费用和退出演练验证“无法获取新版本不影响当前审核缓存；当前缓存授权失效则停止新餐单生成”。

提供离线验证命令读取管理员指定的本地 JSON，输出严格校验结果、记录计数和校验和到忽略的 `.build/release-evidence`；它不联网、不导入、不打印营养合同或真实路径。实际数据导入、授权审批和活动 ID 切换由管理员在目标环境完成。

## 8. 助手摘要一致性加固

阶段六的摘要在 finalize 事务前读取规划上下文，存在极短的并发落后一版窗口。阶段七把摘要所需的训练周、训练版本、餐单版本和菜名投影改为从 finalize 事务已锁定的当前聚合直接派生：

- 领域命令完成后，finalize 事务读取最新权威 state；
- 同一事务验证 pending turn、生成摘要、追加消息/回执并清除 pending；
- 不在事务中访问 Provider、网络或其他集合；
- 并发规划写要么先完成并被摘要看到，要么在 finalize 后形成更高版本，不再产生“摘要声称已包含但实际读取旧 state”的窗口。

摘要仍不参与领域授权、数值或版本判定。

## 9. 发布验证工具

根工作区新增以下命令，均不安装新框架或运行实时付费 API：

- `release:check`：顺序运行配置静态检查、lint、类型检查、全量测试、构建、三个 dry-run、两个进程 smoke、秘密扫描、敏感日志扫描、制品边界和 `git diff --check`。
- `release:dataset`：验证管理员指定的审核数据集并生成匿名校验摘要。
- `release:capacity`：对真实本地函数进程执行最大允许聚合导出、并发身份隔离、重算回滚和幂等负载；输出计数、延迟分位和失败码，不输出请求正文。
- `release:preflight`：要求真实 AppID 私有配置、目标环境选择、固定审核版 `tcb`、三个公开隐私值、全部服务端配置名和数据集证据存在；只打印 present/missing 和版本，不打印值。

脚本使用行为测试：在临时 fixture 目录运行并断言退出码、输出和副作用，不能只 grep 脚本文本。所有证据输出位于忽略的 `.build/release-evidence/`，包含基线 commit、制品 SHA-256、命令、开始/结束时间、退出码和匿名统计；不包含环境 ID、AppID、OpenID、fileID、消息、身体数据、密钥或供应商正文。

## 10. CloudBase 发布顺序

真实受控发布固定按以下顺序执行：

1. 复核目标账号、AppID、CloudBase 环境和测试身份；保存当前函数、规则、IAM、索引、触发器、环境配置和制品校验值到受控证据系统。
2. 运行 fresh `release:check`、`release:dataset` 和 `release:preflight`；任一失败停止。
3. 备份 `planning_user_states` 和既有审核数据；确认 schema v6/v7 可信 `state.userId`、图片清理连续性及复合索引。
4. 导入并复核 `planning_reviewed_datasets`，但暂不切换活动 ID。
5. 发布数据库/函数/存储规则和最小 IAM；数据库及审核数据集合继续拒绝客户端直读写，普通客户端不能调用清理函数。
6. 先部署 v8-aware `photo-cleanup`，再部署 v2–v8 可读、v8 写入的 `planning-api`，最后部署 v8-aware `assistant-api`；逐一核对 Node.js 20、入口、超时、状态和制品校验值。
7. 配置存储、视觉、LLM 和审核数据集环境变量，验证单一显式 Provider、配额和日志字段；再切换活动数据集。
8. 在规则、索引、early-v6 检查和单次清理通过后启用 15 分钟图片清理定时器，避免任何清理空窗。
9. 构建包含真实公开隐私信息的 cloud-mode 小程序，上传为受控体验版本，只添加批准的测试人员。
10. 完成下述真实验收和故障演练；任何核心门禁失败先隐藏入口或回滚，不扩大测试范围。

函数安全规则只约束客户端调用，不替代管理端、定时器和嵌套函数 IAM 验证。数据库回档恢复到新集合，不直接覆盖活动集合；管理员先比较 schema、数量、校验和和匿名样本关系，再决定受控切换或向前修复。

## 11. 测试人员验收场景

两个真实微信身份 A/B 都从空账户开始，使用非真实、非敏感的受控测试输入。必须记录以下结果：

1. A/B 分别完成“档案/偏好 → 目标 → 一周训练 → 每日营养目标 → 审核库存 → 七日餐单 → 执行反馈”。
2. 移动训练日保持整周训练消耗守恒，只改变受影响未来日期；过去事实和锁定/手改日不被静默覆盖。
3. 手动库存可在视觉/模型不可用时完成核心流程；照片候选未确认不写库存，确认和清理符合门禁。
4. 三项助手命令只走公开确定性应用服务；非法模型输出、超时、一次重试、熔断和恢复不改坏计划。
5. A/B 互相不能读取、写入、导出、识别、删除或推断对方数据库、图片、会话、摘要和派生计划。
6. A 的导出只包含 A 的白名单数据和 AI 标识；更正创建新版本；删除失败可重试，成功后 A 的文档、图片、会话和派生数据均不存在，B 完全不变。
7. 网络中断、响应丢失、旧版本、重复幂等键、Provider 失败和重算失败均给出可恢复状态，旧活动计划在新版本完整成功前继续有效。
8. 微信开发者工具与至少一台物理设备验证页面渲染、隐私入口、分享导出、相机/相册、助手恢复和账户删除后的本地缓存清理。

验收记录只使用 `tester-A`、`tester-B` 和场景编号；不得记录真实 OpenID、自由文本、身体档案、fileID、图片、环境 ID 或供应商正文。

## 12. 故障、费用、容量和恢复演练

### 12.1 Provider 与降级

- LLM：隔离演练环境验证非法 schema、受控修复一次、20 秒传输超时、一次重试、三次完整失败熔断、半开和单 Provider；模型关闭时结构化规划继续可用。
- Vision：验证 8 秒超时、一次重试、熔断、非法候选、手动录入和不记录 fileID/正文。
- Nutrition：阻断新数据集获取/导入时旧审核缓存继续有效；活动数据集缺失、过期许可或来源链断裂时新库存解析/餐单失败关闭，不退回 fixture。
- 每类观察只记录 Provider/模型或数据集版本、请求 ID、attempt、延迟、状态、固定错误码和费用/token 单位；建立内测预算和告警，不采集请求正文。

### 12.2 容量

本地容量门禁覆盖 3,000,000 字节聚合、最大导出和并发隔离。真实内测环境以 10 个并发测试身份、每个 30 次混合结构化操作为最低演练负载：

- planning 非 Provider 请求成功率 100%，p95 小于 5 秒；
- 没有跨用户数据、部分事务、重复有效版本或清理队列丢失；
- Provider 请求均在各自受控超时内返回成功或固定降级；
- CloudBase 配额、并发、数据库出包、函数响应和费用没有越界。

实际结果和套餐配额写入受控证据；未达到阈值不得扩大测试人员。

### 12.3 备份与恢复

在测试数据备份点执行一次 `planning_user_states` 和审核数据集回档，恢复到新集合。比较：

- 文档数量、schema 版本、活动指针、历史计数、数据集 SHA-256；
- A/B 隔离、图片清理 deadline、pending 删除和助手 pending/回执；
- 恢复点、恢复耗时和备份保留窗口。

恢复集合不得直接接管流量。若备份包含已过删除 deadline 的原图引用，恢复演练必须立即按原 deadline 清理，不得因备份延长保留时间。

## 13. 安全、隐私与合规门禁

- 真实秘密只进入 CloudBase 密钥/Provider 配置；小程序包、仓库、命令行和证据不得出现。
- 公开隐私说明、微信隐私保护指引、运营主体、联系渠道、数据保存期限和第三方清单必须一致。
- 助手和视觉结果提供用户可感知的 AI 辅助标识；导出文件保留生成合成内容说明。发布材料记录适用的模型备案/登记、生成合成内容标识和平台审核证据。
- 正式 `CN-DRI-2023` 表格逐项复核必须记录表号/页码、审核人和日期；差异通过新策略版本处理，不改写历史。
- 营养数据来源、商业授权、缓存/派生/展示权限、署名、期限和退出方案必须有可审计书面证据。
- 产品继续只服务健康成年人；疾病、孕哺、未成年人、康复、进食障碍和极端目标停止个性化建议。

代码无法替代上述人工复核和外部审批。任一项未关闭时可以记录“代码就绪、外部门禁未通过”，但阶段七不能标记完成或发布。

## 14. 回滚

1. 先停止新增测试人员并隐藏有问题的入口；结构化核心可在模型入口关闭时继续保留。
2. 始终保持一个 v8-aware 图片清理 worker，任何回滚都不能制造原图清理空窗。
3. 只回滚到能读取并原样保留 schema v8 `accountDeletion` 的制品；不能用 v7 制品覆盖已写 v8 的环境。
4. 审核数据集切换失败时恢复上一活动 ID，不改写已引用旧版本的历史计划。
5. pending 账户删除期间不得回滚到绕过 guard 的制品；先让同一命令完成或部署向前修复。
6. 数据库恢复先进入新集合并比较，禁止直接覆盖活动集合或复活已删除用户/过期原图。
7. 回滚后重新执行函数 detail、规则/IAM、双账号隔离、导出/删除、Provider 降级、图片清理和 smoke。

## 15. 自动化测试范围

实现严格遵循 RED → GREEN → REFACTOR，至少覆盖：

- schema v2–v7 → v8 迁移、v8 往返、超预算失败和旧历史不伪造；
- 导出白名单、AI 标识、身份/fileID/幂等/pending/供应商正文排除和 6 MB 预算；
- 删除确认、快照冲突、幂等重放、响应丢失、存储部分失败、`not_found`、数据库失败、重建账户旧请求和跨用户隔离；
- pending 删除期间所有 planning/photo/assistant 读写门禁；
- 审核数据集 schema、许可、校验和、闭合图、冷实例缓存、缺失/超时/非法/过期和 fixture 排除；
- 助手摘要与同事务权威 planning state；
- 数据权利/隐私页面表单、二次确认、本地导出、缓存清理、AI/非医疗文案和恢复状态；
- 发布脚本在临时目录的真实退出码、制品、秘密/日志检测、环境值不泄露和容量结果；
- 真实 handler E2E 的两个身份、完整数据权利和原有阶段三至六回归。

最终本地门禁必须 fresh 运行：

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
pnpm.cmd release:check
git diff --check
```

## 16. 完成判定

阶段七只有在以下证据同时存在时完成：

- 所有设计内代码、页面、脚本和文档进入 `feat/v1.0`；
- 全量本地门禁 fresh 通过，无真实秘密、敏感 fixture、用户数据或未授权素材；
- 目标 CloudBase 的三函数、规则、IAM、索引、定时器、审核数据和环境配置实际生效；
- 两个真实微信身份、微信开发者工具和物理设备完成全部核心流程、隔离、导出和删除；
- Provider 故障、日志/费用、容量、重算回滚、备份恢复和图片清理演练通过；
- 正式营养常量/数据授权、隐私材料、运营信息、模型合规和 AI 内容标识审批关闭；
- `DEVELOPMENT_PROGRESS.md` 记录提交、命令结果、匿名外部证据、剩余工作和阻塞，把阶段状态更新为“已完成”，并把当前结论写为“受控内测已发布”。

任何外部证据缺失时保持“进行中”，不以本地测试或文档替代。

## 17. 发布依据

- [CloudBase 系统限制](https://cloud.tencent.com/document/product/876/47177)：同步云函数事件/响应 6 MB、数据库单次出包 16 MB 等发布容量边界；实际目标环境仍以控制台当前配额为准。
- [CloudBase 服务端事务](https://docs.cloudbase.net/database/transaction)：服务端单文档事务、事务删除以及禁止在事务内执行外部调用。
- [CloudBase 云函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)：函数规则只约束客户端调用，管理端、定时器和数据库触发器需另行控制。
- [CloudBase 数据库回档](https://docs.cloudbase.net/database/backup)：回档生成新集合，发布演练不得直接覆盖活动集合。
- [人工智能生成合成内容标识办法](https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm)：交互界面和导出内容的显式/隐式标识及服务协议说明要求；具体适用性和平台材料由发布负责人完成合规复核。
