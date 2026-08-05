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
- 数据库：PostgreSQL，Drizzle 迁移建表

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
# 密码需 URL 编码（如 ! → %21）
DATABASE_URL=postgres://postgres:<真实密码>@localhost:5432/monitor_erp
JWT_SECRET=<执行下面命令生成的值>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
PORT=3001
NODE_ENV=production
```

生成 JWT_SECRET：

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

继续：

```powershell
# 4. 应用数据库迁移（建表）
pnpm db:migrate

# 5. 全仓构建（turbo 自动按 shared → contracts → api → web 顺序）
pnpm build
```

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
      script: '../../node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      interpreter: 'node',
      env: { NODE_ENV: 'production', API_URL: 'http://127.0.0.1:3001' },
    },
  ],
};
```

> 说明：
> - API 启动文件是 `apps/api/dist/main.js`（`nest build` 产物），环境变量由 PM2 注入，`.env` 也会被 `@nestjs/config` 读取，两者都生效
> - Web 用 `next start` 以生产模式运行；`API_URL` 在运行时覆盖代理目标，若后端在同一台机器上保持默认即可

### 5.2 启动并保存

```powershell
pm2 start ecosystem.config.js
pm2 save          # 保存进程列表（pm2 resurrect 时恢复）
pm2 status        # 查看状态
pm2 logs monitor-api   # 查看 API 日志
```

### 5.3 开机自启（二选一）

**方式 A：PM2 注册为 Windows 服务**（推荐，需管理员权限）：

```powershell
npm i -g pm2-windows-service
pm2-service-install
# 之后用 pm2-service-uninstall 卸载
```

**方式 B：任务计划程序**（最简单，无需装额外包）：

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
pnpm db:migrate
```

---

## 八、安全清单（必读）

- [ ] `JWT_SECRET` 生成新值，禁止用示例/开发值
- [ ] `apps/api/.env` 加入 `.gitignore`，不要提交进仓库
- [ ] PostgreSQL 使用强密码，限制来源 IP（`pg_hba.conf`）
- [ ] 只放行必要的端口（3000；公网则只放行 443 到反向代理）
- [ ] 公网部署必须启用 HTTPS（见第六节）

---

## 九、常见问题

**Q1：`pnpm build` 报 Node 版本错误？**
检查 `node -v` 是否为 24.x；装了 26 需要卸载重装 24。

**Q2：数据库连不上 / 认证失败？**
确认 `DATABASE_URL` 中密码已 URL 编码（`!` → `%21`），且 PostgreSQL 服务已启动（`services.msc` 里 `postgresql-x64-*`）。

**Q3：3000/3001 端口被占用？**
改 `ecosystem.config.js`：API 的 `PORT`、Web 的 `next start -p <新端口>`，并同步 `API_URL`。

**Q4：重启服务器后服务没起来？**
确认已执行 `pm2 save` + 完成第五节的开机自启配置（pm2-windows-service 需管理员权限）。
