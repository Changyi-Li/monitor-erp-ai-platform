/**
 * draw.io 流程图轻量解析器（issue #26，spec §6 操作手册自动生成）。
 * 零 XML 依赖（仓库无 XML 解析库）：draw.io 导出 XML 的属性值内 `>` 必转义为 &gt;，
 * `/<mxCell\b[^>]*>/g` 安全提取开始标签；value 是 HTML 实体串 → 解码后剥标签取文本。
 * 结构：vertex 按 parent 分组为 section（swimlane 等有 value 的容器 cell 即标题），
 * 组内按 (y, x) 布局排序；edge 携带连线 label（分支/判定说明）。
 * 解析失败/非法 XML → 空结构（不抛错，LLM 侧以流程字段兜底）。
 */

/** 一个流程步骤（顶点） */
export interface DrawioStep {
  id: string;
  text: string;
  x: number;
  y: number;
}

/** 流程区块（swimlane 容器；title 为空 = 顶层散点归组） */
export interface DrawioSection {
  title: string;
  steps: DrawioStep[];
}

/** 步骤连线（source/target = 顶点 id；label 为分支/判定说明） */
export interface DrawioEdge {
  source: string;
  target: string;
  label: string;
}

export interface DrawioFlow {
  sections: DrawioSection[];
  edges: DrawioEdge[];
}

/** 内部 cell 形态（解析中间产物） */
interface Cell {
  id: string;
  value: string;
  isVertex: boolean;
  isEdge: boolean;
  parent: string;
  source: string;
  target: string;
  x: number;
  y: number;
}

/** XML 数字/命名实体一次解码（单 pass：&amp; 最后替换，不会二次解码 &amp;lt;） */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * draw.io value 文本 → 纯文本：解码实体 → 块级/换行标签转 \n → 剥剩余标签
 * → 行清理（空白折叠 + 去空行）。`<` 开头形如标签的片段才剥除，文本裸 `>` 不受影响。
 */
export function stripHtml(value: string): string {
  const decoded = decodeXmlEntities(value);
  return decoded
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|h[1-6]|li|ul|ol)>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t\r ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

const ATTR_RE = /([a-zA-Z_][\w]*)\s*=\s*"([^"]*)"/g;

/** 单个 mxCell 开始标签 → cell（geometry 的 x/y 单独在标签内匹配） */
function parseCellTag(tag: string): Cell | null {
  const id = tag.match(/\bid="([^"]*)"/)?.[1];
  if (!id) {
    return null;
  }
  const attr = (name: string): string => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m?.[1] ?? '';
  };
  const value = attr('value');
  const geometry = tag.match(/<mxGeometry\b[^>]*>/);
  const gx = geometry?.[0].match(/\bx="([\d.-]+)"/)?.[1];
  const gy = geometry?.[0].match(/\by="([\d.-]+)"/)?.[1];
  return {
    id,
    value,
    isVertex: attr('vertex') === '1',
    isEdge: attr('edge') === '1',
    parent: attr('parent'),
    source: attr('source'),
    target: attr('target'),
    x: gx ? Number.parseFloat(gx) : 0,
    y: gy ? Number.parseFloat(gy) : 0,
  };
}

/**
 * 解析 draw.io XML → 流程结构。section 分组：vertex 的 parent 是有 value 的 vertex
 * 容器（swimlane/分组）→ 归属该容器；否则归默认 section（title ''）。组内按 (y,x)
 * 布局排序（自上而下、自左而右）。非法输入 → 空结构。
 */
export function parseDrawioXml(xml: string): DrawioFlow {
  const cells = new Map<string, Cell>();
  // mxCell 开始标签 + 可选紧随的子元素 <mxGeometry>（x/y 布局坐标所在）
  const tagRe = /<mxCell\b[^>]*>(?:\s*<mxGeometry\b[^>]*>)?/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml)) !== null) {
    const cell = parseCellTag(match[0]);
    if (cell) {
      cells.set(cell.id, cell);
    }
  }
  if (cells.size === 0) {
    return { sections: [], edges: [] };
  }

  // 容器判定：vertex 且被其他 vertex 引用为 parent
  const containerIds = new Set<string>();
  for (const cell of cells.values()) {
    if (cell.isVertex && cell.parent && cells.get(cell.parent)?.isVertex) {
      containerIds.add(cell.parent);
    }
  }

  const sections = new Map<string, { title: string; steps: DrawioStep[] }>();
  const defaultTitle = '__default__';
  sections.set(defaultTitle, { title: '', steps: [] });

  for (const cell of cells.values()) {
    if (containerIds.has(cell.id)) {
      continue; // 容器 cell 只作 section 标题，不作为步骤
    }
    if (!cell.isVertex || cell.value.length === 0) {
      continue; // 跳过无文本顶点
    }
    const text = stripHtml(cell.value);
    if (text.length === 0) {
      continue;
    }
    const key = containerIds.has(cell.parent) ? cell.parent : defaultTitle;
    const section = sections.get(key) ?? {
      title: containerIds.has(cell.parent)
        ? stripHtml(cells.get(cell.parent)?.value ?? '')
        : '',
      steps: [],
    };
    section.steps.push({ id: cell.id, text, x: cell.x, y: cell.y });
    sections.set(key, section);
  }

  const orderedSections = [...sections.values()]
    .map((section) => ({
      title: section.title,
      steps: [...section.steps].sort((a, b) => a.y - b.y || a.x - b.x),
    }))
    .sort((a, b) => {
      const ay = Math.min(...a.steps.map((s) => s.y));
      const by = Math.min(...b.steps.map((s) => s.y));
      return (Number.isFinite(ay) ? ay : Infinity) - (Number.isFinite(by) ? by : Infinity);
    })
    .filter((section) => section.steps.length > 0);

  const edges: DrawioEdge[] = [];
  for (const cell of cells.values()) {
    if (cell.isEdge && cell.source && cell.target) {
      edges.push({
        source: cell.source,
        target: cell.target,
        label: stripHtml(cell.value),
      });
    }
  }
  return { sections: orderedSections, edges };
}

/** 流程结构 → LLM 提示文本（章节大纲/正文生成的「蓝图流程」上下文） */
export function flowToText(flow: DrawioFlow): string {
  const parts: string[] = [];
  for (const section of flow.sections) {
    if (section.title) {
      parts.push(`## ${section.title}`);
    }
    section.steps.forEach((step, i) => {
      parts.push(`${i + 1}. ${step.text}`);
    });
  }
  if (flow.edges.length > 0) {
    const textById = new Map<string, string>();
    for (const section of flow.sections) {
      for (const step of section.steps) {
        textById.set(step.id, step.text);
      }
    }
    parts.push('## 步骤连线');
    for (const edge of flow.edges) {
      const from = textById.get(edge.source) ?? edge.source;
      const to = textById.get(edge.target) ?? edge.target;
      parts.push(edge.label ? `- ${from} → ${to}（${edge.label}）` : `- ${from} → ${to}`);
    }
  }
  return parts.join('\n');
}
