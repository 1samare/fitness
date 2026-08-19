# 阶段五食材图片 CloudBase 部署与验收

阶段五实现私有图片上传会话、受控视觉候选、用户明确确认入库存和可重试原图清理。仓库只保存环境变量名、规则源和无秘密部署配置；不得提交真实环境 ID、AppID、OpenID、存储 fileID、图片、供应商密钥或供应商原始响应。

本文区分“本地自动化证据”和“真实 CloudBase/微信设备证据”。本地 lint、类型检查、测试、构建、dry-run 和 smoke 通过，不代表真实混元、已发布规则、定时器、双账号或真机上传已经验证。

## 本地构建与自动化门禁

在仓库根目录按顺序执行：

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd dry-run:photo-cleanup
pnpm.cmd smoke:api
git diff --check
```

`pnpm.cmd build` 必须只在忽略的 `.build/cloudfunctions` 下生成两个部署目录：

```text
planning-api/
  index.js
  package.json
photo-cleanup/
  index.js
  package.json
```

不得部署 `dist` 本地入口、源码映射、测试、fixture、`node_modules` 或工作区源码。`planning-api` 的部署入口是 cloud-only 入口：生产制品不得包含 `FITNESS_RUNTIME_MODE`、`FITNESS_LOCAL_USER_ID`、视觉 fixture 或餐单/营养 fixture 标识；本地 `dist/index.js` 只用于开发和 smoke。

## 部署前硬门禁

### 1. 数据库复合索引

在启用 `photo-cleanup` 定时器前，必须创建并确认以下 CloudBase 复合索引已生效：

```text
state.nextPhotoCleanupAt ASC, state.userId ASC
```

清理扫描先按该顺序读取，再在应用层验证每个聚合和每个最新图片 revision。缺少索引时不得启用定时器，也不能把本地 fake 查询当作云端索引证据。

### 2. early-v6 可信身份检查

当前 schema v6 在服务端持久化可信 `state.userId`，到期扫描只接受该字段与聚合一致的文档。任何曾运行阶段五早期 schema-v6 构建的环境，都必须在启用定时器前完成以下硬检查：

1. 统计所有 `state.nextPhotoCleanupAt` 已到期或非空的 v6 文档。
2. 证明其中缺少可信 `state.userId` 的文档数为 `0`；否则停止启用定时器。
3. 如需修复，只能通过已认证的服务端来源执行受控备份、可信身份回填和逐文档复核。
4. 永远不得从 SHA-256 文档 ID 反推、猜测或映射 OpenID/userId。

扫描对缺失身份文档会失败关闭，而且每次最多扫描 250 个有序文档；因此上述检查/回填是部署门禁，不是可延后的优化。

### 3. 私有存储与函数权限

发布并人工复核：

- `cloudbase/storage.rules.json`：使用官方 flat top-level `read`/`write` 表达式；只有已认证、路径以 `ingredient-photos/` 开头且 `resource.openid == auth.openid` 的对象才允许读写。表达式对其他路径求值为 false；不得包裹 `rules`，也不得使用非官方 `resource.creator` 字段。真实双账号必须验证 A 不能读写 B 的对象。
- `cloudbase/function.rules.json`：已认证用户只能调用 `planning-api`；普通客户端不能调用 `photo-cleanup`。
- 视觉嵌套函数：只向 `planning-api` 的服务端运行身份授予调用权限，不向小程序客户端开放；函数名必须来自服务端配置白名单。
- 数据库业务集合继续拒绝客户端直读写；用户身份只来自可信云函数上下文。

CloudBase 服务端管理员访问不受客户端存储规则替代保护。视觉与清理适配器仍必须只处理聚合内持久化的预期私有 fileID。

## 环境配置

只在 CloudBase 服务端环境配置以下名称，不把真实值写入仓库或部署日志：

- `CLOUDBASE_STORAGE_FILE_ID_PREFIX`：格式为 `cloud://<环境或存储标识>/`，必须包含且只需一个结尾 `/`；它与服务端随机相对路径组合为预期完整 fileID。
- `FITNESS_VISION_FUNCTION_NAME`：已审核、已授权且在部署白名单中的嵌套视觉函数名。

