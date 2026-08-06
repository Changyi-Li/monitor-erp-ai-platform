/** 实施阶段/风险中文标签（issue #17） */

export const STAGE_STATUS_LABELS: Record<string, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  completed: '已完成',
  paused: '已暂停',
};

export const STAGE_STATUS_ORDER = ['not_started', 'in_progress', 'completed', 'paused'] as const;

export const RISK_LEVEL_LABELS: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** 等级标色（demo：风险列表按等级标色——高红/中橙/低绿） */
export const RISK_LEVEL_COLORS: Record<string, string> = {
  high: '#dc2626',
  medium: '#d97706',
  low: '#16a34a',
};

export const RISK_STATUS_LABELS: Record<string, string> = {
  open: '未处理',
  in_progress: '处理中',
  resolved: '已解决',
};
