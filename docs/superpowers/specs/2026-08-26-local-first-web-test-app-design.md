# 本地优先 Web 内部测试应用设计

日期：2026-08-26

状态：已获对话设计批准，等待书面规格复核

架构决策：`docs/decisions/ADR-0001-local-first-web-test-application.md`

## 1. 背景与当前基线

仓库阶段一至六已经实现并验证以下业务核心：

- `calculation-policy-v2` 健康范围门禁和确定性能量估算；
- `nutrition-policy-v1` 宏量营养素、纤维、饱和脂肪和添加糖约束；
- 不可变身体档案、目标、训练计划、每日目标和餐单版本；
- 训练变化、完成度、锁定/手改保护、幂等重算和失败回滚；
- 食材库存、候选确认、一周餐单和营养汇总复算；
- 固定 LangGraph 单 Agent、三项白名单修改、严格模型输出和降级；
- 个人数据查看、导出和删除语义。

这些能力当前由微信原生小程序、CloudBase 云函数、文档数据库、私有存储和 CloudBase AI+ 组合运行。阶段七真实 CloudBase 发布没有开始，没有需要迁移的正式用户数据。

项目负责人决定把本仓库改造成最多五名测试人员使用的内部 Web 测试应用，完全放弃小程序和 CloudBase 运行方向。生产应用、真实用户数据、正式营养数据、公开发布和站点托管不在本设计范围内。

## 2. 目标与成功标准

本次重构必须达到：

1. 测试人员在现代浏览器中从空库完成“档案/偏好 → 目标 → 一周训练 → 每日营养目标 → 测试库存 → 七日餐单 → 执行反馈”。
2. 刷新后数据仍存在，完整备份可以在空库中恢复。
3. 模型和图片识别失败时，结构化核心流程继续可用。
4. 所有热量、营养和克数仍由现有确定性代码和审核结构复算。
5. 页面持续标记“虚拟数据内部测试”，测试结果不得用于真实饮食安排。
6. 测试人员不配置供应商 API Key；测试构建使用本地注入的短期受限 Key。
7. 功能对等验证通过后，仓库不再包含活动小程序、云函数或 CloudBase 运行依赖。
8. lint、类型检查、单元/组件/E2E 测试、Web 构建和秘密扫描全部通过。

## 3. 明确不做

- 不迁移 CloudBase 数据，不兼容既有微信身份或 fileID。
- 不提供登录、账号体系、多个本地用户、多端同步、远程备份或后台管理。
- 不提供生产营养数据、真实健康建议、公开发布或商业用途。
- 不增加业务后端、LLM 代理、SQLite WASM、云数据库或运行时营养 API。
- 不从零重写领域模型、计算策略、版本规则或 Agent 安全边界。
- 不实现 PWA 安装、离线 service worker、推送、社区、支付或可穿戴设备。
- 不让页面配置任意模型 URL、工具名、供应商请求体或数据库查询。

## 4. 总体架构

```text
apps/web React pages
  -> route controllers and view models
    -> @fitness/application services
      -> @fitness/domain
      -> @fitness/calculation
      -> @fitness/agent
      -> provider interfaces
        -> DexiePlanningRepository
        -> BundledTestPlanningDataProvider
        -> OpenAICompatibleBrowserBackend
        -> InMemoryVisionImageSource
```

依赖继续单向流动。`domain` 和 `calculation` 不导入 React、Dexie、浏览器 API、LangGraph 或供应商 DTO。页面不直接操作 IndexedDB，也不把模型 JSON 写入状态。所有写入仍经过公开应用服务、版本检查、幂等键和领域校验。

`apps/web` 负责组合浏览器实现、路由、页面状态、错误文案和测试构建元数据。现有 LangGraph 图在进入助手路由时动态导入，减少首页包体；它仍只能调用公开应用服务。

## 5. 代码保留与删除边界

### 保留并适配

- `packages/domain`
- `packages/calculation`
- `packages/application`
- `packages/agent`
- `packages/contracts`
- `packages/providers` 中供应商无关的韧性、schema、审核数据和观察逻辑
- `packages/persistence` 中通用迁移、聚合校验和内存测试仓储
- `data/` 中版本化动作、MET 和允许用于内部测试的 fixture
- 与上述能力对应的单元、属性和端到端测试

