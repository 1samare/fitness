# Fitness 开发进度清单

> 唯一动态进度真源
> 固定开发分支：`feat/v1.0`
> 统一分支起始代码基线：`0401d5f`（阶段二验收完成）
> 最近更新：2026-08-26

本清单依据已批准的 12 周受控内测 MVP 路线图整理。`README.md` 和历史计划负责描述产品、架构与阶段目标，本文件只维护当前开发状态、验收证据和下一步工作。

## 维护规则

- 状态只使用：`未开始`、`进行中`、`已完成`、`阻塞`。
- 开发前依次读取 `AGENTS.md`、`README.md` 和本文件，确认当前分支为 `feat/v1.0`，并核对当前阶段的待办与退出条件。
- 阶段开始时把状态改为“进行中”；阶段完成后在同一变更中更新验收项、验证命令与结果、剩余工作、外部阻塞、下一阶段和更新记录。
- 只有代码已进入 `feat/v1.0`，且相关 lint、类型检查、测试和构建真实通过，验收项才能勾选或阶段才能标记为“已完成”。
- 计划、代码和本清单不一致时，先检查 Git 历史和当前实现，再修正本清单；不得根据历史分支或模型推断直接提高完成度。
- 任何产品、计算、架构或供应商边界变更仍须遵守 `AGENTS.md` 的 ADR、用户确认与测试要求。

## 总览

| 阶段 | 周期 | 状态 | 当前结论 |
|---|---:|---|---|
| 1. 本地纵向切片 | 第 1–2 周 | 已完成 | 本地规划 API、严格契约、确定性能量预览和小程序入口已实现并验证 |
| 2. 身份、持久化与版本基础 | 第 3–4 周 | 已完成 | 可信微信身份、原子建档、不可变版本、CloudBase 持久化和双账号隔离验收已完成 |
| 3. 营养计算与审核数据 | 第 5–6 周 | 已完成 | 确定性营养目标、约束冲突、审核数据边界、离线 Provider 和版本化每日营养目标已实现并验证 |
| 4. 一周餐单与联动闭环 | 第 7–8 周 | 已完成 | 手动库存、确定性七天餐单、锁定/手改保护、训练变更与完成度重算闭环已实现并验证 |
| 5. 食材图片与 Provider | 第 9 周 | 已完成 | 私有上传、受控候选、明确确认、Provider 韧性、原图清理和本地端到端证据已进入 `feat/v1.0` 并通过 fresh 主线门禁；真实云/Provider/设备仍是外部门禁 |
| 6. 单 Agent 有限对话 | 第 10 周 | 已完成 | 固定单图、三项白名单命令、有界会话、混元/DeepSeek 显式接入、恢复与降级均已进入 `feat/v1.0` 并通过 fresh 主线门禁和独立复审 |
| 7. 本地优先 Web 重构与内部测试交付 | 重构阶段 | 进行中 | 已批准完全放弃小程序/CloudBase、空本地数据库和虚拟数据测试方向；7W-0 书面规格与 ADR 已起草，详细实施计划及 7W-1 至 7W-6 尚未开始 |

## 当前阶段

- 当前阶段：阶段 7“本地优先 Web 重构与内部测试交付”（进行中）。
- 开发入口：项目负责人已批准完全放弃微信小程序与 CloudBase 运行方向，保留阶段一至六已验证的领域、计算、应用、Agent 和合同核心；最多五名测试人员从空 IndexedDB 开始，只使用虚拟身体数据和显式 `test_fixture` 营养数据。架构决策为 `docs/decisions/ADR-0001-local-first-web-test-application.md`，书面规格为 `docs/superpowers/specs/2026-08-26-local-first-web-test-app-design.md`。当前处于 7W-0，等待书面规格复核和详细 TDD 实施计划；在此之前不得安装 Web 框架或修改业务运行代码。

## 生产上线前待办

以下事项不阻塞严格个人本地自用、功能开发或已完成阶段的验收，但在向其他用户开放（包括免费内测或公开发布）或用于商业用途前必须关闭。个人自用仍须遵守数据供应商服务协议，不因非商业用途自动获得复制或缓存权。

- [ ] 依据《中国居民膳食营养素参考摄入量（2023 版）》正式表格，逐项复核生产策略常量、适用人群、单位和口径；记录表号/页码、审核人和审核日期。发现差异时新增策略版本及迁移说明，不改写历史计划。
- [ ] 确认生产营养数据的来源链、使用授权、缓存范围与期限、派生计算和终端展示权限、署名要求、服务终止后的数据保留/删除规则及供应商退出方案，并保存可审计的书面证据。

## 阶段 1：本地纵向切片

**状态：已完成**

### 验收清单

- [x] 建立 pnpm 工作区、严格 TypeScript、跨端运行时契约和分层目录。
- [x] 实现 `calculation-policy-v2` 适用范围门禁、BMR/PAL/训练净消耗、来源追溯和统一舍入。
- [x] 实现 `planning-api` 健康检查与每日能量预览，并支持 CloudBase 兼容本地加载。
- [x] 实现微信原生小程序能量预览表单及受支持/不支持结果展示。
- [x] lint、类型检查、单元测试、构建、函数加载和 HTTP 冒烟通过。

### 代码与验证证据

- 第一阶段完成点：`c210171`，已是 `feat/v1.0` 的祖先。
- 设计与实施依据：`docs/superpowers/specs/2026-07-30-local-runnable-architecture-design.md`、`docs/superpowers/plans/2026-07-30-local-runnable-architecture.md`。
- 2026-08-10 在阶段二完成基线上复核：lint、类型检查、24 个测试文件共 135 项测试、构建、函数 dry-run 和 API 冒烟通过。

