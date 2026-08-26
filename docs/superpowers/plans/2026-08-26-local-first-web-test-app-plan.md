# 本地优先 Web 重构详细实施计划（7W）

> 目标分支：`feat/v1.0`
> 关联决策：`docs/decisions/ADR-0001-local-first-web-test-application.md`
> 关联规格：`docs/superpowers/specs/2026-08-26-local-first-web-test-app-design.md`

## 一、总体目标

把阶段一至六的确定性业务核心迁移到内部可执行、无后端 Web 运行线下模型，支持最多五名测试人员在空 IndexedDB 上完成完整闭环。

- 从空库到档案、目标、训练、一周营养目标、库存、七日餐单、执行反馈。
- 计划变更与完成度重算、锁定/手改保护、版本链和过敏原硬约束不回退。
- 图片候选必须映射到 `test_fixture` 数据集、确认前零副作用。
- 所有结果持续显示“虚拟数据内部测试”与“非医疗建议”边界。
- 完成 7W-1 至 7W-6 门禁后再做旧平台删除与交接。

## 二、实施边界（不做）

- 不迁移 CloudBase 现网数据，不引入登录/多用户同步/远程恢复。
- 不实现新增后端、不做数据库/对象存储/云函数/CloudBase AI+ 运行。
- 不改变阶段一至六已验证的确定性策略与版本语义。
- 不承诺生产就绪，任何结果只作为内部测试输入。

## 三、7W-0 最终交付清单

- [x] `docs/superpowers/specs/2026-08-26-local-first-web-test-app-design.md` 已确认（已完成）
- [x] `docs/decisions/ADR-0001-local-first-web-test-application.md` 已确认（已完成）
- [x] `DEVELOPMENT_PROGRESS.md` 当前阶段与阻塞项已反映“详细实施计划已产出”
- [x] 详细分阶段 TDD 实施计划产出：`docs/superpowers/plans/2026-08-26-local-first-web-test-app-plan.md`
- [ ] 用户确认 7W-0 全部文档复核通过

> 7W-0 在用户复核通过后切换到 7W-1。

## 四、7W 分阶段执行计划

### 7W-1：Web 基础与浏览器兼容（预计 4–6 工作日）

1. 组件与依赖
   - 新建 `apps/web` 工作区（React、Vite、TypeScript、React Router、Dexie、Zod、Vitest、RTL、Playwright、fake-indexeddb）。
   - 复用 `@fitness/application/@fitness/domain/@fitness/calculation/@fitness/agent/@fitness/contracts/@fitness/providers`。
   - 配置前端构建与测试脚本：`build:web`、`build:web:test`、`dev:web`、`typecheck:web`、`test:web`、`test:web:e2e`。
2. 浏览器兼容门禁
   - Web 首屏展示能力检测（IndexedDB、Web Crypto、BroadcastChannel、structuredClone、URL.createObjectURL）。
   - 缺失能力返回 `browser_capability_unsupported`，不可进入核心业务页面。
   - 增加 SHA-256 兼容层：改造 Node `crypto` 依赖的摘要逻辑为浏览器 `crypto.subtle.digest`，并保留规范化摘要向量。
3. 失败测试（先）
   - 统一仓库不含 `wx.*`、CloudBase 运行时入口（除非历史保留文件）。
   - Web 启动能力门禁测试、`build:web`/`build:web:test` 路由环境变量校验测试。
4. 验收
   - `pnpm cmd lint`、`pnpm cmd typecheck`、`pnpm cmd test`、`pnpm cmd build:web`、`pnpm cmd scan:web-secrets`、`git diff --check` 通过。
   - 无真实测试密钥进入构建产物；`build:web` 失败于发现 `VITE_TEST_LLM_API_KEY`。

### 7W-2：IndexedDB 与本地数据权利（预计 6–8 工作日）

1. 持久化层
   - 实现 `apps/web/src/db/dexie-repository.ts` 与 `apps/web/src/db/schema.ts`。
   - 数据库名 `fitness_local_v1`，stores：
     - `planningStates`
     - `appSettings`
     - `testDatasets`
   - 实现 `PlanningRepository.read/transact`，事务内 revision 严格 +1。
2. 并发与恢复
   - `local_revision_conflict` 映射到刷新重试流程。
   - BroadcastChannel 广播外部提交结果；跨标签读写冲突需幂等提示。
3. 3MB 预算和 checksum
   - 聚合序列化后 byte 长度超过 `3,000,000` 时返回 `account_capacity_exceeded`。
   - 新增 `payloadSha256` 校验字段，兼容导出/恢复流程。
4. 备份与删除
   - 实现 `fitness-local-backup-v1` 导入导出结构。
   - 删除本地账户：清空 IndexedDB、会话草稿和助手恢复状态。
5. 失败测试
   - 空库恢复、Schema 创建升级、并发冲突、容量边界、备份恢复/覆盖确认、安全字段过滤测试。
6. 验收
   - `fake-indexeddb` 与 `web:unit` 覆盖项通过；关键路径在 `test:web` 与 `test:web:e2e` 复现持久化语义。

### 7W-3：结构化规划 Web 流程（预计 6–8 工作日）