### 最终删除

- `miniprogram/`
- `cloudfunctions/`
- CloudBase SDK 适配器、可信 OpenID 组合和 storage/fileID 代码
- `cloudbaserc*.json`、小程序配置、CloudBase 构建/dry-run/smoke/release 脚本
- 只描述当前 CloudBase 部署操作的文档
- 不再被 Web 入口使用的 CloudBase 合同和测试

删除发生在 Web 功能对等门禁之后。迁移期间旧平台只作只读对照，不接受新功能或双写。

## 6. Web 技术栈与目录

新增：

```text
apps/web/
  src/
    app/                 # composition, router, startup guards
    db/                  # Dexie schema, repository, backup/restore
    llm/                 # fixed test config and browser backend
    routes/              # route-level pages
    features/            # setup, planning, meals, photo, assistant, data
    components/          # shared shell, banners, errors, badges
    styles/              # tokens and responsive CSS
  tests/                 # browser-facing integration fixtures
  index.html
  package.json
  tsconfig.json
  vite.config.ts
```

技术选择为 React、Vite、TypeScript、React Router、Dexie、Zod、Vitest、React Testing Library、`fake-indexeddb` 和 Playwright。首版使用 CSS 变量与小型 CSS 模块，不引入大型组件库、状态管理框架或 CSS 框架。

应用服务结果是权威状态。React 局部状态只保存未提交表单、路由选择和临时图片；不复制长期业务状态。每次成功命令后重新读取一致的当前上下文。

## 7. IndexedDB 数据设计

数据库名固定为 `fitness_local_v1`。首版包含三个 object store：

### `planningStates`

键固定为 `local-default`。值包含：

- `schemaVersion`
- `revision`
- `updatedAt`
- `state: PlanningAggregateState`

`state` 继续包含领域版本、活动指针、幂等回执、重算任务、照片候选结构和助手会话。原始图片和测试 Key 不进入聚合。

### `appSettings`

键固定为 `local-default`。值只包含：

- 测试范围确认版本和时间；
- 浏览器持久存储申请结果；
- UI 偏好和最后访问路由；
- 当前测试数据集 ID/版本；
- 测试构建的非秘密 Provider/模型显示名称。

### `testDatasets`

按不可变数据集 ID 保存构建时附带的 `LocalTestPlanningDatasetV1`。该合同新增于 `packages/contracts`，复用现有营养快照、食谱、日菜单和目录 schema，但把 envelope 与每条记录的 `qualityStatus` 固定为 `test_fixture`，因此不会把测试数据伪装成生产 `ReviewedPlanningDatasetV1`。

首次启动执行严格 schema、测试用途标记、闭合引用图和 SHA-256 校验；失败时禁止库存解析和餐单生成，不回退模型或猜测值。`BundledTestPlanningDataProvider` 只接受 `LocalTestPlanningDatasetV1`，现有生产审核 Provider 继续拒绝 `test_fixture`，直到 7W-6 随 CloudBase 运行路径删除。

## 8. 本地事务与并发

`DexiePlanningRepository` 实现现有：

```ts
interface PlanningRepository {
  read(userId: string): Promise<PlanningAggregateState>;
  transact<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => {
      nextState: PlanningAggregateState;
      result: TResult;
    }
  ): Promise<TResult>;
}
```

浏览器组合固定把可信本地身份解析为 `local-default`，页面不能提供其他 `userId`。每次写入在 Dexie `rw` 事务中读取当前 revision、运行同步领域 operation、验证聚合与 3,000,000 字节预算，再以 `revision + 1` 写回。

跨标签写入通过 revision 和 `BroadcastChannel` 协调。旧标签提交已变化 revision 时返回稳定 `local_revision_conflict`，页面重新读取并要求用户复核；不做静默 last-write-wins。数据库升级被另一标签阻塞时显示关闭其他标签的明确提示。

## 9. 浏览器 SHA-256 与兼容性