### 剩余工作

- 无阶段一代码剩余项；后续发布候选仍需在目标微信开发者工具和设备上重复人工交互验收。

### 外部阻塞

- 无代码阻塞。微信 IDE/设备实际渲染与交互证据不能由自动化命令替代，应在阶段七发布门禁中重新记录。

## 阶段 2：身份、持久化与版本基础

**状态：已完成**

### 验收清单

- [x] 使用云函数运行时 OpenID 建立可信身份，客户端不提供可信 `userId`。
- [x] 原子保存身体档案、目标、一周训练计划、每日目标和 `TrainingPlanChanged` outbox 事件。
- [x] 实现不可变版本链、活动指针失效规则、预期版本冲突和版本历史计数。
- [x] 实现版本化 SHA-256 幂等指纹、响应丢失重试和重复请求结果复用。
- [x] 实现严格业务日期、目标周期和只影响未来变更日期的确定性重算。
- [x] 实现 CloudBase schema v2 聚合校验、事务持久化、客户端拒绝直读规则和可部署函数制品。
- [x] 实现 0–7 天结构化周训练表单和可恢复的一次性建档提交。
- [x] 完成 CloudBase 开发环境部署、规则发布、账号 A 行为验收和账号 A/B 数据隔离验收。

### 代码与验证证据

- 阶段二完成点：`0401d5f`，是 `feat/v1.0` 的创建基线。
- 设计、实施和云端验收依据：`docs/superpowers/specs/2026-08-07-phase-2-hardening-design.md`、`docs/superpowers/plans/2026-08-07-phase-2-hardening.md`、`docs/cloudbase/phase-2-deployment.md`。
- 2026-08-10 本地复核：lint、严格类型检查、24 个测试文件共 135 项测试、CloudBase 部署构建、函数 dry-run、本地小程序构建和 API 冒烟通过。

### 剩余工作

- 无阶段二代码剩余项。后续重新部署时必须按阶段二部署文档复验环境、规则和双账号隔离。

### 外部阻塞

- 无当前阶段阻塞；真实 AppID、环境 ID 和验收记录继续只保存在受控本地环境，不进入仓库。

## 阶段 3：营养计算与审核数据

**状态：已完成**

### 验收清单

- [x] 实现蛋白质分支、脂肪与饱和脂肪、碳水、纤维和添加糖确定性规则。
- [x] 实现多约束求解与 `nutrition_constraints_infeasible` 结构化冲突原因。
- [x] 建立版本化动作库、审核会话级 MET 映射和客户端禁止提交 MET 的完整门禁。
- [x] 建立带来源、原始单位、食物状态、版本和审核时间的营养快照与食谱模板。
- [x] 定义 `NutritionProvider` 接口；计算只使用审核缓存或 fixture，不访问实时付费 API。
- [x] 覆盖营养边界、蛋白质分支、来源断裂、过敏原属性和无解场景测试。

### 代码与验证证据

- 实施计划：`docs/superpowers/plans/2026-08-10-phase-3-nutrition-reviewed-data.md`。
- 实现提交：`86bb34b`（确定性营养目标）、`13d172e`（食谱候选约束）、`8ee5a1d`（离线审核营养端口）、`1464b51`（动作与 MET 目录）、`d727563`（每日营养目标版本链和 API/小程序接入）。
- `nutrition-policy-v1` 只从版本化策略对象读取常量；每日营养目标精确引用身体档案、目标、训练计划和每日能量目标版本。CloudBase 聚合写入 schema v3；读取 schema v2 时仅补空营养版本集合，不伪造历史结果。
- 2026-08-10 本地验收：`pnpm.cmd lint`、`pnpm.cmd typecheck`、`pnpm.cmd test`（32 个测试文件、184 项测试）、`pnpm.cmd build`、`pnpm.cmd dry-run:api` 和 `pnpm.cmd smoke:api`（1 项真实函数进程冒烟）全部通过。

### 剩余工作

- 无阶段三代码剩余项。真实营养供应商数据仍不得在来源、授权、缓存许可和人工审核关闭前进入生产缓存；食材库存与一周餐单属于阶段四。

### 外部阻塞

- `CN-DRI-2023` 正式表格复核及营养数据授权/缓存许可已集中列入“生产上线前待办”；不阻塞阶段三完成或严格个人本地自用。
- 当前 fixture 明确标记为测试数据，生产模式会拒绝使用。

## 阶段 4：一周餐单与联动闭环

**状态：已完成**

### 验收清单

- [x] 实现手动食材库存、一周餐单版本和营养汇总复算。
- [x] 实现餐单锁定、手动修改、差异待确认和禁止后台静默覆盖。
- [x] 持久化训练完成度事件，并消费 `TrainingPlanChanged` 执行受影响日期分析。
- [x] 实现新营养目标、未锁定餐单新版本、锁定餐单差异和完整成功后激活的重算链路。
- [x] 覆盖移动、取消、增减时长、降低完成度、过去事实、整周守恒、幂等和失败回滚测试。

### 代码与验证证据

