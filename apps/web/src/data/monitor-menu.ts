/**
 * Monitor 主框架菜单数据（issue #32）——模块导轨 → 侧边菜单 的单一数据源。
 *
 * 结构与图标风格照抄 Monitor WebClient 登录后页面；程序项为**本平台自己的功能**
 * （用户决策：不填 Monitor 真实程序清单、不指向 localhost:5000），分门别类放入
 * Monitor 模块结构下。归类依据（用户示例 + 实现者归类，issue #32 评论有说明）：
 * - 项目 → 会计（用户指定）；客户 → 销售（用户指定）
 * - 知识库 / 用户管理 → 通用登记（基础资料类）
 * - AI 客服 / 用量统计 / AI 配置 / RAG 调试台 / 导入调试台 → 定制包（扩展应用）
 * - 生产 / 采购 / 库存 / 时间记录 无对应功能，保持空（原版结构照抄，内容为空）
 */

export interface MonitorMenuItem {
  caption: string;
  href: string;
}

export interface MonitorMenuCategory {
  label: string;
  items: MonitorMenuItem[];
}

export interface MonitorModule {
  /** 模块 key（图标类名 icon-module-<key>-o；CSS 变量联动） */
  key: string;
  /** 模块中文标题（hover 提示，与原版一致） */
  title: string;
  /** 模块主色（原版 8 色：manufacturing 红 / purchase 黄 / sales 绿 / stock 深绿 / timerecording 蓝 / accounting 紫 / basicdata 灰 / customreports 青） */
  color: string;
  /** 该模块下的分类；空数组 = 模块无程序（侧边菜单显示空态） */
  categories: MonitorMenuCategory[];
}

/** 8 个模块（顺序与原版导轨一致：生产/采购/销售/库存/时间记录/会计/通用登记/定制包） */
export const monitorModules: MonitorModule[] = [
  {
    key: 'manufacturing',
    title: '生产',
    color: '#db0000',
    categories: [],
  },
  {
    key: 'purchase',
    title: '采购',
    color: '#e6d600',
    categories: [],
  },
  {
    key: 'sales',
    title: '销售',
    color: '#2ee600',
    categories: [
      {
        label: '客户',
        items: [{ caption: '客户', href: '/customers' }],
      },
    ],
  },
  {
    key: 'stock',
    title: '库存',
    color: '#208a00',
    categories: [],
  },
  {
    key: 'timerecording',
    title: '时间记录',
    color: '#0050c7',
    categories: [],
  },
  {
    key: 'accounting',
    title: '会计',
    color: '#9c00f0',
    categories: [
      {
        label: '项目管理',
        items: [{ caption: '项目', href: '/projects' }],
      },
    ],
  },
  {
    key: 'basicdata',
    title: '通用登记',
    color: '#a6a6a6',
    categories: [
      {
        label: '知识库',
        items: [{ caption: '知识库', href: '/kb' }],
      },
      {
        label: '用户与权限',
        items: [{ caption: '用户管理', href: '/users' }],
      },
    ],
  },
  {
    key: 'customreports',
    title: '定制包',
    color: '#00c7d1',
    categories: [
      {
        label: 'AI 工具',
        items: [
          { caption: 'AI 客服', href: '/agent' },
          { caption: '用量统计', href: '/usage' },
          { caption: 'AI 配置', href: '/ai' },
        ],
      },
      {
        label: '开发调试',
        items: [
          { caption: 'RAG 调试台', href: '/rag' },
          { caption: '导入调试台', href: '/import' },
        ],
      },
    ],
  },
];

/** 默认视图（未选中任何模块时的侧边菜单）：最近 / 个人 / 内部应用程序 */
export const homeCategories: MonitorMenuCategory[] = [
  {
    label: '最近',
    items: [
      { caption: '客户', href: '/customers' },
      { caption: '项目', href: '/projects' },
      { caption: '知识库', href: '/kb' },
    ],
  },
  {
    label: '个人',
    items: [
      { caption: 'AI 客服', href: '/agent' },
      { caption: '用量统计', href: '/usage' },
    ],
  },
  {
    label: '内部应用程序',
    items: [
      { caption: '用户管理', href: '/users' },
      { caption: 'AI 配置', href: '/ai' },
      { caption: 'RAG 调试台', href: '/rag' },
      { caption: '导入调试台', href: '/import' },
    ],
  },
];
