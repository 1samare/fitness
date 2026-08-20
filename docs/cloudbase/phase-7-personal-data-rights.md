# 阶段 7A：个人数据权利实现、测试与恢复说明

## 当前结论

截至 2026-08-20，schema v8 个人数据摘要、严格导出、账户删除、助手事务摘要、删除中全局阻断，以及小程序隐私/个人数据页面已经完成本地代码和自动化门禁。本文用于开发者、运维和测试人员验证 7A 行为。

这不是阶段七发布完成证明。本文没有证明真实 CloudBase 环境、两个真实微信身份、真实对象存储、供应商、备份恢复、微信开发者工具或物理设备已经验收；这些事项继续由 7B/7C 关闭。

## 用户入口与内容标识

所有现有主页面都提供以下固定入口：

- `/pages/privacy/index`：展示发布通道、运营主体、隐私联系方式、隐私说明版本、处理目的、最小化收集、照片保留和非医疗限制。
- `/pages/data-rights/index`：读取摘要，复制/分享导出，进入版本化更正，以及执行双重确认删除。

页面使用三类来源说明：

```text
用户提供：身体档案、目标、训练安排、库存、确认后的照片候选与执行反馈。
AI 辅助：受限助手表述与食材候选；候选必须由用户确认。
确定性估算：热量、训练消耗、营养目标和克数；不是医疗建议。
```

助手和食材识别旁显示“AI 辅助”；能量/营养/餐单数值旁显示“确定性估算，仅供参考”。用户自己输入的文字不标为 AI 生成。

开发构建必须显示以下不可发布值：

```text
运营主体：仅限本地开发，不得发布
隐私联系：local-only@invalid.example
隐私说明版本：local-dev
```

受控测试构建使用：

```powershell
$env:FITNESS_PUBLIC_OPERATOR_NAME = '<受控测试运营主体>'
$env:FITNESS_PUBLIC_PRIVACY_CONTACT = '<受控隐私联系方式>'
$env:FITNESS_PRIVACY_NOTICE_VERSION = '<版本号>'
node scripts/build-miniprogram.mjs --api-mode=cloud --release-channel=controlled_beta
```

任一值为空时构建失败。7B 还会增加发布级格式、占位值和产物扫描门禁；7A 的非空检查不能替代该门禁。

## authenticated API 行为

### `getPersonalDataSummary`

请求：

```json
{ "action": "getPersonalDataSummary" }
```

响应只公开：

- 是否存在数据及当前 SHA-256 快照令牌；
- 删除状态 `none|pending`；
- 容量状态 `within_limit|admin_recovery_required`；
- 档案、目标、训练、库存、餐单的活动版本号；
- 各类版本、照片记录和助手消息计数。

账户不存在时 `dataExists=false` 且 `snapshotToken=null`。摘要不创建空账户文档。

### `exportPersonalData`

请求：

```json
{
  "action": "exportPersonalData",
  "snapshotToken": "<摘要返回的 64 位小写十六进制令牌>"
}
```

服务端再次读取同一用户的当前聚合并比较令牌。数据变化、账户不存在或跨用户使用令牌时返回 `personal_data_snapshot_conflict`；删除已开始时返回 `account_deletion_pending`。

`personal-data-export-v1` 使用显式白名单投影，包含：

- 用户提供的档案、目标、训练、库存、训练完成和餐单决策；
- 确定性能量/营养目标、餐单和差异；
- AI 辅助照片候选/确认和助手消息；
- `contentOrigin`、策略版本及审核数据版本引用。

导出不得包含：

```text
userId / openid / _id
expectedCloudPath / expectedPrivateFileId / privateFileId
providerRequestId
requestFingerprint / idempotencyRecords / accountDeletion
nextPhotoCleanupAt
```

自动化 E2E 从公开档案、训练会话、审核 MET、每 100 克营养快照和导出克数独立复算七天能量、宏量营养目标及每个餐单日的营养汇总。

### `deleteAccount`

请求：

```json
{
  "action": "deleteAccount",
  "payload": {
    "snapshotToken": "<当前令牌>",
    "idempotencyKey": "delete-account-<唯一值>",
    "confirmation": "DELETE_MY_ACCOUNT"
  }
}
```

小程序还要求用户在两个独立输入框精确输入 `删除我的账户` 和 `DELETE_MY_ACCOUNT`，随后通过系统 `wx.showModal` 再确认不可撤销操作。

删除采用三阶段状态机：

1. 在聚合事务中验证令牌/幂等键，冻结待删除私有文件 ID，并写入 `accountDeletion.status=pending`。
2. 在事务外逐个删除私有对象；`deleted` 和 `not_found` 都可收敛，存储失败返回 `storage_unavailable`。
3. 在删除文档的原子操作内再次验证同一 pending 请求，然后删除整个账户聚合。

pending 标记写入后，所有普通规划和助手 repository 读写均返回 `account_deletion_pending`；模型不会被调用。原始 repository 只交给个人数据服务，以便同一删除请求继续运行。

## 重试与响应丢失语义

