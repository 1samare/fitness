# Fitness 第一阶段本地可运行架构设计

日期：2026-07-30  
状态：用户已确认  
目标：在不依赖真实 CloudBase 环境、模型或付费供应商的前提下，建立一个可以在本机编译、测试、启动并由微信开发者工具访问的真实业务纵向切片。

## 1. 背景与范围

本设计继承 `2026-07-30-fitness-planning-design.md`、`README.md` 和 `AGENTS.md` 的全部产品、安全、计算与架构约束。第一阶段不是完整 MVP，也不创建未被使用的空目录或占位模块；它只实现足以验证架构边界和本地运行链路的第一个真实业务能力：

```text
身体档案 + 健身目标 + 当日训练会话
  → 运行时 DTO 校验
  → calculation-policy-v2 适用范围门禁
  → 确定性每日能量规划预览
  → 微信小程序展示估算结果、策略版本和来源
```

第一阶段包含健康检查和每日能量规划预览，不保存用户数据，不生成食谱，不调用 LLM、视觉、营养 API、数据库或对象存储。后续阶段只有出现真实用例时，才增加 Agent、Provider、持久化和食谱模块。

## 2. 方案选择

采用“最小真实纵向切片”，不采用以下方案：

- 不一次性创建所有建议目录和空导出，因为这会形成无法验证行为的演示性空壳。
- 不立即连接真实 CloudBase 开发环境，因为第一阶段的本地启动不应依赖账号、环境 ID、密钥或网络服务。
- 不实现独立常驻生产服务器；本地 HTTP 入口只是 CloudBase 函数的开发调试适配层。

该方案优先证明跨端契约、分层依赖、确定性计算和微信小程序调用链均能工作，同时保留后续部署到 CloudBase Node.js 云函数的入口形态。

## 3. 技术基线

- 包管理：pnpm workspace，使用本机已安装的 pnpm 9。
- 语言：TypeScript 严格模式，禁止无理由的 `any`、非空断言和类型逃逸。
- 本地 Node.js：本机 Node.js 22；编译产物保持 CloudBase Node.js 20.19 兼容。
- 运行时校验：Zod；TypeScript 类型从同一 schema 推导。
- 测试：Vitest；HTTP/函数入口使用真实应用服务，外部服务不参与常规测试。
- 代码质量：ESLint、TypeScript 项目引用和统一格式检查。
- 小程序：微信原生小程序 TypeScript，不引入跨端 UI 框架。
- 本地云函数：项目内安装 `@cloudbase/functions-framework`，使用 `tcb-ff` 启动，不依赖全局 CLI。

仓库不提交 `node_modules`、构建产物、日志、真实 AppID、环境 ID、密钥或个人数据。

## 4. 目录与职责

```text
fitness/
├─ miniprogram/
│  ├─ app.ts
│  ├─ app.json
│  ├─ app.wxss
│  ├─ pages/planning-preview/     # 真实规划预览表单和结果页
│  └─ services/planning-api.ts    # 本地/云端调用方式的客户端边界
├─ cloudfunctions/
│  └─ planning-api/
│     ├─ src/index.ts             # CloudBase main 入口
│     └─ package.json             # 可独立部署的函数清单
├─ packages/
│  ├─ contracts/                  # 请求、响应与错误 schema
│  ├─ domain/                     # 目标、训练会话和结果模型
│  ├─ calculation/                # calculation-policy-v2 纯计算
│  └─ application/                # 规划预览用例编排
├─ data/
│  └─ met-sessions/               # 第一批经审核的会话级 MET 映射
├─ tests/
│  └─ smoke/                      # 本地函数进程级冒烟测试
├─ scripts/                       # 本地启动、冒烟与开发者工具编译脚本
├─ docs/
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ eslint.config.js
├─ project.config.json
└─ project.private.config.example.json
```

只创建上述第一阶段实际使用的模块。`agent`、`providers`、食谱和数据库适配器目录不在本阶段创建。

## 5. 依赖方向

```text
miniprogram page
  → miniprogram planning API client
    → cloudfunctions/planning-api controller
      → packages/application use case
        → packages/domain
        → packages/calculation

packages/contracts
  ← miniprogram client
  ← cloud function controller
```

约束如下：

- `calculation` 只依赖领域值对象和审核后的静态策略数据，不访问网络、数据库、时间或随机数。
- `domain` 不导入 Zod、CloudBase SDK、微信 API、LangGraph 或供应商 DTO。
- `application` 只编排公开领域和计算接口，不解析 HTTP，也不访问数据库。
- 云函数控制器负责 schema 校验、动作路由、错误转换和响应封装。
- 小程序页面不复制公式、策略常量或业务门禁。
- 所有 package 依赖保持单向，不允许循环依赖。