- 设计与计划：`docs/superpowers/specs/2026-08-10-phase-4-weekly-meal-loop-design.md`、`docs/superpowers/plans/2026-08-10-phase-4-weekly-meal-loop.md`。
- 任务 1–7 实现及加固提交：`3fe7261`、`0eb1a29`、`963280a`、`ecd5316`、`ba3611c`、`268eff9`、`fbbc0ca`、`797ace0`、`2b979fc`、`8a0c780`、`8338249`、`bea9130`、`b4fff46`、`dbf44df`、`1ee23ef`、`b718cf0`、`4c3e2af`、`da66233`、`25c98c6`、`7d35c1f`、`9668f3f`、`8090b51`、`4caebf0`、`1e7dc3c`；端到端验收、本地可行 fixture、进程烟雾与文档提交为 `ff06b2a`（`test: complete weekly meal loop acceptance`），随后以 `fix: version balanced meal fixtures` 将均衡营养快照、食谱、每日菜单和目录迁移到完全独立且闭合的稳定身份/来源版本图。
- 最终全阶段审查修复：库存幂等在 Provider 离线时使用规范化名称/合并行/精确克数的 provider-independent 指纹提前重放；公开无解冲突采用严格 discriminated schema，由 application 只映射审核中文名并在 handler 脱敏；连续训练变更只暴露和接受唯一匹配当前训练链且直接 supersede 活动餐单的候选；完整 Provider 图 canonical digest 覆盖菜单引用、食谱克数、过敏原和营养值，并在生成、手改、重算三路径事务外二次 load；未来训练完成使用独立 `future_completion_forbidden` 公共错误和正确恢复文案。
- 最终审查 Round 2 修复：同一训练计划的连续完成事实只允许最新 trigger job 对应、受影响日期引用 authoritative latest target 的候选进入 context/keep/overwrite；`RecalculationJob` 以严格脱敏 conflict snapshot 持久化确定性无解详情，CloudBase schema v5 将旧 v4 缺字段作 `legacy_unavailable` 迁移，training-plan/completion/context/retry 和小程序恢复均保留可操作原因；库存 raw canonical 指纹升级为 v3，并对旧 resolved/raw v2 仅在 Provider 可用时验证重放，离线安全失败。
- 最终审查 Round 3 修复：同一 active training/date 的 completion A 失败后，即使通过合法 `saveInventory` 恢复库存并由 completion B 成功激活新餐单，历史 failed job A 也不会重新出现在 context 或被重试；context、retry 初读、Provider 后事务重检与 pending candidate 共用唯一且最新的 active-training-chain job 选择，旧 A 返回稳定 `candidate_not_pending`、不调用 Provider 且不产生部分写，completed 自身 job 的 response-loss 幂等重放保持可用。
- 验收项 1 由 `packages/application/src/meal-plan-generation.test.ts`、`packages/calculation/src/generate-weekly-meal-plan.test.ts`、`tests/e2e/weekly-meal-loop.test.ts` 以及当前 schema-v5 库存/餐单版本实现证明；E2E 对七天的每个显示营养汇总都从每 100 克快照和实际克数独立复算。
- 验收项 2 由 `packages/application/src/meal-plan-editing.test.ts`、`packages/application/src/meal-plan-recalculation.test.ts`、`miniprogram/pages/meal-execution/*.test.ts` 及 E2E 的主动锁定、手改自动锁定、stale/候选/差异、保留/覆盖证明。
- 验收项 3 由 `packages/application/src/meal-plan-recalculation.test.ts`、`cloudfunctions/planning-api/src/handler.test.ts` 及 E2E 的 `TrainingPlanChanged` 消费、当天完成度事实和精确 event-linked 目标证明。
- 验收项 4 由重算生命周期、Provider 失败/重试/并发测试和 E2E 证明：旧活动餐单在完整候选成功前保留，未锁定结果或用户明确覆盖后才原子切换。
- 验收项 5 由 `packages/application/src/meal-plan-recalculation.test.ts` 的移动/取消/时长/完成度/过去事实/守恒/幂等/回滚用例和 E2E 的完整公共 handler 时间线证明。
- 2026-08-11 Round 1 修复后文档前 fresh 验收：`pnpm.cmd lint` 退出 0；`pnpm.cmd typecheck` 完成 10/11 个工作区项目及小程序严格检查；`pnpm.cmd test` 通过 43 个测试文件、492 项测试（其中阶段四 E2E 2/2，0 跳过）；`pnpm.cmd build` 生成 planning-api、CloudBase 部署制品和云模式小程序构建；`pnpm.cmd dry-run:api` 成功加载函数；`pnpm.cmd smoke:api` 通过 1/1 个真实本地函数进程烟雾。独立 E2E 连续两次均为 1 个测试文件、2/2 项通过；fixture 身份图测试 4/4，cloud fixture 隔离测试确认 `allowTestFixtures=false` 且构造/调用不加载 fixture 模块。
- 2026-08-11 最终审查修复后 fresh 验收：`pnpm.cmd lint` 退出 0；`pnpm.cmd typecheck` 完成 10/11 个带脚本工作区项目及小程序严格检查；`pnpm.cmd test` 通过 43/43 个测试文件、505/505 项测试（阶段四 E2E 6/6，含 allergen/inventory/missing-source/nutrient 四类结构化冲突）；`pnpm.cmd build` 生成 3.15 MB planning-api bundle（map 5.33 MB）、CloudBase 部署制品和云模式小程序制品；`pnpm.cmd dry-run:api` 成功加载 `main`；`pnpm.cmd smoke:api` 通过 1/1 个真实本地函数进程烟雾。Provider 调用均在 repository transaction 外完成，race 失败不产生部分餐单写入。
- 2026-08-11 最终审查 Round 2 后 fresh 验收：`pnpm.cmd test` 通过 43/43 个测试文件、523/523 项测试；`pnpm.cmd typecheck`、`pnpm.cmd lint` 均退出 0；`pnpm.cmd build` 生成 3.16 MB planning-api bundle（map 5.35 MB）、CloudBase 部署制品和云模式小程序制品；`pnpm.cmd dry-run:api` 成功加载 `main`；`pnpm.cmd smoke:api` 通过 1/1 个真实本地函数进程烟雾。A 的三项 obsolete completion candidate 竞态测试、B 的 contracts/application/persistence/handler/VM/controller 跨层快照测试及 C 的六项 v2/v3 兼容测试均包含真实 RED→GREEN 证据。
- 2026-08-11 最终审查 Round 3 后 fresh 验收：`pnpm.cmd test` 通过 43/43 个测试文件、527/527 项测试；`pnpm.cmd typecheck`、`pnpm.cmd lint` 均退出 0；`pnpm.cmd build` 生成 3.16 MB planning-api bundle（map 5.35 MB）、CloudBase 部署制品和云模式小程序制品；`pnpm.cmd dry-run:api` 成功加载 `main`；`pnpm.cmd smoke:api` 通过 1/1 个真实本地函数进程烟雾。真实 service/InMemory 测试以合法 v1→v2→v3 库存版本链和 aggregate invariant sanity gate 复现 3/3 RED，再以共享 latest-active-chain 门禁达到 3/3 GREEN；公共 handler 时间线另以 1/1 证明不会退化为 `internal_error`，独立只读复审为 CLEAN。

