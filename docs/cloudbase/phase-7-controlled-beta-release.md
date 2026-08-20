# 阶段七受控内测发布与回滚手册

本文是阶段七真实 CloudBase 受控内测的操作真源。它只保存公开步骤、变量名和通过/失败摘要；真实 AppID、环境 ID、OpenID、联系信息、数据集、合同、备份内容、函数详情 JSON、截图、fileID、供应商正文和密钥只能保存在访问受控的私有证据系统。

本地代码与发布工具通过不等于已经发布。只有审核数据、合规、真实预检、部署、双账号、Provider、数据权利、10×30 云端容量、恢复、前向回滚和 iOS/Android 设备证据全部通过，才能把阶段七标记为完成。

## 当前发布状态

截至 2026-08-20：

- 本地 7A/7B 代码与质量门禁已通过；
- 固定 CloudBase CLI `3.7.2` 的实时只读帮助已复核；
- 真实 CLI 的恢复命令位于 `db nosql backup time|collection|restore|task`；
- 固定版函数帮助未公开 `--yes`，本文不依赖该参数；
- 私有数据集、真实 AppID/环境、公开隐私元数据、合规批准和云端容量输入尚未提供；
- `release:preflight` 当前失败关闭；未执行数据导入、规则发布、函数部署、配置切换、恢复或其他云端写操作。

## 不可跳过的安全边界

1. 只在 `feat/v1.0` 的干净、不可变提交上发布；唯一允许的额外工作区状态是既有 `?? .pnpm-store/`。
2. 每次外部写入前，由发布操作者在私有界面再次核对登录主体和专用受控内测环境；命令输出不得复制到仓库或任务消息。
3. 既有函数只允许 `fn code update`；不得对带有效清理定时器的既有 `photo-cleanup` 使用 `fn deploy --force`。
4. 函数顺序固定为 `photo-cleanup` → `planning-api` → `assistant-api`，小程序最后发布。
5. 候选数据集先校验、导入和隔离复核，再只切换 `FITNESS_REVIEWED_DATASET_ID`；失败时恢复旧 ID，不修改旧数据集文档。
6. 恢复演练只写入两个固定的新集合名，永不覆盖在线集合；演练集合和测试账户的删除另行取得明确批准。
7. 全程保留一个 v8-aware 图片清理执行路径，不允许制造原图清理空窗或延长原删除期限。
8. 任何真实门禁失败都停止扩大内测；不得用 fixture、默认值、降级授权或手工修改历史数据绕过。

## 私有发布输入

以下值全部在仓库外配置，仓库只提供 `.env.example` 中的空名称：

- `FITNESS_REVIEWED_DATASET_FILE`
- `FITNESS_RELEASE_NOW`
- `FITNESS_REVIEWED_DATASET_ID`
- `FITNESS_CLOUDBASE_ENV_ID`
- `FITNESS_CLOUDBASE_CONFIGURED_NAMES`
- `FITNESS_PUBLIC_OPERATOR_NAME`
- `FITNESS_PUBLIC_PRIVACY_CONTACT`
- `FITNESS_PRIVACY_NOTICE_VERSION`
- `FITNESS_RESTORE_CHECK_TIME`
- `FITNESS_CLOUD_CAPACITY_INPUT_FILE`
- `project.private.config.json`

发布操作者还必须在私有证据系统关闭以下项目：正式 `CN-DRI-2023` 表格/页码复核、营养来源商业授权及缓存/派生/展示/退出条款、模型备案/登记与 AI 内容标识、微信隐私材料、服务端配置/IAM/配额、各类费用预算与告警。每项都要有 owner、证据引用、复核日期和 `approved` 状态。

## 1. 冻结提交与固定 CLI

先执行只读冻结检查：

```powershell
git branch --show-current
git status --short
git rev-parse HEAD
git diff --check
```

把提交 SHA、时间和操作者保存在私有发布证据中。之后若源码或发布文档变化，重新提交、重跑本地门禁并产生新的冻结点。

