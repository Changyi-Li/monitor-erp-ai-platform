# Windows 服务器发布指南

本指南用于把本仓库（Turborepo + pnpm workspaces：Next.js 16 前端 + NestJS 11/Fastify 后端 + PostgreSQL/Drizzle）发布到一台 Windows 服务器。

> 适用：Windows Server 2019/2022，内网或公网部署均可。

---

## 一、架构概览

```
浏览器 ──> :3000 Next.js (web)  ── /api/* 同源代理 ──> :3001 NestJS (api) ──> PostgreSQL
               ↑                                                    ↑
         用户只访问这里                                      仅绑定 127.0.0.1，外部不可直连
```

- `apps/web`：Next.js 16，端口 **3000**，`next.config.ts` 中 `rewrites` 把 `/api/*` 代理到后端（默认 `http://localhost:3001`，可用环境变量 `API_URL` 覆盖）
- `apps/api`：NestJS 11（Fastify），端口 **3001**，全局前缀 `/api`，绑定 `127.0.0.1`（`apps/api/src/main.ts`）
- **后台 Worker 全部内嵌在 API 进程内**（`OnModuleInit` 启动，无需额外进程）：
  - RAG 同步 Worker（#21）：消费发布事件 + 2s 定时扫 due 兜底，乐观抢单防重复
  - Online help 定时拉取 Worker（#25）：按 `IMPORT_FETCH_INTERVAL_MS` 轮询外部导入源（未配置 URL 则不启动）
- 数据库：PostgreSQL，Drizzle 迁移建表（RLS 策略 + 受限角色授权全部包含在迁移内）
- 适配层（接口可切换实现，现为内存实现）：存储 `STORAGE_DRIVER` / 消息队列 `MQ_DRIVER` / 检索索引 `INDEX_DRIVER` / LLM `LLM_DRIVER`（memory 确定性模拟 或 openai 兼容真实模型）

---

## 二、服务器准备（一次性）

| 软件 | 版本要求 | 安装方式 |
|---|---|---|
| Node.js | **24.x**（engines: `>=24 <25`，不要装 26） | 官方 MSI 安装包 |
| pnpm | 11.20.0（与 `packageManager` 对齐） | `npm i -g pnpm@11.20.0` |
| PostgreSQL | 13+（16/18 均可） | EDB 官方安装包（设置 postgres 密码）。当前迁移只用到 `gen_random_uuid()`（PG 13 起内置）等基础能力，无高版本特性依赖 |
| Git | 任意 | 官方安装包 |
| PM2 | 最新 | `npm i -g pm2`（进程守护） |

装完验证：

```powershell
node -v   # v24.x
pnpm -v   # 11.20.0
```

---

## 三、数据库准备

```powershell
psql -U postgres
CREATE DATABASE monitor_erp;
\q
```

> 生产环境只需 `monitor_erp` 一个库（`monitor_erp_test` 仅供本地 e2e 测试使用）。

---

## 四、部署代码 + 构建

以部署到 `D:\apps\monitor-erp-ai-platform` 为例：

```powershell
# 1. 获取代码（git clone 或直接拷贝目录）
cd D:\apps
git clone <你的仓库地址> monitor-erp-ai-platform
cd monitor-erp-ai-platform

# 2. 安装依赖（锁定版本，与 lockfile 严格一致）
pnpm install --frozen-lockfile

# 3. 配置环境变量
Copy-Item apps\api\.env.example apps\api\.env
```

编辑 `apps\api\.env`：