### 剩余工作

- 无阶段四代码剩余项；图片识别与候选确认属于阶段五，LLM 有限对话属于阶段六。

### 外部阻塞

- 无阻塞阶段四完成的代码项。本地验收只使用显式 `test_fixture`；生产审核餐单/营养数据、来源与商业授权/缓存许可尚未完成，阶段四能力也未部署到 CloudBase。
- 《中国居民膳食营养素参考摄入量（2023 版）》正式表格仍须生产上线前复核。微信开发者工具页面渲染及真机交互未在本次命令验收中观察，不由构建退出码替代。

## 阶段 5：食材图片与 Provider

**状态：已完成**

### 验收清单

- [x] 实现用户私有路径图片上传和最小权限访问。
- [x] 定义 `VisionProvider`，实现候选名称、置信度和内部标准食材 ID 映射。
- [x] 实现用户确认门禁；确认前不得写入正式库存或触发营养计算。
- [x] 实现识别失败手动录入、超时、一次有限重试、熔断和脱敏观测。
- [x] 实现原图 24 小时内清理、失败重试和孤儿对象处理。
- [x] 覆盖候选确认、用户隔离、供应商失败、日志脱敏和清理幂等测试。

### 代码与验证证据

- 设计与计划：`docs/superpowers/specs/2026-08-19-phase-5-ingredient-photo-vision-design.md`、`docs/superpowers/plans/2026-08-19-phase-5-ingredient-photo-vision.md`；任务 1–7 本地完成点为 `2a8f070`，Task 8、最终审查修复、端到端证据、smoke 与部署文档已在 `3aa9b07` 快进进入 `feat/v1.0`。
- schema v6 以不可变 `ingredientPhotoVersions` 和派生 `nextPhotoCleanupAt` 扩展规划聚合；v5→v6 只补空图片历史/null 清理指针，不制造历史照片、fileID、候选或清理事实。CloudBase 到期扫描只信任持久化 `state.userId`，并按 `state.nextPhotoCleanupAt ASC, state.userId ASC` 有界查询。
- `VisionProvider` 只接受/返回受限候选合同；8 秒单次超时、一次传输/超时重试、三次完整操作失败熔断、60 秒半开探测和字段白名单观测均在 Provider 层。生产 cloud-only 制品不包含 fixture、本地身份开关或本地入口。
- 创建/登记/识别/确认均经 authenticated `planning-api`、严格 schema、可信服务端身份、版本化 SHA-256 幂等和预期版本门禁。确认前库存、能量/营养目标、餐单、重算和 outbox 不变；候选与正整数克数确认在一个事务中追加图片/库存版本，不自动生成餐单。
- 清理函数支持每 15 分钟处理确认后的即时私有指针和创建后 `+23h` 的未确认/未登记孤儿；删除失败 15 分钟后重试，`NOT_FOUND` 收敛为已删除，同一任务重复执行不重复增长有效删除。默认 `cloudbaserc.json` 不含 trigger，独立 `cloudbaserc.photo-cleanup-timer.json` 只在索引、可信身份、规则/IAM 和双账号门禁后用于激活。
- Task 8 E2E 通过真实 authenticated handler + 一个内存仓库、私有存储 fake、版本化营养 fixture 和定时清理 handler 覆盖：创建/登记响应丢失、识别/确认幂等、确认前零副作用、125 g 原子确认、历史版本不变、跨用户登记/确认、确认时间即时 `NOT_FOUND` 清理、孤儿 `+23h` 和重复清理。Windows 上精确 `pnpm.cmd exec vitest ...` 因无法解析 `vitest` 退出 1，按任务裁决使用 `pnpm.cmd test -- tests/e2e/ingredient-photo-workflow.test.ts`，1/1 文件、2/2 项通过。
- 2026-08-19 合入 `feat/v1.0` 后 fresh 主线门禁按顺序通过：`pnpm.cmd lint` 退出 0；锁文件离线重建主工作区链接复用 607/607 个包且零下载；`pnpm.cmd typecheck` 完成 11/12 个带脚本工作区项目及小程序严格检查；`pnpm.cmd test` 通过 62/62 个测试文件、694/694 项测试；`pnpm.cmd build` 生成 planning-api 本地 3.22 MB、cloud-only 3.19 MB、photo-cleanup 2.99 MB 双函数制品和云模式小程序；`pnpm.cmd dry-run:api`、`pnpm.cmd dry-run:photo-cleanup` 均成功加载；`pnpm.cmd smoke:api` 通过真实本地函数进程 1/1；`git diff --check 1c6a55e..3aa9b07` 和敏感扫描通过。
- 敏感扫描未发现私钥头、`SECRET_ACCESS_KEY`、真实 fileID/密钥/用户照片或本地临时路径；命中项均为测试/计划中的合成 `cloud://` 哨兵、CloudBase 格式示例或小程序 `tempFilePath` 字段名。主工作区只保留任务开始前已有且未暂存的 `.pnpm-store/`。
- 部署、索引、规则、外部验收和回滚清单见 `docs/cloudbase/phase-5-ingredient-photo-deployment.md`。