固定 CLI 的实时帮助是命令面的最终依据：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb --version
npx -y --package @cloudbase/cli@3.7.2 tcb fn deploy --help
npx -y --package @cloudbase/cli@3.7.2 tcb fn code update --help
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql backup time --help
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql backup collection --help
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql backup restore --help
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql backup task --help
```

顶层 `-e, --env-id` 用于选择环境。固定版 3.7.2 的函数子命令帮助没有公开 `--yes`；不要根据网页文档猜测隐藏参数。命令面再次漂移时停止，不执行写操作，先更新并复核本文。

## 2. 审核数据、恢复点和发布预检

候选数据集必须位于仓库外的绝对路径。先运行：

```powershell
pnpm.cmd release:dataset
```

仅当 `.build/release-evidence/dataset-validation.json` 为 passed，且匿名证据的 dataset ID 哈希、版本、checksum、记录数量、验证时间均与私有审批记录一致时，才能在目标环境的 `planning_reviewed_datasets` 以精确 dataset ID 导入原样 checksummed 文档。此时不得切换活动 ID。

通过控制台只读视图隔离确认文档数量、版本和 checksum 后，验证可恢复范围：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql backup time -e $env:FITNESS_CLOUDBASE_ENV_ID
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql backup collection --time $env:FITNESS_RESTORE_CHECK_TIME --filters "planning_user_states,planning_reviewed_datasets" -e $env:FITNESS_CLOUDBASE_ENV_ID
```

两个命令的原始 JSON/环境标识只进入私有证据。确认两集合都可恢复后运行：

```powershell
pnpm.cmd release:preflight
pnpm.cmd release:check
```

二者必须退出 0。此时 `release:check` 可以使用 `local_baseline` 容量证据；最终交接前必须改为真实 `cloud_controlled_beta` 证据并重跑。

## 3. 构建、扫描与制品冻结

```powershell
pnpm.cmd build
pnpm.cmd build:miniprogram:release
pnpm.cmd release:scan
Get-FileHash -Algorithm SHA256 .build/cloudfunctions/photo-cleanup/index.js
Get-FileHash -Algorithm SHA256 .build/cloudfunctions/planning-api/index.js
Get-FileHash -Algorithm SHA256 .build/cloudfunctions/assistant-api/index.js
```

只把函数名、SHA-256 和生成时间写入私有证据；哈希后不得重建。每个函数目录只能包含 `index.js` 和 `package.json`。

## 4. 部署前只读检查

将以下 `--json` 输出直接保存到私有证据，不在终端转述真实值：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn detail photo-cleanup --json -e $env:FITNESS_CLOUDBASE_ENV_ID
npx -y --package @cloudbase/cli@3.7.2 tcb fn detail planning-api --json -e $env:FITNESS_CLOUDBASE_ENV_ID
npx -y --package @cloudbase/cli@3.7.2 tcb fn detail assistant-api --json -e $env:FITNESS_CLOUDBASE_ENV_ID
```

逐个分类为 existing/absent。existing 只更新代码；absent 才使用 deploy。先发布并复核数据库/存储/函数规则、planning→vision 最小 IAM、`state.nextPhotoCleanupAt ASC, state.userId ASC` 复合索引，以及所有非空清理时间文档的可信 `state.userId` 缺失数为 0。未通过时不得启用上传或定时器。

## 5. 前向部署

### 5.1 `photo-cleanup`

existing：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn code update photo-cleanup -e $env:FITNESS_CLOUDBASE_ENV_ID
```

absent：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn deploy photo-cleanup -e $env:FITNESS_CLOUDBASE_ENV_ID
```

先以管理员方式对可丢弃到期数据执行一次清理，验证对象删除/`not_found`。然后在控制台只激活 `photo-cleanup-every-15-minutes`，cron 为 `0 */15 * * * * *`。复核 Nodejs20.19、`index.main`、25 秒、客户端拒绝、定时器存在和代码版本/哈希。

### 5.2 数据集与 `planning-api`

只把 `FITNESS_REVIEWED_DATASET_ID` 切到已验证候选。随后 existing 使用：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn code update planning-api -e $env:FITNESS_CLOUDBASE_ENV_ID
```

absent 才使用：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn deploy planning-api -e $env:FITNESS_CLOUDBASE_ENV_ID
```

验证 Nodejs20.19、`index.main`、25 秒、authenticated-only、六个服务端配置名，以及 v2–v8 读取/v8 写入 smoke。失败时先恢复旧数据集 ID；planning smoke 未通过不得继续。

### 5.3 `assistant-api` 与小程序

planning 通过后，existing 使用：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn code update assistant-api -e $env:FITNESS_CLOUDBASE_ENV_ID
```

