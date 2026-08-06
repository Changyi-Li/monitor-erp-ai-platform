# 0008: 内部知识库（Markdown 编辑 + 文件上传 + 分类 + 生命周期 + 版本化）

Status: accepted

## 背景

#19 交付内部知识库（spec §4.1/§4.3 + 切片 10 AC）：**Markdown 在线编辑（分栏实时预览）+ 文件类上传（Word/Excel/PDF，拖拽）+ 分类（操作手册/FAQ/最佳实践）+ 生命周期（草稿 → 已发布 → 已归档，可恢复）+ 版本化（编辑已发布 → 派生新草稿版本，重新发布才生效）+ 版本历史**。发布动作是切片 11（#21 RAG 同步）的触发点——本期只做状态机 + 预留。

## 数据边界 = 全局（首次非项目级域，RLS 模式与租户隔离不同）

spec §4.2：客户知识库 = 内部 KB + **该客户所有项目文档**（不含其他客户）是**逻辑视图**；内部知识库本身是**全局共享**（标准操作手册/FAQ/最佳实践，不挂客户/项目）。→ 本期 kb 表**无 tenantId 列**，RLS 双策略（区别于既有 tenant_isolation + internal_bypass 模式）：

- `kb_documents_internal_manage`（for all，withCheck is_internal）：内部全权（读写）
- `kb_documents_read_published`（for select，`status = 'published'`）：**已发布全员可读**（含客户——客户知识库语义，为 #27 铺路）

版本表同构（read_published 用 `exists(子查询文档 status='published')`）。**客户读草稿/归档 → RLS 挡 → 404**（防探测语义同跨租户）；写操作内部专属。e2e 验证了**客户 A/客户 B 均可读已发布**（全局共享，无租户隔离）——这是与项目级域 e2e（crossTenant 404）不同的新语义，写入本 ADR 备忘。

## 权限：零新增（kb:edit 已定义，spec §2.4「知识库文档编辑 ✅ 仅内部」）

`kb:edit`（仅 super_admin/internal）在权限定义时已随矩阵落地。本期**不新增任何权限点**（无 kb:view——查看默认开放，客户只读已发布）。写端点 `assertPermission('kb:edit')`；读端点按角色取内容（客户仅已发布，RLS 兜底）。

## 数据模型：两表，版本 = 全字段快照（发布时分配版本号）

- `kb_documents`：文档头——title/category/docType/status（draft/published/archived，text + check）+ createdById。
- `kb_document_versions`：**版本 = 全字段快照**（title/category/body 或文件三件套）——「重新发布才生效」对标题/分类同样成立。**一个文档最多一个未发布草稿版本**（isPublished=false, versionNumber=null；unique(documentId, versionNumber) 忽略 null，service 层保证唯一）；草稿保存 = 原地更新该行（不产生新版本行）；**发布 = 该行转正**（versionNumber = max+1，blueprints 同构）并把快照写回文档头。
- **编辑已发布文档** → 无草稿则从线上版本继承派生新草稿版本（CMS 标准行为），文档头不动、线上内容不变；重新发布才覆盖线上。
- 文件类文档「上传 + 覆盖更新」（spec §4.1 不在线编辑）：覆盖走草稿版本 + storage 新 key（未覆盖前继承线上 key 共享对象）。
- **无 DELETE 端点**：生命周期只有归档（「归档即下架」），归档文档列表默认消失（内部也默认不显示，includeArchived 管理视图可见），恢复 = 重新上架。

## 文件上传 = 复用 StoragePort（JSON + base64），并修复请求体上限 bug

复用 StoragePort（ADR 0005 抽象；memory 为开发默认，切 S3 只改配置），key = `kb/{documentId}/{uuid}`。契约 base64 ≤ 8,000,000 字符 ≈ 6MB 二进制（同 drawio/minutes）。

**顺带修复既有 bug**：契约上限 8M 字符但 Fastify 默认 bodyLimit 1MB——8MB 请求体在 zod 校验前就被 413 拦截（drawio/minutes 上传同样受影响，此前从未测过超限场景）。`main.ts` 与 e2e 的 `FastifyAdapter({ bodyLimit: 10_000_000 })` 对齐契约上限 + JSON 开销。kb e2e 新增了**首个** 8MB 超限 400 断言。

## 发布 = RAG 同步触发点预留（切片 11/#21 接入）

spec §4.3：发布 → 事务消息入队 → Worker 经 DocumentIndexPort 异步导入（幂等：文档 ID + 版本号）→ 按 scope 路由（内部文档 → 内部 Index）。**本期发布动作只做状态机 + 审计（kb.publish）**；MQ 基建（MessageQueuePort + memory adapter + MqModule.forRoot 已注册）业务零 publish 状态保持——#21 接入事务入队，业务代码零改动（发布点已在 service 单一落点）。

## Markdown 渲染 = 自研轻量渲染器（escape-first，免 sanitize）

零依赖约束下无 markdown 库 → `apps/web/src/lib/markdown.ts` 自研（~150 行）：**escape-first**——先转义原文全部 HTML 特殊字符，再应用块级（标题/列表/引用/围栏代码/表格/分隔线/段落）+ 行内（code/粗体/斜体/链接/图片）转换。转义后输入不可能产生原始 `<script>` 等，`dangerouslySetInnerHTML` 渲染**无 XSS 面**——与 ADR 0007 富文本直存 HTML 的取舍不同：本通道天然安全（正文仅内部可写 + 客户只见已发布），无需 sanitize 库。分栏编辑器 = grid 双栏（左 textarea 右实时预览）。

## 审计

AUDIT_ACTIONS 新增 5 个动作：`kb.create/update/publish/archive/restore`（成功才记录、请求事务内写入，同先例；读不审计）。

## 已知取舍

- Markdown 渲染器为非完整 CommonMark 子集（标题/列表/引用/代码/表格/链接/图片）；复杂文档（如嵌入 HTML）不支持——Phase 1 内部使用足够
- 无文档删除（归档即下架）；版本不可删除；附件无分页
- 文件类文档仅「上传 + 覆盖更新」，无在线编辑（spec §4.1）；上限 6MB
- 客户查看内部 KB = 已发布列表/详情/下载（spec「客户知识库 = 内部 KB + 本项目文档」的前半；项目文档部分随 #27 客户门户）
- web 无自动化 e2e（无 Playwright 基建），验收④ = 页面实现 + `pnpm build` + 后端 e2e 全绿（同 #15–#18 模式）
