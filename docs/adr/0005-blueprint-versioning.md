# 0005: 蓝图（版本化快照 + 对象存储抽象）

Status: accepted

## 背景

#16 交付蓝图版本化管理（spec §3.2）：一个项目一份蓝图 + 版本控制；版本内容 = draw.io 流程图 + 结构化文档（业务需求/模块功能范围/配置说明/流程描述）；draw.io 存对象存储（S3 兼容），结构化内容存数据库，**版本为两者的一致性快照**；内部（实施）维护，客户用户只读。数据边界 = 项目（#13 已定）。

## 权限落点：复用 blueprint:view，新增 blueprint:manage

spec §2.4 已定义「查看蓝图」= 全员（矩阵已有 `blueprint:view`）、「蓝图维护」= 仅内部/超管（line 81）。本期唯一新增权限点：**`blueprint:manage`（super_admin/internal）**——创建/编辑/发布全部只挂内部两角色（验收 ④「客户用户只读，编辑/上传 403」），`permissions.spec.ts` 同步断言。

项目级权限沿用 #14/#15 模式**不建 guard**：每个端点 service 层 `resolveViewerRole`（内部 → 'internal'；客户用户须为 active 成员，非成员 403）后 `can(viewerRole, permission)` 断言。403 vs 404 语义同前：跨租户（RLS 兜底）→ 404 防探测；同租户无权限 → 403。

## 数据模型：当前内容（工作区）+ 版本快照两表

- `blueprints`：**一个项目一份**（projectId unique）——存**可编辑的当前内容**（4 个结构化字段 + drawio 文件元信息）。创建即必有文件（drawioKey notNull）。
- `blueprint_versions`：发布时把当前内容**整体冻结**成不可变快照（4 字段 + 文件 key + version 序号 + publishedBy/publishedAt），`unique(blueprintId, version)` 兜底并发。

流程：**上传 + 填写 → 自动发布 v1**（验收①）；**编辑（PATCH 当前内容）→ 显式发布 → vN+1**（验收②）。编辑不产生版本（latestVersion 不变），发布才快照——「发布」是唯一版本增长动作，语义与「一致性快照」对齐。版本号事务内 `max(version)+1`。

RLS：两表均 `enableRLS()` + 双策略（`*_tenant_isolation` + `*_internal_bypass`），与 projects/issues 完全同构（迁移 0005，零改动现有表；GRANT 由 0001 的 ALTER DEFAULT PRIVILEGES 自动覆盖）。

## 对象存储：StoragePort 抽象 + memory 默认，S3 适配留待部署

仓库已有 `StoragePort` 端口（put/get/delete）与 `STORAGE_DRIVER` 配置开关（memory 为测试/开发默认）。本期**不实现 S3 适配器**：

- 验收未要求真实对象存储（上传/下载/版本快照全部可用内存实现验证）
- 接口已抽象，部署时补一个 S3 实现（@aws-sdk/client-s3）+ 改 `STORAGE_DRIVER=s3`，业务代码零改动（storage.module 工厂切换）
- 文件 key 约定：`blueprints/{id}/current.drawio`（当前工作文件，PATCH 覆盖）+ `blueprints/{id}/v{version}.drawio`（版本文件，**发布时复制冻结**，历史版本文件互不影响）

## 上传方式：JSON + base64，不用 multipart

draw.io 文件本质是 XML 文本，但统一按 base64 传输保证任意字节一致：

- **零新依赖**：不引入 @fastify/multipart（Fastify 文件上传要插件 + NestJS Fastify 适配层的 FileInterceptor 链路，复杂度不成比例）
- 复用现有 JSON 管道（ZodValidationPipe + apiFetch），web 侧 `<input type="file">` → FileReader.readAsDataURL
- 限制：base64 ≤ 8_000_000 字符（解码后 ≈6MB，service 层 `Buffer.from` 后按字节再校验，不信任客户端 size）；draw.io 文件量级远小于此

## 下载端点：二进制响应绕开 ZodResponse

`GET /versions/:version/file` 返回 Buffer：不标 `@ZodResponse`（拦截器无 schema 直接放行），controller 用 `@Res({ passthrough: true })` 设 `Content-Type` + `Content-Disposition`（RFC 5987 `filename*=UTF-8''` 编码中文文件名）。web 侧手动 fetch 带 Authorization（`window.open` 丢 header → 401），blob + `a.click()` 下载。

## 审计

AUDIT_ACTIONS 新增 `blueprint.create`（创建即 v1）/ `blueprint.update`（metadata 带 changedFields）/ `blueprint.publish`（metadata 带 **fromVersion → toVersion**），成功才记录、请求事务内写入（与 #13/#14/#15 同模式）。读操作不审计（同 issues 取舍）。

## 已知取舍

- 版本「对比」= 前端并排展示两个版本的结构化字段（版本列表已含全字段，无需 diff 端点）；draw.io 文件不做 diff（XML 图对比性价比低，各版本可下载自行比对）
- 无真实 S3 适配器（见上）；无文件删除操作（PATCH 只增不删，覆盖 current key）
- 版本无分页/无删除（快照不可变；Phase 1 量级小）
- web 无自动化 e2e（无 Playwright 基建），验收④ = 页面实现 + `pnpm build` + 后端 e2e 全绿 + demo path 手动走通（同 #15 模式）
- 结构化字段长度上限 20000 字符（足够业务描述，防单行爆量）