absent 才使用：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn deploy assistant-api -e $env:FITNESS_CLOUDBASE_ENV_ID
```

验证 Nodejs20.19、`index.main`、120 秒、authenticated-only、单一已批准 Provider/模型及 cleanup 客户端拒绝。最后用真实 `project.private.config.json` 打开 `.build/miniprogram`，人工核对 `controlled_beta`、运营主体、隐私联系入口和 notice version，再上传同一制品到微信受控测试渠道。

## 6. 真实验收矩阵

私有证据至少包含以下 pass/fail，不包含请求正文或个人数据：

| 门禁 | 最小证据 |
|---|---|
| 双身份完整流程 | A/B 两台设备分别完成建档→目标→训练→营养→库存→餐单→锁定/修改→反馈→助手→导出 |
| 身份隔离 | A/B 双向无法读写、导出、删除、枚举或下载对方数据/图片；客户端不能直访集合或 cleanup |
| 审核营养 | 成功生成七天餐单并独立复算；不存在 ID、过期/断链候选均失败关闭且旧活动数据恢复 |
| Vision | 非法 schema、8 秒超时、一次重试、三次失败熔断、60 秒半开、手动录入与恢复 |
| Assistant | 非法输出、一次修复、20 秒超时、一次重试、三次失败熔断、60 秒半开、单 Provider |
| 图片清理 | 确认后立即到期、未确认不超过 24 小时、15 分钟 worker、失败重试和 `not_found` 幂等 |
| 数据权利 | 双设备隐私页、导出、无图删除、图片删除失败/pending/同命令重试、重建账户 |
| 日志与费用 | 敏感扫描零命中；Provider 白名单字段；函数/数据库/存储/视觉/模型预算与告警有 owner |
| 设备 | 至少一台 iOS、一台 Android；前后台、重复点击、网络切换、图片重试、导出和删除重启 |

健康成年人边界、估算/非医疗文案、AI 内容标识和不支持人群停止建议必须在真实页面观察，不用构建退出码替代。

## 7. 10×30 云端容量

十个真实认证测试身份各执行固定 30 个操作。只收集身份哈希、耗时和终态类型，生成 mode 为 `cloud_controlled_beta` 的匿名输入并在仓库外设置 `FITNESS_CLOUD_CAPACITY_INPUT_FILE`：

```powershell
pnpm.cmd release:capacity
```

必须恰好 300 个操作，规划与 Provider 有界结果率均为 1，p95 小于 5 秒，跨用户泄漏、部分事务、重复有效版本、清理丢失、Provider 超时、配额和预算超限均为 0。还要在私有证据记录实际套餐/配额名称和成本是否在批准预算内。

## 8. 恢复与前向回滚

恢复前再次核对环境和时间，只写入固定新集合：

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql backup restore --time $env:FITNESS_RESTORE_CHECK_TIME --tables '[{"OldTableName":"planning_user_states","NewTableName":"planning_user_states_phase7_restore_drill"},{"OldTableName":"planning_reviewed_datasets","NewTableName":"planning_reviewed_datasets_phase7_restore_drill"}]' -e $env:FITNESS_CLOUDBASE_ENV_ID
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql backup task -e $env:FITNESS_CLOUDBASE_ENV_ID
```

任务成功后比较文档数量、schema 分布、匿名样本哈希、活动版本关系、数据集 checksum、A/B 隔离、清理期限、删除 pending 和助手 pending/回执。应用流量永不指向演练集合；已过期图片引用立即执行受控清理，绝不刷新保留期。

前向回滚只恢复旧审核数据集 ID 和上一组 v8-aware 函数，仍按 cleanup→planning→assistant；验证 v8 文档可读后，再按同一顺序重应用新版本并 smoke。不得部署 v7-only 制品或降级数据。

## 9. 证据保留与清理

截图、函数详情、环境配置、合同、备份/恢复输出、设备信息和测试身份映射只留在私有证据系统，并按批准期限删除。只有在比较完成且证据保留已确认后，另行请求明确授权删除：

```text
planning_user_states_phase7_restore_drill
planning_reviewed_datasets_phase7_restore_drill
专用可丢弃测试账户及其私有对象
```

未取得单独批准时保留原状并记录 owner；不得把清理隐含在发布或文档提交中。

## 10. 发布证据状态

| 日期 | 门禁 | 状态 | 说明 |
|---|---|---|---|
| 2026-08-20 | 本地 7A/7B | passed | 104 个测试文件、970 项通过、1 项 Windows 条件跳过；构建、dry-run、smoke、local capacity、scan 通过 |
| 2026-08-20 | 固定 CLI 实时帮助 | passed | 3.7.2；确认顶层环境参数和嵌套 backup 恢复命令；未执行外部写入 |
| 2026-08-20 | 真实数据/预检 | blocked | 私有数据集、真实 AppID/环境、公开隐私元数据与合规批准未提供；预检失败关闭 |
| 2026-08-20 | 部署及真实验收 | not_started | 未导入、未切换、未部署、未恢复；阶段七保持进行中 |
