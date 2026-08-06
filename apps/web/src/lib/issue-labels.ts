import type {
  IssueCategory,
  IssueLinkTargetType,
  IssuePriority,
  IssueStatus,
  IssueType,
} from '@monitor/shared';

/** 问题字段的中文标签（spec §3.5；枚举值存英文，展示转中文） */
export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  bug: '缺陷',
  feature: '需求',
  question: '咨询',
};

export const ISSUE_CATEGORY_LABELS: Record<IssueCategory, string> = {
  function: '功能',
  data: '数据',
  usage: '使用',
  technical: '技术',
  optimization: '优化',
};

export const ISSUE_PRIORITY_LABELS: Record<IssuePriority, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  new: '新建',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭',
};

/** 问题关联目标类型（issue #20，spec 42） */
export const ISSUE_LINK_TARGET_LABELS: Record<IssueLinkTargetType, string> = {
  blueprint: '蓝图',
  minute: '会议纪要',
  kb_document: '知识库文档',
};
