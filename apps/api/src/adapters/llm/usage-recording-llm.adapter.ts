import { Inject, Injectable } from '@nestjs/common';
import { aiUsage } from '../../database/schema';
import { DRIZZLE, type Database } from '../../database/database.module';
import { TenantContextService } from '../../database/tenant-context.service';
import type { LLMClient, LlmChatInput, LlmChatResult } from './llm-client.port';

/**
 * 用量计量 wrapper（issue #23，spec #77「所有 LLM 调用统一经 LLMClient 记录」）：
 * 包住任意 driver（memory fake / 未来真实驱动），chat() 成功后把 usage + 场景/归属
 * 标注落 ai_usage——未来任何场景（手册生成等）接入 LLMClient 即自动计量，业务零改动。
 *
 * 事务语义：经 DRIZZLE 代理（ALS 上下文）——请求上下文内自动进请求事务（与
 * ai_messages 等原子）；无上下文（单测/后台）RLS fail closed → 必须包 withInternalTx。
 * scene 必填（context 缺省抛错）：防漏标场景导致无法按场景计量。
 * 调用发起者（userId）从 ALS tenantContext 取（请求内 = actor.sub；后台 = system）。
 */
@Injectable()
export class UsageRecordingLlmClient implements LLMClient {
  constructor(
    private readonly inner: LLMClient,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContextService,
  ) {}

  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    const result = await this.inner.chat(input);
    if (!input.context?.scene) {
      throw new Error('LLM 调用必须标注 context.scene（AI 用量计量红线：缺场景无法计量）');
    }
    await this.db.insert(aiUsage).values({
      scene: input.context.scene,
      model: result.usage.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      customerId: input.context.customerId ?? null,
      projectId: input.context.projectId ?? null,
      userId: this.tenantContext.current?.userId ?? 'system',
      conversationId: input.context.conversationId ?? null,
    });
    return result;
  }
}