```env
# 应用连接必须是受限角色 app_tenant_user（非表 owner、无 BYPASSRLS）——
# 表 owner 默认绕过 RLS，应用不用受限角色则数据隔离红线形同虚设。
# 密码需 URL 编码（如 ! → %21）
DATABASE_URL=postgres://app_tenant_user:<真实密码>@localhost:5432/monitor_erp
# owner 连接：仅迁移/管理用，生产部署完可删掉；密码需 URL 编码
DATABASE_OWNER_URL=postgres://postgres:<真实密码>@localhost:5432/monitor_erp
JWT_SECRET=<执行下面命令生成的值>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
PORT=3001
NODE_ENV=production
# 邀请链接前缀：填对外访问地址（如 http://服务器IP:3000 或 https://域名）——邀请成员时返回给创建者的链接
WEB_URL=http://localhost:3000
# 适配层驱动（现仅 memory 实现；不填默认 memory）
STORAGE_DRIVER=memory
MQ_DRIVER=memory
INDEX_DRIVER=memory
# LLM 门面：memory = 确定性模拟（AI 客服/图片解析/操作手册生成返回模板内容，便于演示验收）；
# openai = 真实模型（DashScope/DeepSeek/GLM 等 openai 兼容端点）。逐场景可单独指定
LLM_DRIVER=memory
LLM_DRIVER_AGENT=memory
LLM_DRIVER_DOCUMENT_PARSING=memory
LLM_DRIVER_MANUAL_GENERATION=memory
LLM_DRIVER_EMBEDDING=memory
# openai 兼容驱动凭据（任一场景配 openai 则 LLM_OPENAI_API_KEY 必填，缺失启动即报错）
# LLM_OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
# LLM_OPENAI_API_KEY=<dashscope key>
# LLM_OPENAI_MODEL=qwen-vl-max
# Online help 导入：外部项目推送文档的 API 凭证（x-api-key 头）；不配 = 推送通道禁用
# IMPORT_API_KEY=<openssl rand -hex 32>
# 定时拉取外部文档清单（GET 返回 JSON 清单）；不配 = 定时拉取 worker 不启动
# IMPORT_FETCH_URL=https://help.example.com/manifest.json
# IMPORT_FETCH_API_KEY=
# IMPORT_FETCH_INTERVAL_MS=60000
```

生成 JWT_SECRET：

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

继续（**迁移必须以 owner 凭据运行**——迁移里有 CREATE ROLE/GRANT/ALTER DEFAULT PRIVILEGES，受限角色无权执行）：

```powershell
# 4. 应用数据库迁移（建表 + RLS 策略 + 受限角色授权；迁移到 0015，含全部业务表）
$env:DATABASE_URL='postgres://postgres:<真实密码>@localhost:5432/monitor_erp'
pnpm db:migrate

# 5. 开启受限角色登录并设口令（生产口令自定，随后写入 .env 的 DATABASE_URL）
psql -U postgres -d monitor_erp -c "ALTER ROLE \"app_tenant_user\" WITH LOGIN PASSWORD '<强口令>';"

# 6. 全仓构建（turbo 自动按 shared → contracts → api → web 顺序）
pnpm build
```

> 无需种子数据：AI 场景配置全部来自环境变量（无 DB 初始化表）；AI 客服会话 checkpoint 持久化在 PostgreSQL（`langgraph_checkpoints` 表），重启不丢。

---

## 五、进程管理（PM2）

### 5.1 创建 `ecosystem.config.js`（仓库根目录）

```js
module.exports = {
  apps: [
    {
      name: 'monitor-api',
      cwd: './apps/api',
      script: 'dist/main.js',
      interpreter: 'node',
      env: { NODE_ENV: 'production', PORT: 3001 },
    },
    {
      name: 'monitor-web',
      cwd: './apps/web',
      script: 'node_modules/next/dist/bin/next', // pnpm 不提升 next 到仓库根，路径相对于 cwd(./apps/web)
      args: 'start -p 3000',
      interpreter: 'node',
      env: { NODE_ENV: 'production', API_URL: 'http://127.0.0.1:3001' },
    },
  ],
};
```

> 说明：
> - API 启动文件是 `apps/api/dist/main.js`（`nest build` 产物），环境变量由 PM2 注入，`.env` 也会被 `@nestjs/config` 读取，两者都生效
> - **RAG 同步 / Online help 拉取 Worker 内嵌在 API 进程内**，随 `monitor-api` 一起启动，不需要第三个进程
> - Web 用 `next start` 以生产模式运行；`API_URL` 在运行时覆盖代理目标，若后端在同一台机器上保持默认即可

