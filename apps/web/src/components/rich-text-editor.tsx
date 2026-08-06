'use client';

import { useEffect, useRef } from 'react';

/**
 * 富文本编辑器（issue #18 验收④「所见即所得」；零依赖）：
 * contentEditable + 工具栏（加粗/斜体/下划线/无序/有序列表），document.execCommand
 * （deprecated 但全浏览器支持）。正文以 HTML 存（body 字段），详情页原样渲染。
 * 注意：编辑器非受控（React 不接管 contentEditable），外部值变化时经 useEffect 同步。
 */
interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
}

const TOOLS = [
  ['bold', '加粗', 'B'],
  ['italic', '斜体', 'I'],
  ['underline', '下划线', 'U'],
  ['insertUnorderedList', '无序列表', '•'],
  ['insertOrderedList', '有序列表', '1.'],
] as const;

export default function RichTextEditor({ value, onChange }: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);

  // 外部值变化（切换编辑对象/重置表单）时同步；仅当与编辑器当前内容不同（避免清空用户正在输入的选区）
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value;
    }
  }, [value]);

  function exec(cmd: string) {
    ref.current?.focus();
    document.execCommand(cmd, false);
  }

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 6,
          borderBottom: '1px solid #e5e7eb',
          background: '#f9fafb',
          borderRadius: '8px 8px 0 0',
        }}
      >
        {TOOLS.map(([cmd, title, label]) => (
          <button
            key={cmd}
            type="button"
            title={title}
            // 阻止按钮抢焦点（execCommand 需要保留编辑器内选区）
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec(cmd)}
            style={{ minWidth: 28, fontSize: 13 }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
        style={{ minHeight: 120, padding: 8, outline: 'none', fontSize: 14 }}
      />
    </div>
  );
}