1. 页面与路由
   - 路由：首页 `/`、建档 `/setup`、计划展示 `/plan`、餐单 `/meals`、助手 `/assistant`、数据 `/data`、隐私 `/privacy`。
   - 建立统一壳：版本摘要、可用性状态、错误总线。
2. 流程状态机
   - 复用 `getCurrentContext` + `saveBodyProfileAndGoal` + `saveTrainingPlan` + `getCurrentContext` 决策链。
   - 受控处理 unsupported 场景：年龄/BMI/健康确认门禁保持不变。
3. 数据不可变性
   - 页面只通过命令更新，不持久化业务状态副本，成功后重读 authoritative context。
4. 失败测试
   - 启动确认门禁、版本不一致重试、支持/不支持分支、导航与草稿恢复、错误映射一致性。
5. 验收
   - 全流程 Playwright 覆盖建档到计划生成一次成功路径；unsupported 场景不出现热量/克数。

### 7W-4：库存、餐单与执行闭环（预计 8–10 工作日）

1. 库存与七日餐单
   - 手动食材录入、闭合验证、来源和过敏原检查全部走现有应用服务。
   - 实现 `/meals` 页面：展示七日计划、份量、营养总表、锁定与手改标记。
2. 重算闭环
   - 训练变更与完成度提交后重算受影响日期。
   - 锁定/手改日期只生成 `pending` 候选与待确认入口，不静默覆盖。
3. 失败回退
   - Provider 不可用返回 `provider_unavailable`，核心流程保持可用（查看/重试）。
4. 测试
   - 与阶段四历史规则一致的回归（移动/取消/时长变化/完成度、守恒、幂等、失败回退）迁移为浏览器 E2E。
5. 验收
   - 一次训练移动后受影响日期变化正确；无关日期不变；历史事实不改写。

### 7W-5：浏览器 LLM 与图片候选（预计 6–8 工作日）

1. OpenAI Compatible 后端
   - 新建 `apps/web/src/llm` 固定 endpoint/model 后端。
   - 支持 CORS 失败、401/403/429、超时、schema 不合法的统一错误映射。
2. 受限助手
   - 复用既有 LangGraph 运行时与应用命令 facade，支持三命令（move/replace/resize），最多一次修复。
   - 无 schema 输出直接降级到结构化控制入口，不阻断页面浏览。
3. 图片候选
   - 图片仅内存留存，JPEG/PNG 校验，最大 10 MiB（或配置上限）。
   - 发送前缩放、候选映射白名单、最多五个候选、用户确认前零副作用。
4. 失败测试
   - fetch 桩模拟 transport timeout、CORS blocked、HTTP 429、非法 JSON、非法 schema；确认手动录入回退可用。
5. 验收
   - `web:test:preflight` 成功发送最小合成请求并返回脱敏统计；无 runtime 模型可配置口。

### 7W-6：功能对等、旧平台删除与测试交接（预计 3–5 工作日）

1. 全链路对等
- Chromium/WebKit 走通完整流程：启动→建档→训练→营养目标→库存→餐单→完成度→候选确认→备份恢复→删除。
2. 边界清理
   - 删除 `miniprogram/`、`cloudfunctions/`、CloudBase 运行适配器、`cloudbase*` 部署文档、CloudBase 脚本（保留历史审计用文件引用）。
   - 扫描确认活动源码无 `wx.*`、CloudBase 运行依赖、数据库 SDK。
3. 交接
   - 最终 `DEVELOPMENT_PROGRESS.md` 置为“虚拟数据 Web 内部测试版已交付”状态，仅在文档中声明内部测试性质。
   - 更新清单：测试数据构成、版本边界、已知范围外事项、测试 Key 撤销流程、五人以内验收确认签名。
4. 验收
   - `pnpm cmd lint`、`pnpm cmd typecheck`、`pnpm cmd test`、`pnpm cmd build:web`、`pnpm cmd test:web:e2e`、`pnpm cmd scan:web-secrets`、`git diff --check` 全通过。
   - `build/web` 与 `e2e` 不访问 live 付费模型；只有 `.env.test.local` 显式预检触发外部模型。

## 五、测试分层基线（必须保留）

- Node Unit: 现有 contracts/calculation/domain/application/persistence 测试继续存在并可复跑。
- Web Unit: RTL + MSW/fetch stub 覆盖主要用户入口与错误态。
- E2E: Playwright 至少覆盖 Chromium 与 WebKit 两个内核，含失败恢复与并发冲突。
- Secret scan 与边界扫描加入 CI 前置。
- 不改变阶段五至六历史测试证据的权重，只在新 Web 运行层新增覆盖。

## 六、验收门槛映射

- AGENTS `完成定义`：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`git diff --check` 以及阶段八? 依赖清单中要求的 Web 命令，在 7W 目标前后分别执行并记录。
- 7W 阶段验收：对齐 `DEVELOPMENT_PROGRESS.md` 的阶段七清单逐条打勾并补齐证据。
- 生产就绪与正式发布声明：一律为“未达成”，直到外部云端/供应商/合规模块全部复核后另立目标。

## 七、变更治理

- 每个子阶段只新增最小文件并在同次变更内更新：
  - 文档（计划/进度）
  - 实现文件
  - 测试文件
  - 命令输出摘要
- 任一阶段回归失败，不得进入下阶段；保留可回退边界。
