import type { KbCategory, KbStatus } from '@monitor/shared';

/** 知识库字段的中文标签（issue #19；枚举值存英文，展示转中文） */
export const KB_CATEGORY_LABELS: Record<KbCategory, string> = {
  manual: '操作手册',
  faq: 'FAQ',
  best_practice: '最佳实践',
};

export const KB_STATUS_LABELS: Record<KbStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
};

/** 状态徽标颜色（列表/详情展示） */
export const KB_STATUS_COLORS: Record<KbStatus, string> = {
  draft: '#b45309', // 琥珀
  published: '#15803d', // 绿
  archived: '#6b7280', // 灰
};
