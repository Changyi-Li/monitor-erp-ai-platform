import { describe, expect, it } from 'vitest';
import { assembleManual } from './assembler';

describe('assembleManual', () => {
  it('按 seq 排序拼接：标题 + 元信息 + 目录 + 分章', () => {
    const body = assembleManual({
      title: '采购流程操作手册',
      projectName: '北区工厂二期',
      customerName: 'Alpha 制造',
      blueprintVersion: 3,
      chapters: [
        { seq: 2, title: '日常操作', contentMd: '## 子标题\n操作步骤。' },
        { seq: 1, title: '系统概述', contentMd: '本手册覆盖范围。' },
      ],
    });
    const lines = body.split('\n');
    expect(lines[0]).toBe('# 采购流程操作手册');
    expect(body).toContain('> 项目：北区工厂二期｜客户：Alpha 制造｜蓝图版本：v3');
    expect(body).toContain('## 目录');
    expect(body).toContain('- 1. 系统概述');
    expect(body).toContain('- 2. 日常操作');
    // 章节按 seq 顺序，标题带序号
    const idx1 = body.indexOf('## 1. 系统概述');
    const idx2 = body.indexOf('## 2. 日常操作');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
  });

  it('空章节跳过（目录与正文同步）', () => {
    const body = assembleManual({
      title: 'T',
      projectName: 'P',
      customerName: 'C',
      blueprintVersion: 1,
      chapters: [
        { seq: 1, title: '一章', contentMd: null },
        { seq: 2, title: '二章', contentMd: '   ' },
        { seq: 3, title: '三章', contentMd: '内容' },
      ],
    });
    expect(body).not.toContain('一章');
    expect(body).not.toContain('二章');
    expect(body).toContain('- 3. 三章');
    expect(body).toContain('## 3. 三章');
  });

  it('全部空章节 → 仅标题与元信息（无目录）', () => {
    const body = assembleManual({
      title: 'T',
      projectName: 'P',
      customerName: 'C',
      blueprintVersion: 1,
      chapters: [{ seq: 1, title: '一章', contentMd: null }],
    });
    expect(body).toBe(`# T

> 项目：P｜客户：C｜蓝图版本：v1`);
  });
});
