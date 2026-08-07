import { describe, expect, it } from 'vitest';
import { decodeXmlEntities, flowToText, parseDrawioXml, stripHtml } from './drawio-parser';

/** 真实 draw.io 导出形态（swimlane 容器 + 顶点 + 边 + HTML 实体 value） */
const FIXTURE = `<mxfile>
  <diagram id="page1" name="Page-1">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="订单处理" style="swimlane;horizontal=1;" vertex="1" parent="1">
          <mxGeometry x="20" y="20" width="560" height="320" as="geometry" />
        </mxCell>
        <mxCell id="3" value="接收订单" style="rounded=1;" vertex="1" parent="2">
          <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="4" value="审核&amp;确认" vertex="1" parent="2">
          <mxGeometry x="40" y="140" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="5" value="&lt;b&gt;发货&lt;/b&gt;&lt;br&gt;含装箱单" vertex="1" parent="2">
          <mxGeometry x="200" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="6" value="库存不足" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="2" source="3" target="4">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

describe('decodeXmlEntities', () => {
  it('单 pass 解码命名与数字实体（&amp;lt; 不二次解码）', () => {
    expect(decodeXmlEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
    expect(decodeXmlEntities('&#10;A&#x9;B')).toBe('\nA\tB');
  });
});

describe('stripHtml', () => {
  it('剥标签 + br/div 换行 + 空白折叠', () => {
    expect(stripHtml('&lt;b&gt;发货&lt;/b&gt;&lt;br&gt;含装箱单')).toBe('发货\n含装箱单');
    expect(stripHtml('<div>行一</div><div>行二</div>')).toBe('行一\n行二');
    expect(stripHtml('  a   b  ')).toBe('a b');
  });
  it('文本裸 &gt; 不被误剥', () => {
    expect(stripHtml('下一步 -&gt; 结束')).toBe('下一步 -> 结束');
  });
});

describe('parseDrawioXml', () => {
  it('swimlane 分组 + (y,x) 排序 + 容器标题', () => {
    const flow = parseDrawioXml(FIXTURE);
    expect(flow.sections).toHaveLength(1);
    const section = flow.sections[0];
    expect(section.title).toBe('订单处理');
    // y 排序：40 行（接收订单 y40 x40 在 发货 y40 x200 之前，x 次级排序）→ 140 行
    expect(section.steps.map((s) => s.text)).toEqual([
      '接收订单',
      '发货\n含装箱单',
      '审核&确认',
    ]);
  });

  it('边带 label，source/target 为顶点 id', () => {
    const flow = parseDrawioXml(FIXTURE);
    expect(flow.edges).toEqual([{ source: '3', target: '4', label: '库存不足' }]);
  });

  it('flowToText 输出区块 + 编号步骤 + 连线', () => {
    const text = flowToText(parseDrawioXml(FIXTURE));
    expect(text).toContain('## 订单处理');
    expect(text).toContain('1. 接收订单');
    expect(text).toContain('## 步骤连线');
    expect(text).toContain('接收订单 → 审核&确认（库存不足）');
  });

  it('顶层散点（无容器）归默认区块，无标题', () => {
    const flow = parseDrawioXml(
      `<root><mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="2" value="步骤甲" vertex="1" parent="1">
          <mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
      </root>`,
    );
    expect(flow.sections).toHaveLength(1);
    expect(flow.sections[0].title).toBe('');
    expect(flow.sections[0].steps.map((s) => s.text)).toEqual(['步骤甲']);
    expect(flowToText(flow)).toBe('1. 步骤甲');
  });

  it('容器 cell 本身不作为步骤', () => {
    const flow = parseDrawioXml(FIXTURE);
    const allTexts = flow.sections.flatMap((s) => s.steps.map((st) => st.text));
    expect(allTexts).not.toContain('订单处理');
  });

  it('非法/空输入 → 空结构不抛错', () => {
    expect(parseDrawioXml('')).toEqual({ sections: [], edges: [] });
    expect(parseDrawioXml('<mxfile><broken')).toEqual({ sections: [], edges: [] });
    expect(parseDrawioXml('<mxCell id="x">')).toEqual({ sections: [], edges: [] });
  });

  it('无文本顶点与容器忽略', () => {
    const flow = parseDrawioXml(
      `<root><mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="2" value="容器" vertex="1" parent="1"/>
        <mxCell id="3" vertex="1" parent="2"/>
      </root>`,
    );
    expect(flow.sections).toEqual([]);
  });
});