### 剩余工作

- 无阶段五本地代码剩余项。阶段六有限对话另行设计实施；阶段五下列真实部署检查仍须在受控环境关闭。

### 外部阻塞

- 本次没有部署或访问真实 CloudBase、混元、微信 IDE 或物理设备；不得据本地命令声称 production ready。
- 启用清理定时器前必须创建并验证复合索引 `state.nextPhotoCleanupAt ASC, state.userId ASC`。任何运行过 early-v6 构建的环境必须证明到期文档缺失可信 `state.userId` 的数量为零，或执行受控可信回填；禁止从哈希文档 ID 反推身份。
- 仍未验证：真实混元候选合同、访问权限、备案/登记与内容标识；flat creator-private 存储规则和函数调用拒绝在两个真实微信账号上的执行；`planning-api` 嵌套函数 IAM；15 分钟定时器投递与 `+23h` 删除；目标环境复合索引；微信开发者工具渲染、页面恢复及真机相机/上传。
- 生产营养数据来源、授权与缓存许可，以及正式 `CN-DRI-2023` 表格复核继续是生产上线前门禁。

## 阶段 6：单 Agent 有限对话

**状态：已完成**

### 验收清单

- [x] 使用 LangGraph.js 实现单 Agent 状态图，不引入多 Agent。
- [x] 只支持换菜、调份量、移动训练日等白名单意图，并转换为公开应用服务领域命令。
- [x] 对模型输出执行严格运行时 schema 校验，最多一次受控修复，二次失败明确降级。
- [x] 限制最近 12 条消息和结构化摘要，不把敏感数据写入公共知识库或跨用户记忆。
- [x] 拒绝模型生成数值、任意工具、URL、数据库查询、身份字段和绕过版本/过敏原的请求。
- [x] 覆盖非法输出、越权字段、供应商超时、熔断、降级和确定性核心独立可用测试。

### 代码与验证证据

- 设计与计划：`docs/superpowers/specs/2026-08-19-phase-6-bounded-single-agent-design.md`、`docs/superpowers/plans/2026-08-20-phase-6-bounded-single-agent.md`；部署与 v7-aware 回滚见 `docs/cloudbase/phase-6-bounded-assistant-deployment.md`。
- 实现提交：`c2be978`、`08207d4`、`bb40d86`、`7fbef07`、`a7d4083`、`d8b5488`、`b761e70`、`6a86885`、`3412baa`；审计与复审修正为 `741a351`（配置名）、`b173854`（schema v7 回滚断言）、`2b3f10e`（澄清/响应丢失/Provider/客户端恢复）、`7b694f2`（received/validated 失败边界）和 `5c54b0d`（received-only 原子终结）。
- 单图证据：`packages/agent/src/single-agent.ts` 只构造并编译一个有限 `StateGraph`；`single-agent.test.ts` 校验固定节点/边，`runtime-handler.test.ts` 校验跨请求只创建一次 Agent。仓库边界扫描未发现 `createReactAgent`、多 Agent 或动态 tool choice；命中的 `createAgent` 仅为测试注入构造钩子。
- 白名单与安全证据：contracts/domain/model 只定义 `move_training_day`、`replace_meal`、`resize_meal_portion`，`planning-assistant-commands.test.ts` 和 `assistant-workflow.test.ts` 验证三项命令进入公开确定性服务。`evidence.test.ts` 拒绝身份、工具、URL、SQL/query、热量、克数、MET、时长、解释和非原文证据；版本、过去事实、锁定/手改、库存、来源、营养、忌口及过敏原继续由既有服务失败关闭。
- 修复与会话证据：`single-agent.test.ts` 验证首次非法输出只修复一次且二次非法不调用命令；`assistant-conversation.test.ts` 验证最近 12 条消息、32 个回执、安全摘要、幂等，以及 authorize-wins 时 received-only 失败终结在同一事务内返回 null；真实 composition 测试证明授权前异常释放会话、提交后响应丢失保留 validated turn、跳过第二次模型调用并复用领域幂等键；`cloudbase-planning-repository.test.ts` 验证 v6→v7 空会话迁移与 v7 往返；端到端测试验证两个身份的消息、摘要、pending、回执和规划版本隔离。
- Provider 与降级证据：同一 CloudBase backend 显式透传混元、托管 DeepSeek 或自有 DeepSeek Provider/模型，不配置默认值且不自动跨供应商回退。Provider 测试覆盖 20 秒超时、一次传输重试、三次完整失败熔断、单半开探测、严格 envelope、字段白名单日志和固定错误；端到端测试验证模型不可用时结构化 planning API 与确定性份量调整仍独立可用。
- 2026-08-20 最终复审后 fresh 门禁：`pnpm.cmd lint`、`pnpm.cmd typecheck`（13/14 workspace 项目及小程序 TypeScript）、`pnpm.cmd test`（81/81 文件、842/842 测试）、`pnpm.cmd build`、三个 dry-run、`pnpm.cmd smoke:api`（2/2 进程测试）、`pnpm.cmd smoke:assistant`（1/1）和 `git diff --check` 全部退出 0。部署 `index.js` 为 planning `3,368,909 B`、assistant `5,363,941 B`、cleanup `3,151,521 B`，对应 `package.json` 为 92/93/93 B；独立复审无 Critical、无 Important。
- 密钥与边界扫描未发现私钥头、`SECRET_ACCESS_KEY`、硬编码 API key、真实环境/fileID 或 domain/calculation 外部 SDK 依赖；命中项均为文档格式、本地开关或合成测试哨兵。任务开始前已有的 `.pnpm-store/` 保持未跟踪且未修改。