缺少或非法存储前缀时图片命令失败关闭；缺少或非法视觉函数名时使用明确的 Provider 不可用降级，页面保留手动录入。不要使用本地身份或 fixture 环境开关部署生产入口。

## 超时、重试与定时器

- `planning-api` 云函数超时：25 秒。
- 小程序 planning API 客户端超时：20 秒。
- `vision-provider-policy-v1`：单次 8 秒，只对超时/传输错误重试一次；schema、鉴权和明确不可重试错误不重试。
- 连续三个完整识别操作失败后开启温实例内熔断，60 秒后只允许一个半开探测。
- `photo-cleanup`：函数超时 25 秒，普通客户端调用被拒绝。默认 `cloudbaserc.json` 不含触发器；只有部署前硬门禁完成后，才使用独立 `cloudbaserc.photo-cleanup-timer.json` 激活每 15 分钟触发一次的定时器。
- 上传会话创建时把删除目标设为 `+23h`；确认后把私有 `nextCleanupAt` 提前到确认时间。删除失败 15 分钟后重试，存储 `NOT_FOUND` 视为幂等成功。

COS 按天生命周期只能作为灾难兜底，不能替代应用层“24 小时内至少发起删除”的证据。

## 真实 Vision Provider 合同

嵌套视觉函数输出必须通过严格合同，最多五个候选，每个候选只允许：

- 供应商候选 ID；
- 名称；
- `0–1` 置信度；
- 可选食物状态 `raw`、`cooked`、`dry` 或 `unknown`。

输出不得包含克数、热量、营养素、内部标准食材 ID、用户身份、URL、工具名或额外字段。应用服务仍须把名称映射到审核营养快照；无法映射时不写库存，并提供手动录入。真实混元响应、服务备案/登记和 AI 内容标识必须另行验收，本地 fixture 不能替代。

## 部署顺序

1. 记录当前两个函数的版本、运行时、超时、入口、触发器和制品校验值，并在受控位置保存“部署前制品”；不要复制到仓库。
2. 备份业务集合并完成 early-v6 可信身份硬检查。
3. 创建并等待复合索引生效。
4. 发布数据库、函数和 creator-private 存储规则；使用默认 `cloudbaserc.json` 部署函数代码，此时不创建清理定时器。
5. 配置两个服务端环境变量名对应的受控值，并授予 `planning-api` 调用嵌套视觉函数的最小权限。
6. 从 `.build/cloudfunctions` 部署 `planning-api` 和 `photo-cleanup`，确认 `cloudbaserc.json` 声明的 Node.js 20、`index.main`、25 秒和 `installDependency: false` 已生效。
7. 完成规则、嵌套函数、双账号和一张测试图片的受控验收后，再用独立 activation config 启用每 15 分钟定时器。
8. 观察一次到期清理与一次 `NOT_FOUND` 幂等收敛；日志只保留计数、延迟和稳定错误码。

只使用组织预先安装、固定版本并完成安全审核的 CloudBase CLI；禁止通过 `npx -y` 或其他即时网络执行方式下载 CLI。管理员必须先核对登录身份和目标环境，并把 `tcb -v` 输出记录到受控发布证据；命令不内嵌真实环境 ID。运行时、入口、超时和 `installDependency` 全部以仓库 `cloudbaserc.json` 为准，不通过临时 CLI 参数覆盖：

```powershell
pnpm.cmd build
tcb -v
tcb fn deploy planning-api
tcb fn deploy photo-cleanup
tcb fn detail planning-api
tcb fn detail photo-cleanup
```

上述默认部署必须保持 trigger-free。硬门禁和人工验收全部通过后，管理员才可执行以下两阶段激活流程；临时文件只用于本次受控 CLI 调用，不得提交，且 `finally` 必须恢复 canonical `cloudbaserc.json`：

```powershell
$phase5ConfigBackup = New-TemporaryFile
Copy-Item -LiteralPath cloudbaserc.json -Destination $phase5ConfigBackup -Force
try {
  Copy-Item -LiteralPath cloudbaserc.photo-cleanup-timer.json -Destination cloudbaserc.json -Force
  tcb fn deploy photo-cleanup
  tcb fn detail photo-cleanup
} finally {
  Copy-Item -LiteralPath $phase5ConfigBackup -Destination cloudbaserc.json -Force
  Remove-Item -LiteralPath $phase5ConfigBackup -Force
}
git diff --exit-code -- cloudbaserc.json
```

