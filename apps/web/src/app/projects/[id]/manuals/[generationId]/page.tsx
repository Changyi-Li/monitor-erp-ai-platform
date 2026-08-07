'use client';

import { useParams } from 'next/navigation';
import { ManualWizard } from '../../../../../components/manual-wizard';

/**
 * 操作手册生成向导（issue #26 验收 ②③④ 前端，Step2-5）：挂共享 ManualWizard。
 * 断点续做：直接加载会话详情，已发布会话 → 显示完成态 + 知识库草稿链接。
 * 权限：查看 = 项目成员；维护操作 = 仅 internal（后端 403 兜底，页面无内部入口时不可达）。
 */
export default function ManualGenerationPage() {
  const { id, generationId } = useParams<{ id: string; generationId: string }>();
  if (!id || !generationId) {
    return null;
  }
  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <ManualWizard projectId={id} generationId={generationId} />
    </div>
  );
}
