/**
 * 操作手册整本组装（issue #26，spec §6）：分章节产物 → 完整 Markdown 手册。
 * 纯函数（预览与发布共用同一实现）：标题 + 元信息块（项目/客户/蓝图版本）+ 目录 +
 * 分章拼接；章节按 seq 排序，无内容章节跳过（目录同步跳过）。
 */

export interface AssembleChapter {
  seq: number;
  title: string;
  contentMd: string | null;
}

export interface AssembleManualInput {
  title: string;
  projectName: string;
  customerName: string;
  blueprintVersion: number;
  chapters: AssembleChapter[];
}

export function assembleManual(input: AssembleManualInput): string {
  const ordered = [...input.chapters]
    .sort((a, b) => a.seq - b.seq)
    .filter((chapter) => chapter.contentMd !== null && chapter.contentMd.trim().length > 0);

  const parts: string[] = [];
  parts.push(`# ${input.title}`);
  parts.push('');
  parts.push(
    `> 项目：${input.projectName}｜客户：${input.customerName}｜蓝图版本：v${input.blueprintVersion}`,
  );

  if (ordered.length > 0) {
    parts.push('');
    parts.push('## 目录');
    ordered.forEach((chapter) => {
      parts.push(`- ${chapter.seq}. ${chapter.title}`);
    });
    parts.push('');
  }

  ordered.forEach((chapter) => {
    parts.push(`## ${chapter.seq}. ${chapter.title}`);
    parts.push('');
    parts.push(chapter.contentMd!.trim());
    parts.push('');
  });

  return parts.join('\n');
}