### 剩余工作

- 无阻断阶段六完成的本地代码项。会话摘要在 finalize 前读取规划上下文，极短并发窗口内可能比权威计划落后一版；摘要不参与领域命令、数值或授权，作为阶段七一致性加固项跟踪。

### 外部阻塞

- 尚未验证真实 CloudBase AI+ 混元/DeepSeek 的精确模型 ID、访问权限、区域、配额、响应合同和费用，以及自有 DeepSeek Provider 的 BaseURL/API Key 管理、服务协议和数据处理。
- 尚未验证公开服务备案/登记与 AI 内容标识、两个真实微信账号的数据库/会话/图片隔离、规则/IAM/定时器/复合索引、微信开发者工具和物理设备；结构化规划核心流程不得依赖模型审批或可用性。
- 生产餐单/营养数据来源、授权与缓存许可，以及正式 `CN-DRI-2023` 表格复核继续是生产上线前门禁。

## 阶段 7：本地优先 Web 重构与内部测试交付

**状态：进行中**

### 决策边界

- 本仓库完全放弃微信小程序、CloudBase 云函数、数据库、存储、AI+ 和真实云端发布方向。
- 保留并浏览器化阶段一至六已经验证的领域、计算、应用、Agent、合同和供应商无关韧性代码；不从零重写确定性核心。
- 最多五名测试人员从空 IndexedDB 开始，只使用虚拟身体数据、非个人测试图片和明确 `test_fixture` 营养数据。
- 生产应用、生产营养数据、公开发布、站点托管与访问控制不属于本阶段。
- 测试人员不配置 LLM Key；独立、低额度、短有效期测试 Key 只从未跟踪 `.env.test.local` 注入未跟踪测试制品，并视为可能被提取。

架构决策：`docs/decisions/ADR-0001-local-first-web-test-application.md`

书面规格：`docs/superpowers/specs/2026-08-26-local-first-web-test-app-design.md`

### 分阶段执行清单

| 子阶段 | 状态 | 退出条件 |
|---|---|---|
| 7W-0. 决策、规格与实施计划 | 进行中 | ADR、书面规格、动态进度清单和详细 TDD 实施计划均获复核并进入 `feat/v1.0` |
| 7W-1. Web 基础与浏览器兼容 | 未开始 | React/Vite、路由壳、测试标识、构建模式、CSP、浏览器 SHA-256 和能力门禁通过测试与构建 |
| 7W-2. IndexedDB 与本地数据权利 | 未开始 | Dexie repository、事务 revision、测试数据集、持久化、备份/恢复和删除通过原子性与并发测试 |
| 7W-3. 结构化规划 Web 流程 | 未开始 | 启动/隐私/建档/目标/训练/每日目标页面和支持/不支持范围 E2E 通过 |
| 7W-4. 库存、餐单与执行闭环 | 未开始 | 七日餐单、锁定/手改、训练联动、完成度、差异确认和失败恢复 E2E 通过 |
| 7W-5. 浏览器 LLM 与图片候选 | 未开始 | 固定测试配置、受限助手、内存图片、候选确认、手动降级、秘密扫描和显式预检通过 |
| 7W-6. 功能对等、旧平台删除与测试交接 | 未开始 | Chromium/WebKit 全流程通过，小程序/云函数/CloudBase 活动代码删除，未跟踪制品和五人清单就绪 |

### 阶段七验收清单

- [ ] 书面 ADR、完整设计和详细实施计划获用户复核，且不包含占位项或未决架构分支。
- [ ] React/Vite Web 工作区、浏览器兼容摘要和测试构建边界通过 lint、类型检查、测试和构建。
- [ ] 单用户 IndexedDB 聚合、事务 revision、多标签冲突、3 MB 预算、持久化状态、备份/恢复和删除通过自动化。
- [ ] 从空库完成档案、目标、训练、每日能量/营养目标，并覆盖年龄/BMI/健康确认门禁和版本历史。
- [ ] 完成测试库存、确定性七日餐单、锁定/手改、训练变更、完成度、重算差异和失败回滚浏览器闭环。
- [ ] 完成固定 OpenAI-compatible LLM Backend、三项受限助手命令、一次修复、超时/重试/熔断和结构化降级。
- [ ] 完成只在内存存在的测试图片、最多五个映射候选、名称/克数确认和手动录入降级；确认前库存零副作用。
- [ ] 所有页面持续显示虚拟数据内部测试、估算、AI 辅助和非医疗边界，且测试人员不能取消这些标识。
- [ ] 真实测试 Key 不在源码、Git、日志、备份、导出、source map 或证据；测试制品未跟踪且可在验收后撤销 Key。
- [ ] 普通自动化不访问实时付费模型；显式预检只发送最小合成请求并输出脱敏统计。
- [ ] 删除 `miniprogram/`、`cloudfunctions/`、CloudBase 适配器、配置、脚本和当前部署文档，活动源码扫描无 `wx.*` 或 CloudBase 运行依赖。
- [ ] fresh lint、类型检查、全量测试、Web 构建、Playwright Chromium/WebKit、秘密扫描和 `git diff --check` 通过。
- [ ] 五人以内内部测试清单就绪，最终结论仅为“虚拟数据 Web 内部测试版已交付”，不宣称生产就绪。