现有应用和 Provider 中的 `node:crypto` 同步 SHA-256 是浏览器化阻塞项。重构将规范化 JSON 与摘要实现拆分：规范化保持纯同步，摘要通过浏览器兼容的异步 `crypto.subtle.digest('SHA-256', ...)` 产生。

所有调用链显式异步化，不使用 Node polyfill，不在 Web bundle 中引入 `crypto` shim。测试使用相同规范化向量证明 Node 历史摘要与浏览器摘要字节一致，避免幂等、数据集 checksum 和备份 token 漂移。

目标浏览器以 Vite 当前生产构建基线为下限；实际验收至少覆盖 Playwright Chromium 和 WebKit。缺少 IndexedDB、Web Crypto、`structuredClone` 或必要文件 API 时，启动页明确拒绝进入，不返回不完整功能。

## 10. 测试数据边界

首版只附带明确 `qualityStatus: 'test_fixture'` 的合成营养快照、食谱模板、七个日菜单和目录闭合图。生产 `reviewed` 数据集不进入测试制品。

首次使用必须确认：

- 只输入虚拟身体数据、目标和训练；
- 不上传个人照片；
- 营养和餐单仅用于验证流程；
- 不依据结果调整真实饮食或训练。

未确认时只能查看隐私和测试说明。确认版本变化后必须重新确认。应用壳、规划结果、餐单、助手和导出持续显示“内部测试数据，不可用于真实饮食安排”，不能通过设置关闭。

## 11. 测试 LLM 构建配置

测试人员不配置 Key。测试构建只读取：

```text
VITE_TEST_LLM_BASE_URL
VITE_TEST_LLM_API_KEY
VITE_TEST_LLM_MODEL
```

这些值放在根级或 Web 工作区的 `.env.test.local`，文件被 `.gitignore` 明确排除。仓库只提交变量名示例，不提交可用值。

`build:web:test` 必须：

- 缺少任一值时失败；
- 拒绝非 HTTPS Base URL，只有显式本地开发模式允许 `http://127.0.0.1`；
- 固定 Provider 域名和模型，不暴露运行时编辑入口；
- 关闭 production source map；
- 输出到被忽略的测试制品目录；
- 注入显著内部测试构建标识；
- 生成只允许自身资源和固定 LLM 域名的 CSP；
- 不包含第三方统计、广告、远程脚本或远程字体。

普通 `build:web` 不包含可用测试 Key；如果检测到 `VITE_TEST_LLM_API_KEY` 则失败，防止误把内部测试凭据带入其他构建。

测试 Key 被视为可能公开提取。运行前必须使用独立供应商 Key，并在供应商侧设置最低可用余额/额度、并发和有效期；测试结束立即撤销。仓库工具只检查 present/missing 和配置格式，不打印值。

## 12. 浏览器 LLM Backend 与受限助手

`OpenAICompatibleBrowserBackend` 实现现有 `AssistantLanguageModelBackend`，只调用构建时固定的 endpoint/model。首版使用非流式 JSON 请求，不接受页面传入 URL、模型、headers 或工具。

继续复用：

- 最近 12 条消息和结构化摘要；
- 20 秒单次超时；
- 仅传输/超时重试一次；
- 三次完整失败后熔断 60 秒；
- 半开单探测；
- 严格 envelope 和字段白名单观察；
- 首次非法模型输出最多修复一次；
- `move_training_day`、`replace_meal`、`resize_meal_portion` 三项命令；
- 用户原文证据、版本、过去事实、库存、营养、锁定和过敏原门禁。

浏览器 Backend 将 CORS、401/403、429、超时、无效 JSON、无效 schema 和网络断开映射为稳定错误。页面不展示供应商正文或 Key。模型不可用时显示结构化操作入口，不能阻断已有计划查看和确定性编辑。

## 13. 食材图片流程

图片只接受 JPEG/PNG。选择后先在页面内存中读取，验证类型和尺寸，再缩放到适合测试模型的上限；处理结果不写入 IndexedDB、Cache Storage、OPFS 或可恢复草稿。

发送前页面明确提示图片会直接提交给配置的第三方 LLM 服务。测试人员必须使用非个人、非敏感的食物测试图片。