激活前后分别人工比对两个配置，确认唯一功能差异是 `photo-cleanup-every-15-minutes` 的 `0 */15 * * * * *` trigger。若目标环境已依赖一个清理定时器，不得直接用 trigger-free 默认配置覆盖该函数；必须先证明仍有已知良好的 cleanup worker 或等价受审清理路径持续运行。

发布规则、环境配置、IAM 和触发器的控制台/CLI 操作必须由管理员在目标环境复核；函数代码部署成功不等于这些外部项已经生效。

## 部署后 smoke 与人工验收

先在本地重复自动化 smoke：

```powershell
pnpm.cmd dry-run:api
pnpm.cmd dry-run:photo-cleanup
pnpm.cmd smoke:api
```

真实环境至少记录以下匿名证据：

1. 账号 A 创建上传会话，路径随机且不含 OpenID/手机号/用户名；只能上传 JPEG/PNG 且服务端拒绝超过 10 MiB 或签名不符对象。
2. 账号 B 无法读取、覆盖、登记或确认账号 A 的对象/候选；错误不暴露对象是否存在。
3. 真实视觉函数只返回合同允许字段；非法 schema、超时、一次重试、熔断和手动录入降级可观察。
4. 确认前库存、营养目标、餐单和重算任务不变；明确候选和正整数克数确认后只原子追加图片/库存版本。
5. 确认后的即时清理、未确认/未登记孤儿的 `+23h` 清理、删除失败重试和 `NOT_FOUND` 收敛均有定时器证据。
6. 微信开发者工具页面渲染、页面重启恢复、相机/相册选择及物理设备上传完成。

验收记录不得包含真实 OpenID、fileID、路径、图片、候选原文、供应商正文、临时 URL 或自由文本错误。

## 回滚

1. 先停用新的图片入口，避免回滚期间继续创建对象；只要仍存在 retained、pending 或 failed 对象，就不得留下没有清理执行者的窗口。
2. 整个回滚期间持续保留一个已知良好的 `photo-cleanup` worker，或先切换到等价、受审且按每个持久化 `nextCleanupAt`/`deleteDueAt` 执行的替代清理路径；验证替代路径生效前不得停旧定时器。
3. 数据库备份不得改写或遗漏 schema-v6 图片历史和库存版本。任何原图备份或副本必须继承或缩短该对象原有删除 deadline，绝不得超过原 `nextCleanupAt`/`deleteDueAt` 后继续保留。
4. 在清理路径持续运行的前提下，重新部署受控保存的上一组已知良好函数制品，并恢复其配套运行时、超时、规则、IAM 和必要触发器配置。
5. 如果上一组 `planning-api` 制品早于 schema v6，必须先证明它能读取当前 v6 文档；不能证明时不得降回旧制品，应回滚到上一组已验证的 phase-5 制品或用修复版向前恢复。
6. 不得通过改写历史库存/图片版本、移除可信 `state.userId`、反推哈希文档 ID、延长原图删除期限或放宽存储规则完成回滚。
7. 回滚后重新执行两个 dry-run、本地 smoke、云端双账号隔离和到期对象审计，确认每个对象仍有按原 deadline 执行的应用清理路径。

## 本地不能声明已验证的事项

截至阶段五本地退出，本次没有部署或访问真实云、Provider、IDE 或设备，因此以下项目仍未验证：

- 真实混元视觉响应、访问授权、备案/登记和内容标识；
- 目标 CloudBase 的数据库/存储/函数规则及双账号强制执行；
- `planning-api` 调用嵌套视觉函数的真实 IAM 权限；
- 15 分钟定时器投递、复合索引生效和 early-v6 可信身份检查/回填；
- 微信开发者工具页面渲染、物理设备相机/相册和真实云存储上传；
- 生产营养数据来源、授权与缓存许可。

这些项目是后续受控部署/阶段七门禁。关闭前不得称为 production ready 或已完成真实云端验收。
