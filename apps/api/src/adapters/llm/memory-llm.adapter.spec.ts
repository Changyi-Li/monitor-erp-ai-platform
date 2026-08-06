import { describe, expect, it } from 'vitest';
import { MemoryLlmAdapter } from './memory-llm.adapter';

const systemWithDocs = [
  '你是 Monitor G5 ERP 平台的内部客服 AI Agent，请基于检索文档回答用户问题。',
  '回答必须以 [n] 角标标注来源，n 为检索文档编号；没有相关检索文档时如实说明。',
  '',
  '[检索文档]',
  '[1] 标题：登录问题 FAQ（摘要：无法登录时请检查账号与密码。更多步骤见文档。）',
  '[2] 标题：订单模块蓝图（摘要：订单模块包含创建、审核、发货流程。）',
  '',
  '[历史对话]',
  '（无）',
].join('\n');

describe('memory LLM fake：确定性回答', () => {
  const llm = new MemoryLlmAdapter();

  it('同输入同输出（确定性）', async () => {
    const a = await llm.chat({
      messages: [
        { role: 'system', content: systemWithDocs },
        { role: 'user', content: '如何登录？' },
      ],
    });
    const b = await llm.chat({
      messages: [
        { role: 'system', content: systemWithDocs },
        { role: 'user', content: '如何登录？' },
      ],
    });
    expect(a.content).toBe(b.content);
  });

  it('回答含 [1] 角标与 top 文档标题/摘要', async () => {
    const { content } = await llm.chat({
      messages: [
        { role: 'system', content: systemWithDocs },
        { role: 'user', content: '如何登录？' },
      ],
    });
    expect(content).toContain('根据知识库「登录问题 FAQ」');
    expect(content).toContain('无法登录时请检查账号与密码');
    expect(content).toContain('来源 [1]');
  });

  it('追问（引用/刚才）→ 复述上一轮用户问题（多轮记忆）', async () => {
    const { content } = await llm.chat({
      messages: [
        {
          role: 'system',
          content: [
            ...systemWithDocs.split('\n').slice(0, -1), // 保留 [历史对话] 标记，去掉「（无）」
            '用户：如何登录？',
            '助手：根据知识库「登录问题 FAQ」：…[1]。',
          ].join('\n'),
        },
        { role: 'user', content: '刚才的来源是什么？' },
      ],
    });
    expect(content).toContain('上一轮您问的是「如何登录？」');
    expect(content).toContain('登录问题 FAQ');
    expect(content).toContain('[1]');
  });

  it('无检索结果 → 抱歉回答（无角标）', async () => {
    const { content } = await llm.chat({
      messages: [
        {
          role: 'system',
          content: [
            '你是 Monitor G5 ERP 平台的内部客服 AI Agent，请基于检索文档回答用户问题。',
            '',
            '[检索文档]',
            '（无检索结果）',
            '',
            '[历史对话]',
            '（无）',
          ].join('\n'),
        },
        { role: 'user', content: '天气如何？' },
      ],
    });
    expect(content).toContain('未找到相关信息');
    expect(content).not.toContain('[1]');
  });
});