- 私有对象删除失败：保留 pending 标记。用户必须保持相同 `snapshotToken`、`idempotencyKey` 和确认词重试；新幂等键返回 `account_deletion_pending`。
- 同一删除幂等键但请求内容改变：返回稳定幂等冲突，不继续删除。
- 文件已删除但文档删除响应丢失：同一请求重试时，账户不存在即返回 `account_already_absent`；客户端把 `account_deleted` 和 `account_already_absent` 都视为终态。
- 删除终态后，小程序先调用唯一清理入口 `clearAllLocalPrivateState()`（内部仅调用 `wx.clearStorageSync()`），再 `wx.reLaunch` 到建档页。
- 删除后重新创建同一可信身份会得到全新聚合。旧快照/旧删除命令对新聚合返回 `personal_data_snapshot_conflict`，不会删除新账户。

## 小程序导出文件生命周期

- 快照令牌和导出 JSON 仅保存在当前页面内存。
- “复制严格 JSON”调用 `wx.setClipboardData`。
- “生成临时 JSON 并分享”只由直接用户点击触发，写入 `${wx.env.USER_DATA_PATH}/fitness-personal-data-export.json`，调用 `wx.shareFileMessage`，并在 completion 回调中 unlink。
- 不支持文件分享时回退到剪贴板，并明确提示已复制。
- 不写入小程序键值存储，不上传到 CloudBase，不记录到日志。

## 容量上限与人工恢复

正常规划写入以 `JSON.stringify(state)` 的 UTF-8 字节数执行 `3,000,000` 字节硬上限：恰好上限可写，超过 1 字节即在持久化 set 前返回 `account_capacity_exceeded`。历史超限账户仍允许只添加 pending 删除标记，以免容量门禁阻断删除权。

摘要显示 `admin_recovery_required` 时：

1. 客户端停止自助导出/删除并显示固定隐私支持文案；不得截断、覆盖或拆分历史。
2. 运维必须先以可信身份核对目标账户，保全当前文档和私有对象清单，并记录原始 UTF-8 字节数。
3. 只能使用 7B/7C 验收后的受控管理员导出/删除流程；当前仓库没有授权通用客户端绕过容量上限。
4. 人工操作必须保持过敏原、历史版本、身份隔离和私有对象删除语义，并留下双人复核与恢复记录。
5. 如果尚未具备受控管理员工具，状态保持外部阻塞，不得宣称该账户已完成数据权利演练。

## 测试人员本地验证步骤

1. 运行 `pnpm.cmd build:miniprogram:local`，确认构建显示明确的本地不可发布运营信息。
2. 启动本地 planning/assistant API 后，从建档页创建档案、目标和一周训练，再保存库存、生成餐单、完成一次助手请求和一次照片候选确认。
3. 从任一主页面进入“隐私说明”，核对运营信息、三类内容来源、24 小时照片说明和非医疗限制。
4. 进入“个人数据管理”，确认摘要计数与已创建记录一致。
5. 点击复制导出，粘贴后验证为严格 JSON；点击文件分享后确认文件名为 `fitness-personal-data-export.json`。不得在小程序存储中看到导出内容或快照令牌。
6. 点击“前往版本化更正”，修改档案/目标/训练，确认产生新版本且旧事实未被改写；旧导出令牌随后应冲突。
7. 删除按钮必须在两个确认词完全匹配前保持禁用。确认系统弹窗后执行删除；遇到存储错误时不要生成新请求，应原样重试。
8. 收到任一删除终态后应回到建档页，所有本地待提交/恢复状态清空，重新建档不受旧幂等回执影响。

## 7A 本地门禁证据

2026-08-20 fresh 执行结果：

- `pnpm.cmd lint`：退出 0。
- `pnpm.cmd typecheck`：13/14 个带脚本工作区项目及小程序严格检查通过。
- `pnpm.cmd test`：92/92 个测试文件、897/897 项测试通过。
- `pnpm.cmd build`：工作区、三云函数、隔离部署制品和云模式小程序构建通过；planning/assistant/cleanup 本地 bundle 约 3.27/5.15/3.01 MB。
- `pnpm.cmd dry-run:api`、`pnpm.cmd dry-run:assistant`：函数入口加载通过。
- `pnpm.cmd smoke:api`：真实本地函数进程 2/2 通过。
- `pnpm.cmd smoke:assistant`：真实本地助手进程 1/1 通过。
- `git diff --check`：通过。

个人数据 E2E 使用同一真实 application/handler 组合和两个可信身份，覆盖丰富历史导出复算、跨用户令牌拒绝、一次存储失败、pending 全局阻断、同请求重试、A 删除、B 聚合 JSON 字节不变、A 重建和旧命令冲突。

## 尚未验证（不得据 7A 声称发布完成）

- schema v8 在目标 CloudBase 的真实迁移、规则、IAM、复合索引和两个真实微信身份隔离；
- 真实对象存储删除、`NOT_FOUND`、响应丢失、部分失败和账户重建；
- 超限真实文档、管理员恢复、备份/恢复与回滚演练；
- 真实混元/DeepSeek、视觉、生产营养数据的权限、合同、费用、熔断和降级；
- 运营主体、隐私联系方式、隐私说明版本、微信隐私材料、备案/登记和 AI 内容标识审批；
- 微信开发者工具渲染、文件分享兼容性和物理设备双账号验收。