### 5.2 启动并保存

```powershell
pm2 start ecosystem.config.js
pm2 save          # 保存进程列表（pm2 resurrect 时恢复）
pm2 status        # 查看状态
pm2 logs monitor-api   # 查看 API 日志
```

### 5.3 开机自启 / 以 Windows 服务运行（三选一）

> 方式 A（NSSM）与 5.2 的 PM2 常规运行**互斥**：用服务方式运行就不要再 `pm2 start`，否则两个进程抢同一端口。仓库自带 `docs/scripts/` 下的安装/卸载脚本。

**方式 A：NSSM 注册 Windows 服务（推荐）**

装成 services.msc 里的 `monitor-api` / `monitor-web` 两个服务：开机自启、崩溃自动拉起、`net start/stop` 直接控制，日志落在 `<部署目录>\logs\*.log`。需管理员权限，并下载 NSSM（https://nssm.cc/download，解压后把 `nssm.exe` 加入 PATH 或放到 `docs/scripts\` 目录）。

```powershell
# 安装（-WebPort 与对外端口一致；-AppRoot 默认 D:\apps\monitor-erp-ai-platform；
# 服务名默认 monitor-api / monitor-web，可用 -ApiServiceName / -WebServiceName 自定义）
powershell -ExecutionPolicy Bypass -File docs\scripts\install_service.ps1 -AppRoot D:\apps\monitor-erp-ai-platform -WebPort 3000

# 控制
net start monitor-api
net stop monitor-web

# 状态 / 日志
sc query monitor-api
Get-Content D:\apps\monitor-erp-ai-platform\logs\api.log -Tail 20

# 卸载
powershell -ExecutionPolicy Bypass -File docs\scripts\uninstall_service.ps1
```

> 脚本自动把服务工作目录设为 `apps\api`——`@nestjs/config` 从工作目录读取 `.env`（数据库/LLM 配置全靠它），这条不要手动改掉。改端口时同步改 `.env` 的 `WEB_URL` 并放行防火墙新端口（见第六节）。

**方式 B：PM2 注册为 Windows 服务**（沿用 PM2 生态，需管理员权限）：

```powershell
npm i -g pm2-windows-service
pm2-service-install
# 之后用 pm2-service-uninstall 卸载
```

> 该包 2019 年后未更新，与新版 PM2 有已知兼容问题；遇到安装失败或启动后进程未恢复，改用方式 A。

**方式 C：任务计划程序**（最简单，无需装额外包）：

1. `taskschd.msc` → 创建任务
2. 触发器：**计算机启动时**
3. 操作：`C:\Program Files\nodejs\pm2.cmd`，参数 `resurrect`
4. 条件：取消勾选"只有在计算机使用交流电源时才启动此任务"

---

## 六、防火墙与对外访问

| 场景 | 做法 |
|---|---|
| 内网使用 | 防火墙放行 **3000 端口** 即可；3001 不需要开（API 只走本机代理） |
| 公网 + 域名 + HTTPS | 前端加反向代理（IIS ARR 或 Windows 版 Nginx），443 → 3000。**必须做**：README 安全备忘写明 refresh token 只走 HTTPS 链路 |

防火墙放行命令示例（管理员 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName "Monitor Web 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

> 公网部署注意：Online help 推送通道（`IMPORT_API_KEY`）和 API 本身都只走 3001 本机代理，外部经 443/3000 访问；不要把 3001 暴露出去。

---

## 七、日常更新发版

服务器上放一个 `deploy.bat`（放在仓库根目录），每次发版双击即可：

```bat
@echo off
cd /d D:\apps\monitor-erp-ai-platform
git pull
pnpm install --frozen-lockfile
pnpm build
pm2 restart all
```

