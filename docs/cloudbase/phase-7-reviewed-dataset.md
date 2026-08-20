# 阶段 7B：生产审核数据与发布门禁操作手册

## 当前结论

截至 2026-08-20，`reviewed-planning-dataset-v1` 严格契约、离线校验、CloudBase fail-closed Provider、发布预检、产物扫描、容量基线和 release-check 编排已完成本地实现与行为测试。

这不是生产数据或受控内测发布验收。仓库没有真实营养数据、商业授权证据、真实数据集 ID、AppID、CloudBase 环境 ID、供应商密钥或运营主体信息；真实导入、切换、供应商验收、备份恢复、双账号和设备测试仍由 7C 关闭。

## 数据集不可放宽约束

一个可候选的数据集必须同时满足：

- envelope 为严格 `reviewed-planning-dataset-v1`，审批状态只允许 `approved`，质量状态只允许 `reviewed`；
- `datasetId`、`datasetVersion`、review/activation/expiry 时间、SHA-256 和来源授权元数据齐全；
- 每个来源明确缓存许可、终端展示许可、授权到期日或无到期书面依据，以及退出后只保留历史引用的处置；
- 恰好七个日菜单；目录、菜单、菜谱、食材快照构成完整闭合图，不存在缺失边、错误 food ID、重复 ID 或不可达记录；
- 所有记录的 `datasetVersion`、`sourceId`、`reviewedAt` 和 `qualityStatus` 与 envelope 一致且可追溯；
- checksum 是删除 `checksumSha256` 后，对递归按键排序、保持数组顺序的 UTF-8 JSON 计算的小写 SHA-256；
- 校验时满足 `reviewedAt <= now < validUntil`，数据集有效期不得越过任何有期限来源授权。

供应商原始响应、凭据、合同正文和真实联系信息不得放入候选 JSON、仓库或公开发布证据。运行时禁止从外部营养 API 临时补数据。

## 候选数据集到活动数据集

必须严格按以下顺序操作，任何一步失败都停止，旧数据集继续有效：

1. 在线下取得来源及商业缓存/展示授权，完成来源、单位、食物状态、版本和审核时间复核。
2. 在仓库外的私有路径规范化为 `reviewed-planning-dataset-v1`；删除凭据、供应商原始正文和个人信息。
3. 将 `FITNESS_REVIEWED_DATASET_FILE` 设置为该私有候选文件的已解析绝对路径；可选设置受控 `FITNESS_RELEASE_NOW`，运行 `pnpm.cmd release:dataset`。
4. 核对 `.build/release-evidence/dataset-validation.json` 为 `passed`。证据只包含数据集 ID 哈希、版本、checksum、记录数和校验时间，不包含候选路径或原始 ID。
5. 把通过校验的同一份 checksummed 文档导入 `planning_reviewed_datasets`，文档 ID 必须等于其 `datasetId`；禁止导入后原地修改。
6. 在不改变活动 `FITNESS_REVIEWED_DATASET_ID` 的前提下，按文档 ID 独立读取并重复 checksum、许可窗口、闭合图和调用权限验证。
7. 备份当前活动数据集文档、`planning_user_states`、数据库/存储规则、IAM、索引、函数配置和活动数据集 ID，并验证恢复路径。
8. 只修改服务端 `FITNESS_REVIEWED_DATASET_ID`，不改客户端或历史文档；运行真实 planning/assistant Provider 验收及 `release:preflight`/`release:check`。

若第 8 步任何检查失败，立即恢复之前的数据集 ID，重跑读路径和用户计划回归；不得修改、删除或覆盖之前的活动数据集文档。候选校验或导入失败时也不得切换 ID。

以下运营字段必须保存在私有受控证据系统，不进入仓库：

```text
licenseOwner
authorizationEvidenceOwner
authorizationEvidenceReference
authorizationValidUntilOrNoExpiryBasis
expiryReviewDate
reviewerAndApprover
previousActiveDatasetIdHash
candidateDatasetIdHash
backupEvidenceReference
rollbackDecisionAndOwner
```

## 云端运行时语义