### 当前代码与验证证据

- 2026-08-26 项目负责人在可行性与设计对话中确认：空本地数据库、不迁移 CloudBase 数据、完全摒弃小程序、保留已验证业务核心、React/Vite + IndexedDB、虚拟测试数据、浏览器 LLM/图片流程，以及测试 Key 从未跟踪本地环境文件注入测试制品。
- 7W-0 已起草 `ADR-0001` 和 Web 书面规格，并按本清单拆分 7W-0 至 7W-6；当前尚未安装新依赖或修改任何业务运行代码。
- 阶段一至六和原 7A/7B 的领域、计算、版本、餐单、Agent、个人数据和发布门禁本地证据继续作为可复用核心的回归基线；原 CloudBase 7C 路线自 2026-08-26 起被 ADR 取代，不再计入当前阶段七完成度。
- 原 CloudBase 路线的实现与文档仍在 Git 历史和当前工作树中等待 7W-6 功能对等后删除；其存在不表示继续维护双平台或恢复云端发布。

### 阶段执行规则

- 严格按 7W-0 → 7W-6 顺序执行；每次只把当前子阶段标记为“进行中”。
- 每个子阶段先写失败测试，再做最小实现；相关 lint、类型检查、测试和构建真实通过后才标记“已完成”。
- 每个子阶段在同一变更中记录实现提交、验证命令与结果、剩余工作和新发现的阻塞。
- 7W-1 至 7W-5 不删除旧平台，以便进行行为对照；不得向旧平台增加新功能或双写。
- 只有 7W-6 功能对等和替代自动化通过后，才删除旧小程序/CloudBase 代码和文档。
- 任一子阶段失败时保持上一阶段可运行状态，不以文档、构建退出码或模型通常可用代替真实验收。

### 剩余工作

- 用户复核 7W-0 的书面 ADR 与规格；复核通过后生成无占位项的详细 TDD 实施计划。
- 依次完成 7W-1 至 7W-6 的代码、测试、文档、旧平台删除和测试交接。
- 在 7W-5 实际预检前，由项目负责人在本机未跟踪 `.env.test.local` 提供固定 Base URL、短期测试 Key 和模型 ID；不得粘贴到仓库、聊天、缺陷单或测试证据。
- 测试结束后由项目负责人撤销测试 Key，并删除未跟踪测试制品。

### 外部阻塞与范围外事项

- 当前唯一流程门禁是书面规格复核；这不构成代码技术阻塞，但在复核前不得开始实施或安装依赖。
- 目标 LLM 是否支持浏览器 HTTPS/CORS、固定模型文本合同和可选多模态图片合同尚未真实验证；若 CORS 不支持，7W-5 不能伪造通过，且需重新提交代理 ADR。
- 静态站点托管、访问控制和测试制品分发由项目外处理，不阻塞本仓库完成可构建制品和本地验收。
- 正式营养数据授权、`CN-DRI-2023` 复核、生产合规和真实健康建议继续是生产事项；它们不进入本虚拟数据测试阶段，也不得被本阶段结论暗示为完成。

## 并行历史分支处理

- `phase1-local` 在共同完成点 `c210171` 之后另有 23 个本地并行提交，分支尖端为 `12f31eb`。
- 这些提交包含完整 MVP、餐单、图片和 Agent 等试验性实现，但未经过阶段二主线的逐项整合，明确不属于 `feat/v1.0`，也不计入阶段三至七进度。
- 后续如需复用，只能按当前阶段的设计、测试和验收要求逐功能审查后引入；不得整体合并该分支或据此直接勾选进度。

## 更新记录