如果迁移文件有变化（`pnpm db:generate` 新增过 SQL），需在 `pm2 restart all` 前加一行：

```bat
set DATABASE_URL=postgres://postgres:<真实密码>@localhost:5432/monitor_erp
pnpm db:migrate
```

---

## 八、内存驱动的生产注意点（当前 Phase 1 取舍）

以下适配层目前只有内存实现，**进程重启会丢失**，DB 元信息仍在：

| 组件 | 重启影响 | 缓解 |
|---|---|---|
| 存储 `STORAGE_DRIVER=memory` | 蓝图 drawio 原文件、会议纪要附件、知识库文件类文档、操作手册正文文件全部丢失（DB 行/版本历史还在，下载 404） | 发布文件类内容前先确认；Phase 1 后切文件系统/S3 驱动 |
| 检索索引 `INDEX_DRIVER=memory` | AI 客服检索索引清空；已 `succeeded` 的同步任务不会自动重跑 | 重启后 AI 客服只能检索到重新发布（或新发布）的文档，存量文档需逐个重新发布，或等后续切持久化索引 |
| 消息队列 `MQ_DRIVER=memory` | 事件丢失 | RAG worker 有 2s 定时扫 due 兜底，未完成任务重启后自动续跑 |

LLM 与数据库无关：`LLM_DRIVER=memory` 时所有 AI 功能返回确定性模板内容（适合验收演示）；要真实效果配 `openai` + `LLM_OPENAI_*`（见第四节）。

---

## 九、安全清单（必读）

- [ ] `JWT_SECRET` 生成新值，禁止用示例/开发值
- [ ] `apps/api/.env` 加入 `.gitignore`，不要提交进仓库
- [ ] `DATABASE_URL` 使用受限角色 `app_tenant_user`（非 owner）；owner 凭据只出现在 `DATABASE_OWNER_URL` 且生产部署完成后删除
- [ ] PostgreSQL 使用强密码，限制来源 IP（`pg_hba.conf`）
- [ ] 只放行必要的端口（3000；公网则只放行 443 到反向代理）；3001 永不对外
- [ ] 公网部署必须启用 HTTPS（见第六节）
- [ ] 如需外部项目推送文档，`IMPORT_API_KEY` 用强随机值（`openssl rand -hex 32`），与仓库代码分开保管
- [ ] 若启用真实 LLM（`LLM_DRIVER*_*=openai`），`LLM_OPENAI_API_KEY` 妥善保管（如 DashScope/DeepSeek 控制台的密钥管理）

---

## 十、常见问题

**Q1：`pnpm build` 报 Node 版本错误？**
检查 `node -v` 是否为 24.x；装了 26 需要卸载重装 24。

**Q2：数据库连不上 / 认证失败？**
确认 `DATABASE_URL` 中密码已 URL 编码（`!` → `%21`），且 PostgreSQL 服务已启动（`services.msc` 里 `postgresql-x64-*`）。

**Q3：3000/3001 端口被占用？**
改 `ecosystem.config.js`：API 的 `PORT`、Web 的 `next start -p <新端口>`，并同步 `API_URL`。

**Q4：重启服务器后服务没起来？**
确认已执行 `pm2 save` + 完成第五节的开机自启配置（pm2-windows-service 需管理员权限）。

**Q5：API 启动报「环境变量校验失败: LLM_OPENAI_API_KEY: ...」？**
某个 `LLM_DRIVER*` 配成了 `openai` 但没给 `LLM_OPENAI_API_KEY`——要么补 key，要么把该场景改回 `memory`。这是启动期 fail-fast，属预期行为。

**Q6：AI 客服/图片解析/操作手册生成返回的是模板内容？**
`LLM_DRIVER=memory` 是确定性模拟（演示/验收用）。配 `LLM_OPENAI_BASE_URL` + `LLM_OPENAI_API_KEY` 并把对应场景驱动改为 `openai` 即为真实模型生成。