多模态响应最多包含五个候选名称、置信度和食物状态。响应必须通过严格 schema，名称必须映射到当前测试数据集的标准食材 ID。模型不得返回或决定克数、营养值或用户身份。

确认前库存、营养、餐单、重算和 outbox 不改变。用户选择候选并输入正整数克数后，公开应用服务在一个 IndexedDB 事务内追加图片确认结构和库存版本。图片内存随后立即释放。识别失败、模型不支持图片或 CORS 不可用时隐藏/关闭识别能力并保留手动库存录入。

## 14. 页面与路由

- `/`：测试范围确认、浏览器能力、LLM 非敏感状态和本地数据摘要。
- `/setup`：身体档案、目标和一周训练分步表单。
- `/plan`：每日能量与营养目标、适用范围、策略和来源引用。
- `/meals`：库存、七日餐单、锁定、换菜、份量、训练完成度和待确认差异。
- `/ingredients/photo`：内存图片识别、候选确认和手动降级。
- `/assistant`：三项受限对话和结构化恢复入口。
- `/data`：摘要、个人数据导出、完整备份、恢复和删除本地账户。
- `/privacy`：测试边界、LLM 数据发送、AI 标识、非医疗说明和本地数据生命周期。

共享应用壳包含测试数据横幅、主导航、当前本地保存状态、估算标识、AI 辅助标识和统一错误区域。移动端使用单列步骤与底部主要动作，桌面使用有限宽度内容区；不为了视觉效果隐藏来源、冲突或恢复操作。

## 15. 备份、恢复、导出与删除

现有白名单个人数据导出继续用于查看，不作为可恢复备份。

新增 `fitness-local-backup-v1`，包含：

- backup schema 版本；
- 创建时间；
- 应用 schema 版本；
- 测试数据集 ID/版本；
- 完整 `PlanningAggregateState`；
- 规范化 payload SHA-256。

备份排除 API Key、Base URL 内部 header、测试构建秘密、临时图片、Provider 请求正文和浏览器内部定位符。恢复只接受本格式，在事务外完成文件读取、大小限制、schema/checksum/聚合校验，在单个事务中替换空库。非空库恢复必须先显示现有摘要并要求明确覆盖确认；任何失败保持旧库字节不变。

启动时调用 `navigator.storage.persisted()` 并尝试 `persist()`。未获得持久化时显示固定备份提醒，不伪报数据安全。

删除本地账户要求当前 snapshot token、固定确认语句和二次确认。成功后删除 IndexedDB、页面草稿、助手恢复状态和内存图片，并回到测试确认页。因为没有云端对象，不存在异步对象存储清理或账户 tombstone。

## 16. 错误与恢复

公开错误按边界分类：

- 浏览器能力：`browser_capability_unsupported`
- 本地数据库：`local_database_unavailable`、`local_database_upgrade_blocked`
- 并发：`local_revision_conflict`
- 容量：`account_capacity_exceeded`
- 备份：`backup_invalid`、`backup_dataset_mismatch`
- 测试数据：`local_test_dataset_invalid`
- LLM：`provider_cors_unavailable`、`provider_auth_failed`、`provider_rate_limited`、`provider_unavailable`
- 图片：`image_invalid`、`vision_unavailable`、`candidate_not_confirmed`

页面错误映射必须穷举，不显示堆栈、Key、请求正文、完整身体数据或第三方响应。事务失败保持旧活动状态；模型失败不创建 received/validated 之外的伪成功；备份恢复失败不部分覆盖；图片识别失败不写库存。

## 17. 自动化测试策略

实现继续遵循 RED → GREEN → REFACTOR。

### 保留的核心测试

- 公式、单位、舍入、适用范围和策略版本；
- 蛋白质、脂肪、碳水、纤维、糖和无解；
- 版本链、未来影响范围、整周守恒、幂等和回滚；
- 餐单营养复算、库存、锁定/手改和过敏原属性；
- Agent schema、证据、一次修复、白名单工具和 Provider 韧性。

### 新增浏览器层测试

