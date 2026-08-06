import { Module } from '@nestjs/common';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { LLM } from '../adapters/llm/llm.module';
import type { LLMClient } from '../adapters/llm/llm-client.port';
import { IDX } from '../adapters/indexing/indexing.module';
import type { DocumentIndexPort } from '../adapters/indexing/document-index.port';
import { AGENT_GRAPH } from './agent.constants';
import { buildAgentGraph } from './agent.graph';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { DrizzleCheckpointSaver } from './agent-checkpointer';

/**
 * 内部客服 AI Agent（issue #22）：LangGraph.js 图（检索/生成/引用解析）
 * + DrizzleCheckpointSaver 数据库持久化。LLM/IDX/Drizzle 均 @Global 注入。
 * 图与 checkpointer 均为单例——图无状态（状态全在 checkpoint），并发安全。
 */
@Module({
  controllers: [AgentController],
  providers: [
    DrizzleCheckpointSaver,
    {
      provide: AGENT_GRAPH,
      inject: [LLM, IDX, DrizzleCheckpointSaver],
      useFactory: (llm: LLMClient, idx: DocumentIndexPort, checkpointer: BaseCheckpointSaver) =>
        buildAgentGraph({ llm, idx, checkpointer }),
    },
    AgentService,
  ],
  exports: [AgentService],
})
export class AgentModule {}
