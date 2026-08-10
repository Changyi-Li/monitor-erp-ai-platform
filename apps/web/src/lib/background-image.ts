/**
 * 会话内共享的背景图 —— 对应原版 WebClient `BackgroundImageService` root 单例：
 * - 登录页挂载 → `pickBackgroundImage()`：强制随机一张（原版 `newBackgroundImage=true`）
 * - 主界面挂载 → `getBackgroundImage()`：复用当前值、不重新随机（原版指令直接读服务）
 * - 整页刷新 → 模块重载、current 复位 → 重新随机下一张（原版 SPA 重载后服务重建，行为一致）
 *
 * 图片池：public/images/login/01-10.jpg（原版 login/01-10.jpg 同源）。
 * 仅供客户端 useEffect 调用（避免 SSR/hydration 随机值不一致）。
 */
const IMAGE_POOL = Array.from({ length: 10 }, (_, i) =>
  `/images/login/${String(i + 1).padStart(2, '0')}.jpg`,
);

let current: string | null = null;

/** 强制随机一张并记为当前图（登录页每次挂载调用） */
export function pickBackgroundImage(): string {
  current = IMAGE_POOL[Math.floor(Math.random() * IMAGE_POOL.length)]!;
  return current;
}

/** 复用当前图；无当前图（直达主界面/刷新后）则随机一张（主界面挂载调用） */
export function getBackgroundImage(): string {
  return current ?? pickBackgroundImage();
}