## 6. 第一阶段业务能力

### 6.1 健康检查

请求动作：`health`。

响应至少包含：

- `status: "ok"`
- `service: "planning-api"`
- `policyVersion: "calculation-policy-v2"`

健康检查只证明函数入口和依赖装载正常，不访问外部资源。

### 6.2 每日能量规划预览

请求动作：`previewDailyEnergy`。

输入包含：

- 年龄、公式所需性别编码、身高、体重。
- 最小化健康排除项确认。
- 不含显式训练的日常活动等级：`light | moderate | heavy`。
- 目标：`maintain | fat_loss | muscle_gain`。
- 可选的当日训练会话代码和有效分钟数。

客户端不得直接提交 MET 数值。训练会话代码只能映射到仓库内已审核记录。第一阶段提供无训练分支，以及 2024 Adult Compendium 会话代码 `02054`：多动作抗阻训练、每组 8–15 次且阻力变化，MET `3.5`。记录必须同时保存 `sourceId: "MET-COMPENDIUM-2024"`、原始活动描述、版本和审核日期。

成功输出包含：

- `kind: "supported"`
- 估算 BMR。
- 非训练基线消耗。
- 当日训练净消耗。
- 估算维持消耗。
- 目标能量起点。
- `policyVersion`、`sourceIds`、适用范围和统一舍入说明。
- 明确的“初始估算、非医疗建议”提示。

不满足年龄、BMI、健康确认或必需输入时，返回：

- `kind: "unsupported"`
- `code: "unsupported_for_personalized_energy"`
- 结构化原因列表。
- 不返回自动减脂或增肌热量。

输入格式错误与产品范围不支持是两类不同结果：前者由 schema 拒绝，后者由领域门禁返回。

## 7. 确定性计算

策略对象集中保存并导出以下元数据：

- `policyVersion: "calculation-policy-v2"`
- `sourceIds`
- `applicableAgeRange: [18, 45]`
- `applicableBmiRange: [18.5, 24.0)`
- `effectiveDate`
- `reviewedAt`
- PAL、目标调整、公式常量和统一舍入规则。

计算顺序固定：

1. 校验必需输入和最小化健康排除项。
2. 使用 `weightKg / (heightM × heightM)` 计算 BMI，并按未舍入值判断 `18.5–<24.0`。
3. 使用 `14.52 × weightKg - 155.88 × sexCode + 565.79` 计算估算 BMR。
4. 使用不含显式训练的 PAL `1.50 / 1.75 / 2.00` 计算非训练基线。
5. 从审核映射读取 MET，并使用 `(MET - 1) × 3.5 × weightKg / 200 × minutes` 计算训练净消耗。
6. 将训练净消耗加入非训练基线，得到估算维持消耗。
7. 对维持、减脂、增肌分别应用 `0% / -10% / +5%` 初始调整；不得自动扩大盈亏。
8. 仅在显示边界执行统一舍入，内部计算不使用已舍入中间值。

第一阶段不实现宏量营养素和食谱约束求解；该边界必须在页面和文档中明确，避免把能量预览误称为完整饮食计划。

## 8. 跨端契约与错误处理

函数入口采用受控动作联合类型，只允许 `health` 和 `previewDailyEnergy`。未知动作、额外危险字段和不合法类型不得透传到应用层。

响应使用判别联合：

- `success: true`：包含健康结果或受支持/不支持的业务结果。
- `success: false`：只包含稳定错误码、面向用户的非敏感消息和字段级问题；不返回堆栈。

第一阶段错误映射：

- `invalid_request`：schema 校验失败。
- `unknown_action`：不在白名单中的动作。
- `unknown_training_session`：训练会话没有审核映射。
- `unsupported_for_personalized_energy`：适用范围门禁失败，这是业务结果而非服务器故障。
- `internal_error`：未预期错误；日志不得记录完整身体档案或请求正文。

本地开发日志默认关闭请求体和上下文原文记录。小程序展示可恢复错误，并允许用户修正表单，不使用虚构默认值重试。

## 9. 本地运行链路

标准流程：

