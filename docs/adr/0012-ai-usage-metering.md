# 0012: AI Token 用量计量（LLMClient 统一计量 + ai_usage 落库 + 统计 API + 用量页面）

Status: accepted

## 背景

#23 交付 spec §「AI 用量计量（Token 成本管理）」（#77–#79）：**所有 LLM 调用统一经 LLMClient 记录用量**（客户/项目归属、场景、模型、输入/输出 Token 数、时间）落库 `ai_usage`；内部用户按客户/项目/时间段/场景/模型查看统计汇总与趋势；预留与 RAG 每客户 Index 规格费关联的字段（客户 AI 成本视图基础）。

## 计量接缝 = LLMClient 层统一（wrapper，非业务代码逐处埋点）

- `LlmChatResult` 加**必填 `usage: {model, inputTokens, outputTokens}`**（memory fake 为确定性字符估算 ceil(字符数/4)、model='memory'；真实 openai-compatible 驱动在切片 13/14 填真实值——表结构与接缝不变）
- `LlmChatInput` 加**可选 `context: {scene, customerId?, projectId?, conversationId?}`**（场景/归属标注）
- 新 **`UsageRecordingLlmClient` wrapper** 在 `llm.module` 工厂包住任意 driver：chat() 成功后写 ai_usage——**未来任何场景（手册生成 #26、文档解析等）接入 LLMClient 即自动计量，业务代码零改动**（spec #77「统一经 LLMClient」落地）
- scene **必填**（缺省抛错）：防漏标导致无法按场景计量（红线）；userId 从 ALS tenantContext 取（请求内 = actor.sub；后台 = system）
- 事务语义：经 DRIZZLE 代理自动进请求事务（与 ai_messages/checkpoint 双写原子）；无上下文（单测/后台）RLS fail closed → 必须包 withInternalTx

## 数据模型（迁移 0013_usage.sql）

`ai_usage`：id / scene（check 含 spec 定稿 4 场景：agent、document_parsing、manual_generation、embedding）/ model / inputTokens / outputTokens / customerId、projectId（**nullable**，FK onDelete set null——历史账目保留）/ userId（发起者，cascade）/ conversationId（agent 会话追溯，set null）/ **costUsd numeric(12,4) nullable（预留 per-call 成本）** / createdAt。索引：createdAt（趋势 date_trunc）+ customerId/projectId/scene/model/conversationId。

RLS 单策略 `ai_usage_internal_bypass`（模板 ai_messages）：客户连接 0 行 fail closed；**内部全权限——用量是管理视图，不做 userId 过滤**（区别于 ai_conversations 的用户私有投影）。

## 归属的现实与预留

users 无 customerId（客户归属在 user_tenants）；**agent 客服会话无项目/客户绑定 → 本期唯一场景的 customerId/projectId 恒 null**（统计按客户/项目分组显示「未归属」组——诚实现状）。#26 手册生成按项目归属后字段自然填充，视图无需变更。costUsd 为 per-call 成本预留（fake 无真实单价恒 null）；**Phase 2 客户 AI 成本视图 = sum(costUsd) + RAG Index 规格费（21.6 元/月/客户）**，ADR 0012 与 spec Further Notes 的口径一致。

## 统计 API（新 usage 域，全仓库首个聚合统计端点）

- `GET /api/usage/summary?customerId&projectId&scene&model&from&to` → total + 按客户/项目/场景/模型四维 GROUP BY（leftJoin customers/projects 取展示名，null → 「未归属」；Drizzle count/sum 聚合）
- `GET /api/usage/trend?from&to&granularity=day|month` → date_trunc 时间序列（granularity 为契约枚举，无 SQL 注入面）
- 权限 = **复用 `agent:use`**（super_admin/internal）：不新增 usage:view 权限点——PERMISSION_MATRIX 是定稿契约（permissions.ts + rbac 测试），AI 功能域语义吻合（「使用 AI 能力」含「查看 AI 用量」）；如需独立计量权限后续再加（改矩阵一处）
- 审计：每次统计查询记 `usage.view`（spec #75 数据访问审计）

## 契约与前端

`packages/contracts/src/usage/`：query（z.iso.datetime() from/to，非法枚举/日期 → 400）+ 响应 schema（totalCostUsd/costUsd nullable 预留）。web `/usage` 页（'use client' + inline styles，骨架 rag 页）：时间段/场景/模型筛选（URLSearchParams 拼 query）→ 汇总卡片 + 四维分组表 + **纯 CSS flex 柱条趋势图**（无图表库零依赖，按 max 归一高度；真图表库接入为可选增强）。

## 已知取舍

- memory fake 的 token 为字符数估算（真实驱动填真实值）；costUsd 预留不填（无真实单价）
- 客户/项目归属本期恒「未归属」（agent 场景无绑定；#26 填充后视图自然丰富）
- 权限复用 agent:use 而非新增 usage:view（矩阵最小改动；独立计量权限可后续加）
- Index 规格费联动仅预留字段与口径说明（Phase 2 客户 AI 成本视图）
- 统计 API 不做分页（维度行数 = 客户数×场景×模型，数据量小）；web 无自动化 e2e（无 Playwright 基建），验收④ = 页面实现 + `pnpm build` + 后端 e2e 全绿（同 #15–#22 模式）
