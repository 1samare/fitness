# Fitness Local-First Web Test

> 项目状态：虚拟数据 Web 内测已交付，非生产。
> 动态进度真源：[`DEVELOPMENT_PROGRESS.md`](DEVELOPMENT_PROGRESS.md)
> 架构决策：[`ADR-0001-local-first-web-test-application.md`](docs/decisions/ADR-0001-local-first-web-test-application.md)

## 项目目标

本仓库提供面向中国大陆健康成年人的一周健身与饮食规划内部测试应用。流程固定为：

```text
身体档案/偏好 -> 目标 -> 一周训练计划 -> 每日营养目标 -> 七日餐单 -> 执行反馈
```

当前交付只使用合成测试数据，最多供 5 名已授权内部测试人员使用。它不是医疗产品，不支持疾病、孕期、未成年人、康复、进食障碍或极端节食建议，也不代表生产上线就绪。

## 当前架构

- 客户端：React 18、TypeScript、Vite。
- 本地数据库：IndexedDB + Dexie，仅限当前浏览器 origin。
- 领域与计算：仓库内纯 TypeScript，热量、营养和克数不由模型产生。
- Agent：LangGraph.js 单 Agent，仅在访问助手页时动态加载。
- AI：普通构建完全禁用；显式测试构建可从浏览器调用一个 OpenAI-compatible 文本/视觉端点。
- 图片：只在内存中解码、缩放和发送；不写入 IndexedDB、备份或文件系统。
- 测试数据：版本化、带 checksum 的本地合成营养和餐单 fixture。
- 备份：`fitness-local-backup-v1` JSON；恢复要求数据集身份匹配和明确覆盖确认。

仓库没有小程序、云函数、远程数据库、云端对象存储、服务端身份或 CloudBase 运行时。

## 本地运行

环境：Node.js `20` 或 `22`，pnpm `9.15.x`。

```powershell
pnpm install --offline
pnpm dev:web
```

普通构建不接受测试模型 Key：

```powershell
pnpm build:web
```

测试模型只允许配置在被忽略的 `.env.test.local`：

```dotenv
VITE_TEST_LLM_BASE_URL=https://example.invalid/v1
VITE_TEST_LLM_API_KEY=replace-with-short-lived-test-key
VITE_TEST_LLM_MODEL=explicit-test-model-id
```

显式授权后才运行：

```powershell
pnpm web:test:preflight
pnpm build:web:test
```

预检只输出可用性、延迟、请求 ID 是否存在和 token 总数，不记录 Key、请求正文或响应正文。测试结束后必须撤销 Key，并删除私有环境文件、测试构建和浏览器站点数据。

## 验证命令

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:web
pnpm build:web
pnpm build:web:test
pnpm test:web:e2e
pnpm scan:web-secrets
pnpm scan:web-boundaries
git diff --check
```

Playwright 使用 Chromium 与 WebKit，自动化模型请求只命中本机固定桩，不访问实时付费模型。完整交接与最多 5 人签收表见 [`docs/testing/local-web-internal-test-handoff.md`](docs/testing/local-web-internal-test-handoff.md)。

## 产品与安全边界

- 自动个性化能量目标仅支持 18-45 岁、BMI `18.5-<24.0` 且完成最小化健康排除项确认的健康成年人。
- 训练和 PAL 分开计算，避免重复计入。
- 训练计划变化只重算生效日起的未来日期；过去事实不改写。
- 锁定或手改餐单不会被静默覆盖。
- 过敏原、忌口、来源完整性和营养可行性是硬约束。
- 约束无解时返回 `nutrition_constraints_infeasible`，不得伪造数值或放宽安全边界。
- 所有写入使用预期版本和幂等键；并发旧版本写入必须失败。
- 备份不包含测试 API Key、原始图片、图片 data URL 或浏览器临时状态。
- 删除要求精确短语 `DELETE LOCAL DATA`，并清除 IndexedDB、页面草稿和助手恢复状态。

## 计算策略登记

当前确定性策略为 `calculation-policy-v2` 与 `nutrition-policy-v1`：

- BMR：`14.52 x weightKg - 155.88 x sexCode + 565.79`，男性 `0`、女性 `1`。
- 非训练 PAL：轻 `1.50`、中 `1.75`、重 `2.00`。
- 净训练消耗：`(MET - 1) x 3.5 x kg / 200 x minutes`。
- 维持、减脂、增肌初始调整：`0%`、`-10%`、`+5%`。
- 蛋白质：无计划训练采用成年人 RNI；一般运动/耐力 `1.4 g/kg/day`；规律抗阻/增肌 `1.6 g/kg/day`；自动推荐不超过 `2.0 g/kg/day`。
- 脂肪 `20%-30%E`，默认中点 `25%E`；饱和脂肪 `<10%E`。
- 碳水同时满足 `50%-65%E` 与至少 `120 g/day`。
- 膳食纤维 `25-30 g/day`，添加糖 `<10%E`。

科学证据登记：

- `CN-DRI-2023`：《中国居民膳食营养素参考摄入量（2023 版）》；生产使用前仍需复核正式表格。
- `WS/T-428-2013`：成人体重判定相关行业标准，用于 BMI 范围边界。
- `ADULT-COMPENDIUM-2024`：2024 Adult Compendium 会话活动类别和来源代码，用于审核后的 MET 数据。
- 公式、常数、适用范围、生效日期、来源 ID 与复核时间均保存在版本化策略对象中；历史结果不会因策略更新被静默改写。

## 目录

```text
fitness/
|- apps/web/                 # 本地优先 Web 应用与 Playwright
|- packages/                 # domain/application/calculation/agent/providers/persistence/contracts
|- data/                     # 版本化动作与合成营养 fixture
|- docs/decisions/           # ADR
|- docs/superpowers/         # 历史设计与实施审计
|- docs/testing/             # 当前 Web 内测交接
|- DEVELOPMENT_PROGRESS.md   # 唯一动态进度真源
```
