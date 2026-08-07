# 阶段二 CloudBase 部署与验收

阶段二已实现可信微信身份、原子首次建档、不可变版本链、受影响日期重算、幂等重试、`TrainingPlanChanged` outbox，以及 CloudBase schema v2 聚合校验。仓库不保存真实 CloudBase 环境 ID、微信 AppID、OpenID、密钥或用户数据。

## 部署前提

- 本机 `project.config.json` 已配置真实微信小程序 AppID；该个人配置不得提交。
- 已创建 CloudBase 开发环境，并将环境 ID 临时放入 `FITNESS_PHASE2_ENV_ID`。
- 微信开发者工具已登录具有该小程序和环境部署权限的账号。
- 账号 A 可先完成单用户验收；完整阶段二验收仍需要第二个微信账号 B。

## 构建与本地门禁

在仓库根目录执行：

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd build:miniprogram:local
pnpm.cmd dry-run:api
pnpm.cmd smoke:api
```

`pnpm.cmd build` 会先构建工作区，再把已打包云函数复制到忽略的 `.build/cloudfunctions/planning-api`。部署目录只能包含 `index.js` 和无依赖的 `package.json`，不得包含源码映射、工作区源码、`node_modules` 或本地配置。

## 选择本地 AppID 与开发环境

不要把真实标识写进命令脚本或文档。当前 PowerShell 会话中按以下方式读取本地 AppID，并从环境变量读取环境 ID：

```powershell
$phase2Repo = (Resolve-Path '.').Path
$phase2Project = Get-Content -Raw -Encoding UTF8 project.config.json | ConvertFrom-Json
$phase2AppId = [string]$phase2Project.appid
$phase2EnvId = $env:FITNESS_PHASE2_ENV_ID
$wechatCli = 'D:\Program Files\微信web开发者工具\cli.bat'
if ([string]::IsNullOrWhiteSpace($phase2EnvId)) { throw 'FITNESS_PHASE2_ENV_ID is required' }
if ($phase2AppId -eq 'touristappid') { throw 'A real local AppID is required' }
& $wechatCli cloud functions deploy --env $phase2EnvId --paths (Join-Path $phase2Repo '.build\cloudfunctions\planning-api') --appid $phase2AppId
& $wechatCli cloud functions list --env $phase2EnvId --appid $phase2AppId
```

部署前先使用开发者工具 CLI 的 `islogin` 和 `cloud env list` 核对登录状态、AppID 与环境 ID。任何一项与本地授权值不一致时停止，不部署到其他环境。

## 数据与权限规则

阶段二只使用 `planning_user_states` 集合。文档 ID 是服务端可信 OpenID 的 SHA-256；客户端请求不得携带 `userId`，也不能直接读写业务集合。所有读写通过 `planning-api` 云函数完成。

在已认证的 CloudBase 控制台发布：

- `cloudbase/database.rules.json`：拒绝客户端直接读写业务数据。
- `cloudbase/function.rules.json`：只允许已认证用户调用 `planning-api`。

聚合文档从 `schemaVersion: 2` 开始。阶段二此前未部署真实数据，因此不提供隐式 v1 迁移；读取 v1、结构损坏或语义不一致的状态都会失败关闭。

## 行为说明

- 首次建档使用一个服务端事务，同时保存档案、目标、训练计划、允许日期的能量目标、一个幂等结果和一个待处理 outbox 事件；失败时不留下部分版本。
- 小程序在网络调用前保存完整复合请求；响应丢失时复用相同请求和幂等键。
- 当前上下文返回身体档案、目标、训练计划的一致活动链，并额外返回三类历史版本计数。
- 同周训练移动、取消、添加或修改时长，只重算变化涉及的未来日期；过去日期和无关日期不追加版本。
- `nutrition-policy-v1` 只是每日目标的追溯字段，阶段二不生成宏量营养、食材重量、食谱或餐单。

## 账号 A 云端验收

1. 提交一个无训练或使用审核会话的完整七日表单。
2. 模拟丢失响应并重试，确认返回相同版本 ID，聚合数组不重复增长。
3. 用同一幂等键改变负载，确认返回 `idempotency_key_reused`。
4. 使用过期版本计数提交，确认返回 `version_conflict`。
5. 检查每日目标包含身体档案、目标、训练计划、`calculation-policy-v2`、`nutrition-policy-v1` 五类引用。
6. 移动或取消未来训练，确认只为旧/新日期追加目标版本，outbox 事件的 `affectedDates` 完全一致。
7. 确认客户端额外携带 `userId` 会被严格 schema 拒绝。

## 账号 B 隔离验收

将第二个微信添加为体验成员后：

1. 账号 B 首次打开时当前上下文必须为空。
2. 账号 B 创建自己的规划后，账号 A 仍只能看到 A 的历史版本与活动链。
3. 验收记录只写匿名标签 `user-A`、`user-B` 和不含 OpenID 的版本/事件 ID。

如果第二个微信尚未加入，只能声明“代码、部署和单账号验收完成”，不得声明完整阶段二云端验收完成。