1. `pnpm install` 安装工作区依赖。
2. `pnpm build` 编译共享包、云函数和小程序 TypeScript。
3. `pnpm dev:api` 从已编译的函数入口启动 `tcb-ff`，监听 `127.0.0.1:3000`。
4. `pnpm smoke:api` 对健康检查、受支持预览和不支持预览执行真实 HTTP 请求。
5. 使用仓库脚本调用已安装的微信开发者工具 CLI，对 `project.config.json` 指向的小程序执行编译。
6. 开发者工具中的小程序通过开发环境 API 客户端调用本地函数；生产调用方式保留独立适配入口，但本阶段不连接云端。

本地基础 URL 只能来自非敏感开发配置，默认 `http://127.0.0.1:3000`。生产构建不得接受客户端自定义任意 URL。

CloudBase 部署配置使用 `cloudfunctions` 作为函数根目录，运行时目标为 `Nodejs20.19`；环境 ID 不写入仓库，由后续开发环境配置提供。

## 10. 测试策略

所有生产逻辑遵循先失败测试、再最小实现、最后重构的顺序。

### 10.1 合同测试

- 合法健康检查和预览请求通过。
- 缺失字段、非法枚举、非有限数值、额外动作和客户端 MET 被拒绝。
- 响应判别联合可以由小程序和函数双方解析。

### 10.2 计算单元测试

- 年龄 `18`、`45` 支持，`17`、`46` 不支持。
- BMI `18.5` 支持，`24.0` 不支持，并使用未舍入 BMI 判断。
- 男性 `sexCode=0`、女性 `sexCode=1` 的公式分支正确。
- PAL 不包含显式训练，训练消耗只额外加入一次。
- 无训练时训练净消耗为零。
- 会话 `02054` 只能从审核映射得到 MET 和来源 ID。
- 维持、减脂、增肌使用 `0% / -10% / +5%`，不存在自动扩大逻辑。
- 中间值不提前舍入，最终输出遵循统一规则。
- 每个支持结果包含策略版本和来源 ID。

### 10.3 应用与入口测试

- 应用服务对合法输入返回真实计算结果。
- 不支持范围不返回自动目标能量。
- 未知会话、未知动作和 schema 错误映射到稳定错误码。
- 测试使用真实计算和应用服务，不用 mock 替代被测业务行为。

### 10.4 进程级冒烟测试

- 启动本地函数进程并等待健康响应。
- 调用一个受支持案例并核对可复算数值和策略元数据。
- 调用一个 BMI `24.0` 案例并核对关闭输出行为。
- 测试结束后只终止由测试启动的进程。

### 10.5 小程序编译验证

- 微信开发者工具 CLI 成功加载 `project.config.json`。
- TypeScript 编译和小程序构建无错误。
- 页面不包含公式常量、密钥或真实用户数据。

## 11. 第一阶段验收标准

只有以下证据全部存在时，第一阶段才可声明完成：

1. `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build` 均以退出码 `0` 完成。
2. `pnpm smoke:api` 启动真实本地函数并验证健康、受支持和不支持三个场景。
3. 微信开发者工具 CLI 编译项目成功；若工具必须登录或需要 AppID，明确记录该外部验证限制，不把命令行 TypeScript 构建冒充小程序编译。
4. 有效输入的页面结果可由结构化输入、策略对象和审核 MET 数据复算。
5. 不支持人群、缺失来源或非法请求不产生自动热量盈亏。
6. 常规测试没有访问实时 CloudBase、LLM、视觉、营养或其他付费 API。
7. 文档说明与真实脚本、目录和运行方式一致。
8. 通过文件扫描确认没有真实密钥、环境 ID、用户照片或个人信息 fixture。
9. 完成前检查工作区差异，确认没有覆盖无关用户文件；若目录仍不是 Git 仓库，则使用文件清单和内容检查代替 `git diff`，并明确这一限制。

## 12. 后续阶段边界

第一阶段完成后，按真实用例依次扩展：不可变档案和计划版本、CloudBase 数据库适配器、每日宏量营养目标、食谱约束求解、图片确认流程、Provider 适配器、单 Agent 状态图和云端部署。

任何后续工作仍须保持“页面 → 控制器 → 应用服务 → 领域/计算 → Provider 接口 → 适配器”的单向依赖，并在引入真实写操作时加入可信用户身份、预期版本和幂等键。

## 13. 参考依据

- 腾讯云开发 CloudBase：《Local Cloud Function Development》
- 腾讯云开发 CloudBase：《tcb-ff User Guide》
- 腾讯云开发 CloudBase：《配置文件-云函数》
- 2024 Adult Compendium of Physical Activities，Conditioning Exercise 会话代码 `02054`
- 仓库 `README.md` 的科学证据登记与 `calculation-policy-v2`

