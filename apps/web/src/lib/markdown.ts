/**
 * 轻量 Markdown → HTML 渲染器（issue #19 分栏实时预览；零依赖）。
 * 安全策略：**escape-first**——先转义原文全部 HTML 特殊字符，再应用块级/行内转换。
 * 转义后输入中不可能出现原始 <script>/<img onerror> 等（Markdown 图片/链接语法
 * 仅输出可控 href/src），`dangerouslySetInnerHTML` 渲染无 XSS 面，无需 sanitize 库
 * （区别于 ADR 0007 富文本直存 HTML 的取舍——本通道正文仅内部可写 + 客户只见已发布）。
 *
 * 支持子集（非完整 CommonMark，ADR 0008 已知取舍）：标题/无序有序列表/引用/
 * 围栏代码块/表格/分隔线/空行分段 + 行内 code/粗体/斜体/链接/图片。
 */

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

/** 行内转换（输入已转义）：`code`、**bold**、*italic*、[text](url)、![alt](src) */
function renderInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%" />')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/** 表格行（| 分隔）→ <tr>；首行为表头 */
function renderTableRow(cells: string[], isHeader: boolean): string {
  const tag = isHeader ? 'th' : 'td';
  const inner = cells
    .map((c) => c.trim())
    .map((c) => `<${tag}>${renderInline(c)}</${tag}>`)
    .join('');
  return `<tr>${inner}</tr>`;
}

/**
 * 分块渲染：逐行处理（围栏代码块 / 表格 / 标题 / 引用 / 列表 / 分隔线 / 段落）。
 * 输入必须已转义。输出完整 HTML 片段（不含 <html>/<body> 包装）。
 */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块 ```lang ... ```
    const fence = line.match(/^```/);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾 ```
      out.push(`<pre style="background:#f8fafc;padding:10px;border-radius:8px;overflow-x:auto"><code>${code.join('\n')}</code></pre>`);
      continue;
    }

    // 表格：当前行以 | 开头且下一行是分隔行（| --- |）
    const tableHead = line.match(/^\s*\|/);
    const separator = tableHead && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1] ?? '');
    if (tableHead && separator) {
      const headCells = line.split('|').slice(1, -1);
      const bodyRows: string[] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        bodyRows.push(renderTableRow(lines[i].split('|').slice(1, -1), false));
        i += 1;
      }
      out.push(
        `<table style="border-collapse:collapse;width:100%"><thead>${renderTableRow(headCells, true)}</thead><tbody>${bodyRows.join('')}</tbody></table>`,
      );
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用（连续 > 行合成一块）
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote style="border-left:3px solid #e5e7eb;margin:8px 0;padding-left:10px;color:#4b5563">${renderInline(quoted.join('<br/>'))}</blockquote>`);
      continue;
    }

    // 无序列表（连续 - / * / + 行合成一块）
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ul style="padding-left:22px;margin:8px 0">${items.join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ol style="padding-left:22px;margin:8px 0">${items.join('')}</ol>`);
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0" />');
      i += 1;
      continue;
    }

    // 空行 → 段落分隔
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // 普通段落（连续非空行合并，遇块级语法行停止）
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

/** 完整渲染入口：先转义再转换（escape-first 安全策略） */
export function renderMarkdownSafe(markdown: string): string {
  return renderMarkdown(escapeHtml(markdown));
}
