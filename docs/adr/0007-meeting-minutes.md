# 0007: 会议纪要（结构化字段 + 富文本 + 附件）

Status: accepted

## 背景

#18 交付会议纪要域（spec §3.4 + 用户故事 31–35）：**结构化字段（主题/日期/参会人）+ 富文本正文 + 附件**（上传至对象存储、预览/下载）；内部用户创建/编辑/删除；客户用户只读查看与附件下载。数据边界 = 项目（#13 已定）。

## 权限：meeting:view 已存在，新增 meeting:manage（仅内部）

spec §2.4 矩阵「查看蓝图 / 实施阶段 / 会议纪要」= 全员、「…会议纪要维护」= 仅内部/超管。`meeting:view` 在权限定义时已随矩阵落地（`packages/shared/src/permissions.ts`，注释「定义先行，后续模块复用 can()」），本期**只新增 `meeting:manage`**（`['super_admin', 'internal']`）。

项目级权限沿用 #14–#17 模式**不建 guard**：service 层 `resolveViewerRole`（内部 → 'internal'；客户用户须为 active 成员，非成员 403）+ `can()` 断言。403 vs 404 语义同前：跨租户（RLS 兜底）→ 404 防探测；同租户无权限 → 403。**本期统一了顺序：所有端点先 `requireProject`（RLS 过滤）再 `resolveViewerRole`**——否则详情/更新端点跨租户会 403（成员表无 RLS 先查到），与列表端点的 404 语义不一致。

## 数据模型：两表，RLS 双策略（同 projects/issues 同构）

- `meeting_minutes`：**一个项目多份纪要**。字段：title、meetingDate（date 列，'YYYY-MM-DD'）、participants（纯文本名单）、body（富文本 HTML）、createdById（FK → users set null，创建人）。
- `minute_attachments`：**纪要 1:N 附件**。字段：name、contentType、size（service 层按解码字节实测，不信任客户端）、storageKey（对象存储 key）；minuteId FK → meeting_minutes **onDelete cascade**（删纪要级联删附件行；storage 对象由 service 先显式删除）。

两表均 `enableRLS()` + 双策略（`*_tenant_isolation` + `*_internal_bypass`），迁移 0007 零改动现有表；GRANT 由 0001 的 ALTER DEFAULT PRIVILEGES 自动覆盖。

## 附件 = 复用 StoragePort（JSON + base64），零新依赖

蓝图（ADR 0005）已确立通用存储抽象：`StoragePort`（put/get/delete）+ `STORAGE_DRIVER` 工厂（memory 为测试/开发默认，部署时补 S3 适配器 + 改 env，业务代码零改动）。本期附件**直接复用**：

- 上传：JSON + base64（≤8,000,000 字符 ≈ 6MB 二进制，service 层 `Buffer.from` 后按字节再校验），不引入 multipart——ADR 0005 已否决 `@fastify/multipart`（NestJS Fastify 适配层 FileInterceptor 链路复杂度不成比例）
- 下载：`GET .../file` 返回 Buffer（不标 @ZodResponse），`Content-Disposition: inline; filename*=UTF-8''...`（RFC 5987 中文文件名）——inline 使浏览器可内联预览；web 侧按 contentType 分支（图片 → blob URL `<img>` 预览；其余 → fetch blob + `a.click()` 下载，Authorization 头不能丢，`window.open` 会 401）
- storage key：`minutes/{minuteId}/{attachmentId}`（按纪要隔离）

## 富文本 = 原生 contentEditable + execCommand，不引入编辑器库

验收④「富文本编辑器所见即所得」。仓库约束无 UI 依赖 → 原生 `contentEditable` + 工具栏（加粗/斜体/下划线/无序/有序列表，`document.execCommand`——deprecated 但全浏览器支持）。正文存 **HTML**（`<p>`/`<strong>` 等 execCommand 产出），详情页 `dangerouslySetInnerHTML` 渲染。

**无 sanitize 库（已知取舍）**：正文仅内部用户（平台员工，受信任）可写，且 RLS 隔离跨租户（客户看不到他人数据）；若未来开放客户输入 HTML 再引入 sanitize（如 DOMPurify）。

## 参会人 = 纯文本，不做用户关联

spec「参会人等」未要求结构化。会议可有外部参会人（客户方非平台用户），关联 users 反而受限——Phase 1 用纯文本名单（max 2000）。后续若要统计/筛选再升级为关联表。

## 审计

AUDIT_ACTIONS 新增 5 个动作：`minute.create/update/delete`、`attachment.upload/delete`。成功才记录、请求事务内写入（与 #13–#17 同模式）。读操作不审计。

## 已知取舍

- 附件无分页、无多选批量上传（Phase 1 量级）；附件上限 6MB（同 drawio 先例）
- 无真实 S3 适配器（ADR 0005 既定决策：部署时补 `@aws-sdk/client-s3` + `STORAGE_DRIVER=s3`，业务零改动）
- 富文本无 sanitize（见上）；execCommand 为 deprecated API（全浏览器仍支持，无替代的零依赖方案）
- web 无自动化 e2e（无 Playwright 基建），验收④ = 页面实现 + `pnpm build` + 后端 e2e 全绿 + demo path 手动走通（同 #15/#16/#17 模式）