| 日期 | 分支/基线 | 更新 |
|---|---|---|
| 2026-08-26 | `feat/v1.0` / 7W-0 Web 重构设计启动 | 项目负责人批准完全放弃微信小程序与 CloudBase、从空 IndexedDB 开始、保留确定性业务核心、只使用虚拟测试数据，并以未跟踪本地环境文件向未跟踪测试制品注入短期受限 LLM Key；新增 ADR 与书面规格，把阶段七改为 7W-0 至 7W-6 的本地优先 Web 重构。当前仅更新规划文档，等待书面复核和详细实施计划，未安装依赖或修改业务运行代码 |
| 2026-08-20 | `feat/v1.0` / `7b5760b` 后 7C 发布准备 | 按固定 CloudBase CLI 3.7.2 实际命令面修正发布/备份恢复手册和预检调用，真实预检已识别 CLI 并仅因私有输入缺失安全失败；补充测试人员完整验收清单。未执行任何外部写入，阶段七保持进行中，发布/数据/合规负责人及真实云端证据仍是强制阻塞 |
| 2026-08-20 | `feat/v1.0` / 7B 生产审核数据与发布门禁 | 完成严格审核数据合同与离线验证、精确 CloudBase Provider、发布预检/产物扫描、3 MB/6 MB 与 10×30 容量基线、fail-fast 发布编排、全仓发布脚本类型边界和运维手册；fresh 门禁为 104 文件、970 测试 + 1 个 Windows 条件跳过及全部构建/dry-run/smoke/capacity/scan。阶段七保持进行中，真实私有数据、授权、预检/发布、云端、供应商、双账号、恢复、合规和设备验收进入 7C 且均未关闭 |
| 2026-08-20 | `feat/v1.0` / 7A 个人数据权利实现 | 完成 schema v8 严格导出与三阶段账户删除、pending 全局阻断、助手摘要事务一致性、隐私/个人数据页面和双身份账户生命周期 E2E；fresh 门禁为 92 文件、897 测试及全部构建/dry-run/smoke。阶段七保持进行中，7B/7C 与真实云、供应商、恢复、合规和设备验收均未关闭 |
| 2026-08-20 | `feat/v1.0` / `5e2865b` 后阶段七实施计划 | 用户复核书面设计；实施拆为数据权利、生产审核数据/发布门禁、真实受控发布三份 TDD 计划，外部证据仍是同一阶段的强制退出条件，尚未勾选实现或发布验收项 |
| 2026-08-20 | `feat/v1.0` / `3fcc522` 后阶段七设计启动 | 用户批准真实受控内测方向；阶段七改为进行中，书面设计覆盖 schema v8 数据权利、生产审核数据、同事务助手摘要、隐私/AI 标识、发布工具及真实云端证据；尚未勾选任何实现或发布验收项 |
| 2026-08-20 | `feat/v1.0` / `5c54b0d` 阶段六最终复审 | 完成固定 LangGraph.js 单 Agent、三项白名单命令、严格证据与一次修复、schema v7 有界会话、混元/DeepSeek 显式单 Provider 配置、原子恢复和原生助手页；fresh 门禁为 81 文件、842 测试、三函数 dry-run、smoke 2/2 + 1/1，独立复审无 Critical/Important。真实云、供应商、双账号、合规和设备事项进入阶段七门禁 |
| 2026-08-19 | `feat/v1.0` / `319ac92` 后阶段六设计启动 | 阶段六改为进行中：批准独立 `assistant-api`、LangGraph.js 单 Agent、三项白名单领域命令、严格模型证据与一次修复、schema v7 有界会话，以及混元/DeepSeek 显式配置切换且不自动跨供应商回退；尚未勾选任何实现验收项 |
| 2026-08-19 | `feat/v1.0` / `3aa9b07` 阶段五最终审查与合入 | 完成阶段五本地代码验收：私有食材图片上传、受控 Vision Provider、明确候选/克数确认、schema v6、原图清理、原生页面与 authenticated handler E2E；fresh 主线门禁为 62 文件、694 测试、双函数 dry-run 和 smoke 1/1。真实混元、CloudBase 规则/IAM/定时器/复合索引、early-v6 可信身份检查、IDE/设备仍列外部未验，下一阶段为阶段六 |
| 2026-08-11 | `feat/v1.0` / `cefc812` 最终审查 Round 3 | 关闭同 active training/date 旧 failed completion job 重现与误重试：合法库存版本链、初始零 Provider 调用、事务竞态回滚和公共 `candidate_not_pending`；fresh 六门禁为 43 文件、527 测试及 smoke 1/1，独立复审 CLEAN |
| 2026-08-11 | `feat/v1.0` / `55aa739` 后最终审查 Round 2 | 关闭 2 Important + 2 Minor：completion candidate authoritative eligibility、持久化脱敏无解快照与 v4→v5 兼容、库存 v3 指纹及旧 v2 fail-closed 重放、fresh 文档计数；六门禁为 43 文件、523 测试及 smoke 1/1 |
| 2026-08-11 | `feat/v1.0` / `898b649` 后最终审查修复 | 关闭最终审查 4 Important + 1 Minor：离线库存幂等重放、公开结构化无解冲突与可信中文名、obsolete candidate 生命周期、完整 Provider 图 digest/三路径二次 CAS、未来完成独立错误；fresh 六门禁为 43 文件、505 测试及 smoke 1/1 |
| 2026-08-11 | `feat/v1.0` / `fix: version balanced meal fixtures` | 修复阶段四验收 fixture 的身份冲突：均衡营养快照、食谱、菜单和目录使用独立闭合版本图；本地/E2E/smoke 使用该图，cloud 构造和调用不加载 fixture；阶段四完成状态经 43 文件、492 测试及六门禁复验后继续成立 |
| 2026-08-11 | `feat/v1.0` / `test: complete weekly meal loop acceptance` | 完成阶段四：手动库存、确定性七天餐单、锁定/手改保护、训练变更与完成度联动、公共 handler E2E 和真实本地进程烟雾；下一阶段调整为阶段五 |
| 2026-08-10 | `feat/v1.0` / `8097695` | 将 `CN-DRI-2023` 正式表格复核及营养数据授权、缓存许可和退出方案集中记录为生产上线前待办；明确不阻塞严格个人本地自用或后续功能开发 |
| 2026-08-10 | `feat/v1.0` / `d727563` | 完成阶段三：确定性营养目标、约束求解、审核动作/MET 与营养数据边界、离线 Provider、每日营养目标版本链和本地全量验收；下一阶段调整为阶段四 |
| 2026-08-10 | `feat/v1.0` / `0401d5f` | 建立统一开发主线；确认阶段 1、2 已完成，阶段 3–7 未开始；记录并行历史分支排除规则 |
