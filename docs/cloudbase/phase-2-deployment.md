# 阶段二 CloudBase 部署与验收

阶段二已实现可信微信身份、CloudBase 文档数据库适配器，以及身体档案、目标、训练计划和每日能量目标的不可变版本链。仓库不保存 CloudBase 环境 ID、微信 AppID 密钥或用户身份。

## 部署前提

- 可用的微信小程序 AppID 和 CloudBase 开发环境。
- 能部署 `cloudfunctions/planning-api/dist` 的受控开发者账号。
- 至少两个微信测试身份，用于跨用户隔离验收。

## 部署步骤

1. 执行 `pnpm.cmd install --frozen-lockfile`、`pnpm.cmd build` 和 `pnpm.cmd smoke:api`。
2. 在微信开发者工具中把真实 AppID 配置到个人配置，不提交到仓库。
3. 按 `cloudbaserc.json` 部署 `planning-api`，运行时使用 Node.js `20.19`。
4. 将 `cloudbase/database.rules.json` 应用于数据库，使客户端不能直接读写业务集合；所有业务访问只经过云函数。
5. 将 `cloudbase/function.rules.json` 应用于云函数权限，只允许已认证用户调用 `planning-api`。
6. 使用默认的云端小程序构建；本地联调使用 `pnpm.cmd open:miniprogram`，该命令会显式生成本地 API 构建。

## 数据布局与索引

阶段二只使用 `planning_user_states` 集合。每个用户只有一个聚合文档，文档 ID 是服务端可信 OpenID 的 SHA-256，不接受客户端 `userId`。所有读取和写入都按文档主键完成，不执行集合扫描或字段查询，因此本阶段不需要二级索引；CloudBase 的文档主键索引即为唯一访问路径。

## 云端人工验收

- 用户 A 保存档案后，用户 B 的当前上下文仍为空。
- 客户端请求携带 `userId` 或额外字段时被运行时 schema 拒绝。
- 同一幂等键和相同负载重复提交只返回原版本；不同负载复用同一键被拒绝。
- 过期 `expectedVersion` 返回 `version_conflict`，不覆盖较新数据。
- 每个每日能量目标都引用对应的身体档案版本、目标版本、训练计划版本和 `calculation-policy-v2`。
- 更新身体档案后，未基于该档案重新保存目标时，训练计划写入被拒绝，不产生交叉版本链。

上述项目必须在真实 CloudBase 开发环境记录环境、函数版本、测试身份、日期和结果。没有这些证据时，只能声明阶段二代码与本地自动化验收完成，不能声明云端部署完成。