- `fake-indexeddb`：空库、schema 创建/升级、原子事务、revision、容量、checksum、备份恢复和删除；
- React Testing Library：启动确认、表单、路由、错误映射、恢复按钮、AI/估算/测试标识；
- fetch 固定桩：成功、CORS 类网络失败、401、429、超时、非法 JSON、非法模型 schema和一次修复；
- 图片：类型/大小、内存释放、候选映射、确认前零副作用、手动降级；
- Playwright Chromium/WebKit：完整七日流程、刷新持久化、多标签冲突、锁定差异、助手命令、备份覆盖、删除和空库重建。

普通 `pnpm test` 和 E2E 不访问实时模型。显式 `web:test:preflight` 使用 `.env.test.local` 发送最小合成文本请求和可选合成图片，只输出固定状态、延迟和 token 统计，不输出请求/响应正文。

## 18. 分阶段实施与退出条件

### 7W-0：决策、规格与实施计划

交付 ADR、本设计、更新后的动态进度清单和详细 TDD 实施计划。退出前不得安装框架或修改业务运行代码。

### 7W-1：Web 基础与浏览器兼容

交付 React/Vite 工作区、路由壳、测试横幅、构建模式、CSP、浏览器 SHA-256 和能力门禁。退出条件是新增测试、lint、类型检查和无 Key Web 构建通过。

### 7W-2：IndexedDB 与本地数据权利

交付 Dexie repository、revision/BroadcastChannel、测试数据集、持久存储状态、备份/恢复和删除。退出条件是仓储/升级/容量/并发/恢复原子性测试通过。

### 7W-3：结构化规划 Web 流程

交付启动、隐私、建档、目标、训练和每日目标页面。退出条件是支持/不支持范围、版本历史、刷新恢复和完整结构化规划 E2E 通过。

### 7W-4：库存、餐单与执行闭环

交付库存、七日餐单、锁定、换菜、份量、训练完成度、重算差异和失败恢复。退出条件是现有阶段四规则和浏览器完整餐单 E2E 通过。

### 7W-5：浏览器 LLM 与图片候选

交付测试构建配置、OpenAI-compatible Backend、受限助手、内存图片和手动降级。退出条件是固定桩全覆盖、测试 Key 扫描和显式真实预检可安全运行。

### 7W-6：功能对等、旧平台删除与测试交接

先完成 Chromium/WebKit 全流程、秘密扫描、未跟踪制品和五人验收清单；再删除小程序、云函数、CloudBase 适配器、脚本、配置和部署文档。退出条件是最终全量门禁通过，活动源码扫描无 `wx.*` 或 CloudBase 运行依赖，动态进度清单记录真实结果。

## 19. 最终验证命令基线

详细实施计划必须建立并实际运行至少以下命令：

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build:web
pnpm.cmd test:web:e2e
pnpm.cmd scan:web-secrets
git diff --check
```

带真实测试配置的命令必须显式执行，且不属于普通 CI：

```powershell
pnpm.cmd build:web:test
pnpm.cmd web:test:preflight
```

在 7W-6 删除旧平台前，还必须运行活动源码边界扫描，证明不存在小程序/CloudBase 入口。命令名可在实施计划中按根脚本一致性调整，但不得减少验证语义。

## 20. 完成判定

只有以下事实同时成立，阶段七才能标记为完成：

- 7W-0 至 7W-6 均有进入 `feat/v1.0` 的实现、测试和验证证据；
- 五人以内测试所需 Web 流程可从空库完成，刷新、冲突、失败、备份和删除可恢复；
- 测试构建只使用虚拟数据并持续显示内部测试边界；
- 真实测试 Key 未进入已跟踪文件、Git、日志、备份、导出或证据；
- 原始图片不持久化，候选确认前不写库存；
- 确定性计算、版本、过敏原和锁定保护无回归；
- 小程序、云函数、CloudBase SDK 和运行配置已从活动代码删除；
- 所有要求的 fresh 命令真实通过并记录结果；
- `DEVELOPMENT_PROGRESS.md` 更新为“本地优先 Web 内部测试版已交付”；
- 结论明确为内部虚拟数据测试就绪，不宣称生产就绪、公开发布或真实营养建议可用。