- planning 和 assistant 云函数都必须配置完全相同的 `FITNESS_REVIEWED_DATASET_ID`；缺失、空白或格式错误会在组合阶段失败。
- 每个函数实例只读取 `planning_reviewed_datasets/<configured-id>`，不会枚举、猜测或回退到 fixture/其他文档。
- 同一冷启动的并发读取共用一个 in-flight Promise；成功数据缓存 60 秒，读取超时固定 2,000 ms。
- 即使缓存未过期，每次公开方法也会重新检查当前时间是否仍处于数据集和来源授权窗口。
- 缺失文档、数据库失败、超时、checksum/许可/闭图失败或记录 ID 不存在统一失败关闭；公开 API 只返回既有 `provider_unavailable`，不暴露数据集正文。
- 返回的快照、菜谱、菜单和目录均为深拷贝；名称规范化使用现有中文空白/大小写规则，歧义或缺失返回 `null`，不猜测。

## 发布预检与制品扫描

`pnpm.cmd release:preflight` 要求：

- `project.private.config.json` 中存在非 tourist AppID；只输出 `AppID: present`，不输出值；
- 选择目标 `FITNESS_CLOUDBASE_ENV_ID`；
- 三项非本地占位的公开隐私元数据；
- `FITNESS_REVIEWED_DATASET_ID` 与 24 小时内、checksum 匹配的数据集校验证据；
- CloudBase CLI 精确版本 `3.7.2`；
- `FITNESS_CLOUDBASE_CONFIGURED_NAMES` 只列服务端配置名称且包含 manifest 全集；
- `cloudbaserc.json`、唯一 photo-cleanup timer 配置、Node.js 20.19 runtime、handler、timeout 和 `installDependency` 与 manifest 完全一致；
- 所有发布源文件均已 Git 跟踪。

`pnpm.cmd build:miniprogram:release` 只构建 `controlled_beta` 通道，并拒绝本地占位运营信息。`pnpm.cmd release:scan` 只接受三个函数目录，各目录只含 `index.js`/`package.json`，同时扫描小程序和匿名证据；拒绝 sourcemap、测试/fixture、`node_modules`、私有配置、符号链接、OpenID、Base64 图片、具体 cloud fileID 和疑似凭据值。报告只输出相对路径和规则 ID。

`pnpm.cmd release:check` 按固定顺序 fail-fast 执行 preflight、lint、typecheck、test、build、三个 dry-run、两个 smoke、dataset、capacity、scan 和 Git 审计。只有全部成功且工作区除既有 `.pnpm-store/` 外干净时，才原子写入匿名 release-check 证据。

## 本地容量基线

`pnpm.cmd release:capacity` 会启动只监听 `127.0.0.1` 的本地真实 planning handler，验证：

- UTF-8 聚合恰好 `3,000,000` 字节，严格导出小于 6 MB 且通过公共响应 schema；
- 增加 1 字节返回 `account_capacity_exceeded`，事务前后聚合仍为 `3,000,000` 字节；
- `tester-01` 至 `tester-10` 各执行 30 次固定混合操作，总计 300 次；
- 注入一次 Provider 重算失败后旧活动餐单保留、任务可重试且只产生一个有效后继版本；
- planning 成功率、Provider 成功或固定降级率均为 100%，p95 小于 5 秒，隔离/部分事务/重复有效版本/丢失清理/Provider 超时/配额计数均为 0，预算未超限。

最终 `.build/release-evidence/capacity-validation.json` 只保存身份标签 SHA-256 和聚合指标。该证据是本机 baseline，不替代真实 CloudBase 配额、延迟、费用和并发验收。

## 仍需 7C 关闭

- [ ] 真实来源、商业授权、缓存/展示许可、退出条款和正式 `CN-DRI-2023` 表格复核。
- [ ] 私有候选数据集校验、导入、隔离验证、备份和活动 ID 切换/回滚。
- [ ] 真实 `release:dataset`、`release:preflight` 和 `release:check` 全部通过。
- [ ] 真实 CloudBase Provider、规则/IAM/索引/定时器、容量、备份恢复和故障注入。
- [ ] 两个真实微信身份及混元/DeepSeek/视觉的超时、费用、熔断、降级和日志验收。
- [ ] 隐私材料、备案/登记、AI 内容标识、微信 IDE 和物理设备测试人员签收。
