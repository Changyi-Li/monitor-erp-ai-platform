import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { can } from '@monitor/shared';
import type {
  AiConfigResponse,
  AiImageParsingRequest,
  AiImageParsingResponse,
} from '@monitor/contracts';
import { LLM, LLM_RUNTIME_CONFIG } from '../adapters/llm/llm.module';
import type { LLMClient } from '../adapters/llm/llm-client.port';
import type { ResolvedSceneConfig } from '../adapters/llm/scene-routing-llm.adapter';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';

/** 上传图片实测上限（base64 ≤8M 字符 ≈ 6MB 二进制，同 kb/minutes/blueprints 上传链路） */
const MAX_IMAGE_BYTES = 6_000_000;

/** 图片解析 system 约定：memory fake 多模态规则锚点（memory-llm.adapter 检查该区块；导出供 e2e token 精确断言） */
export const IMAGE_PARSE_SYSTEM =
  '你是 Monitor G5 ERP 平台的 AI 图片解析器。请解析用户上传的图片（draw.io 蓝图截图、' +
  '文档截图、附件图片），输出结构化流程描述（流程步骤 / 模块依赖 / 数据流向）。\n' +
  '[图片解析]';

/**
 * 平台内部 AI 能力（issue #24，spec #80–#82）：多模态图片解析（scene='document_parsing'，
 * 经 LLMClient 场景路由 → ai_usage 自动落库）+ 场景→模型映射查询（web 配置页数据源）。
 * 内部专属：agent:use 权限域（客户 403 兜底 + RLS fail closed）。
 */
@Injectable()
export class AiService {
  constructor(
    @Inject(LLM) private readonly llm: LLMClient,
    @Inject(LLM_RUNTIME_CONFIG) private readonly sceneConfigs: ResolvedSceneConfig[],
    private readonly audit: AuditService,
  ) {}

  /** 内部 AI 权限 = 复用 agent:use（AI 功能域，不新增权限点——矩阵定稿契约最小改动） */
  assertAiUse(actor: AuthUser): void {
    if (!can(actor.role, 'agent:use')) {
      throw new ForbiddenException('仅内部用户可使用 AI 能力');
    }
  }

  /** 图片解析：base64 校验 → LLM 多模态调用（document_parsing 场景）→ 结构化结果 + 用量 */
  async parseImage(actor: AuthUser, body: AiImageParsingRequest): Promise<AiImageParsingResponse> {
    const buffer = Buffer.from(body.image.base64, 'base64');
    if (buffer.length === 0) throw new BadRequestException('图片内容不能为空');
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('图片过大（解码后不超过 6MB）');
    }
    if (!/^image\//.test(body.image.contentType)) {
      throw new BadRequestException('contentType 必须是图片类型（image/*）');
    }

    const dataUrl = `data:${body.image.contentType};base64,${body.image.base64}`;
    const { content, usage } = await this.llm.chat({
      messages: [
        { role: 'system', content: IMAGE_PARSE_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: body.prompt ?? '请解析这张图片，提取结构化流程描述。' },
            { type: 'image_url', imageUrl: dataUrl },
          ],
        },
      ],
      // 场景标注 = document_parsing（用量预留场景；UsageRecording 自动落 ai_usage）
      context: { scene: 'document_parsing' },
    });

    await this.audit.record(AUDIT_ACTIONS.AI_IMAGE_PARSE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'ai_image_parse',
      metadata: { contentType: body.image.contentType, size: buffer.length, model: usage.model },
    });

    return { content, usage };
  }

  /** 场景 → 模型映射（LLM_RUNTIME_CONFIG 注入，与 LLM 工厂同一次解析——单一事实来源） */
  async getConfig(actor: AuthUser): Promise<AiConfigResponse> {
    await this.audit.record(AUDIT_ACTIONS.AI_CONFIG_VIEW, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'ai_scene_config',
    });
    return { scenes: this.sceneConfigs };
  }
}
