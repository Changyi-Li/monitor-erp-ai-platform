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

  it('返回确定性 usage（model=memory，token=ceil(字符数/4)）', async () => {
    const messages = [
      { role: 'system', content: systemWithDocs },
      { role: 'user', content: '如何登录？' },
    ];
    const { content, usage } = await llm.chat({ messages });
    expect(usage.model).toBe('memory');
    const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
    expect(usage.inputTokens).toBe(Math.ceil(inputChars / 4));
    expect(usage.outputTokens).toBe(Math.ceil(content.length / 4));
  });
});

describe('memory LLM fake：多模态（issue #24）', () => {
  const llm = new MemoryLlmAdapter();

  const imageSystem = [
    '你是 Monitor G5 ERP 平台的 AI 图片解析器。请解析用户上传的图片，输出结构化流程描述。',
    '[图片解析]',
  ].join('\n');

  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('system 含 [图片解析] + user 含图片 → 确定性流程模板', async () => {
    const { content } = await llm.chat({
      messages: [
        { role: 'system', content: imageSystem },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请解析这张图片' },
            { type: 'image_url', imageUrl: dataUrl },
          ],
        },
      ],
    });
    expect(content).toContain('流程解析（memory 驱动模拟）');
    expect(content).toContain('结构化输出');
    expect(content).toContain('Qwen-VL');
  });

  it('system 无 [图片解析] 标记 → 不触发模板（走检索规则）', async () => {
    const { content } = await llm.chat({
      messages: [
        { role: 'system', content: systemWithDocs },
        {
          role: 'user',
          content: [
            { type: 'text', text: '如何登录？' },
            { type: 'image_url', imageUrl: dataUrl },
          ],
        },
      ],
    });
    expect(content).toContain('根据知识库「登录问题 FAQ」');
    expect(content).not.toContain('流程解析');
  });

  it('user 无图片 part（纯文本 parts）→ 走检索规则', async () => {
    const { content } = await llm.chat({
      messages: [
        { role: 'system', content: imageSystem },
        { role: 'user', content: [{ type: 'text', text: '如何登录？' }] },
      ],
    });
    expect(content).not.toContain('流程解析');
  });

  it('估算按 messageText 归一化（图片 data URL 全串计入字符）', async () => {
    const messages = [
      { role: 'system', content: imageSystem },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请解析' },
          { type: 'image_url', imageUrl: dataUrl },
        ],
      },
    ];
    const { usage } = await llm.chat({ messages });
    const inputChars = '请解析'.length + dataUrl.length + imageSystem.length;
    expect(usage.inputTokens).toBe(Math.ceil(inputChars / 4));
  });
});
