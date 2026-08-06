import { Inject, Injectable } from '@nestjs/common';
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module';
import { langgraphCheckpointWrites, langgraphCheckpoints } from '../database/schema';

/** putWrites 的写入条目（langgraph 未从 @langchain/langgraph re-export PendingWrite；形状 = [channel, value]） */
type PendingWriteEntry = [string, unknown];

/**
 * LangGraph.js checkpoint 数据库持久化（issue #22，spec §5「checkpoint 持久化（数据库）」）。
 *
 * API 按 @langchain/langgraph-checkpoint 1.1.3 包内 .d.ts 确认：
 * - 抽象方法 getTuple / list(AsyncGenerator) / put(config, checkpoint, metadata, newVersions) / putWrites / deleteThread
 * - 序列化走 BaseCheckpointSaver.serde（JsonPlusSerializer）：dumpsTyped → ["json", Uint8Array]，
 *   存 UTF-8 解码后的 JSON 到 jsonb 列，读回 loadsTyped('json', string) 还原（消息对象往返无损）
 * - put 返回 {configurable: {thread_id, checkpoint_ns, checkpoint_id}}；putWrites 存
 *   [taskId, channel, value] 三元组（CheckpointPendingWrite），getTuple 反序列化后返回
 *
 * 只经 DRIZZLE 代理访问 DB：请求上下文内自动进请求事务（与 ai_messages 同事务原子）；
 * 无上下文时 RLS fail closed——单测/后台必须包 withInternalTx。
 */
@Injectable()
export class DrizzleCheckpointSaver extends BaseCheckpointSaver {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {
    super();
  }

  async getTuple(config: LangGraphRunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId !== 'string') return undefined;
    const checkpointId = config.configurable?.checkpoint_id;
    const [row] = await this.db
      .select()
      .from(langgraphCheckpoints)
      .where(
        and(
          eq(langgraphCheckpoints.threadId, threadId),
          checkpointId != null
            ? eq(langgraphCheckpoints.checkpointId, String(checkpointId))
            : undefined,
        ),
      )
      .orderBy(desc(langgraphCheckpoints.checkpointId)) // LangGraph uuid6 字典序 = 时间序
      .limit(1);
    if (!row) return undefined;
    return this.toTuple(row, config);
  }

  async *list(
    config: LangGraphRunnableConfig,
    options?: { limit?: number; before?: LangGraphRunnableConfig },
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId !== 'string') return;
    const filters = [eq(langgraphCheckpoints.threadId, threadId)];
    if (options?.before?.configurable?.checkpoint_id != null) {
      filters.push(
        lt(
          langgraphCheckpoints.checkpointId,
          String(options.before.configurable.checkpoint_id),
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(langgraphCheckpoints)
      .where(and(...filters))
      .orderBy(desc(langgraphCheckpoints.checkpointId))
      .limit(options?.limit ?? 1000);
    for (const row of rows) {
      const tuple = await this.toTuple(row, config);
      if (tuple) yield tuple;
    }
  }

  async put(
    config: LangGraphRunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, number | string>,
  ): Promise<LangGraphRunnableConfig> {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId !== 'string') {
      throw new Error(
        'Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.',
      );
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const parentCheckpointId =
      config.configurable?.checkpoint_id != null
        ? String(config.configurable.checkpoint_id)
        : null;
    const [, serializedCheckpoint] = await this.serde.dumpsTyped(checkpoint);
    const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);
    const checkpointJson = JSON.parse(new TextDecoder().decode(serializedCheckpoint));
    const metadataJson = JSON.parse(new TextDecoder().decode(serializedMetadata));
    // UPSERT 幂等重放（langgraph 重试/重放会重复 put 同 checkpoint_id）
    await this.db
      .insert(langgraphCheckpoints)
      .values({
        threadId,
        checkpointId: checkpoint.id,
        parentCheckpointId,
        checkpoint: checkpointJson,
        metadata: metadataJson,
      })
      .onConflictDoUpdate({
        target: [langgraphCheckpoints.threadId, langgraphCheckpoints.checkpointId],
        set: {
          parentCheckpointId,
          checkpoint: checkpointJson,
          metadata: metadataJson,
          createdAt: new Date(),
        },
      });
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: LangGraphRunnableConfig,
    writes: PendingWriteEntry[],
    taskId: string,
  ): Promise<void> {
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (typeof threadId !== 'string' || checkpointId == null) {
      throw new Error(
        'Failed to put writes. The passed RunnableConfig is missing a required "thread_id" or "checkpoint_id" field in its "configurable" property.',
      );
    }
    // 逐条序列化并 upsert（idx = 数组序，同 taskId 多通道写互不冲突；无 interrupt 的线性图无特殊错误写索引）
    for (const [idx, [channel, value]] of writes.entries()) {
      const [, serialized] = await this.serde.dumpsTyped(value);
      const write = [
        taskId,
        channel,
        JSON.parse(new TextDecoder().decode(serialized)),
      ];
      await this.db
        .insert(langgraphCheckpointWrites)
        .values({
          threadId,
          checkpointId: String(checkpointId),
          taskId,
          idx,
          write,
        })
        .onConflictDoUpdate({
          target: [
            langgraphCheckpointWrites.threadId,
            langgraphCheckpointWrites.checkpointId,
            langgraphCheckpointWrites.taskId,
            langgraphCheckpointWrites.idx,
          ],
          set: { write },
        });
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db
      .delete(langgraphCheckpointWrites)
      .where(eq(langgraphCheckpointWrites.threadId, threadId));
    await this.db
      .delete(langgraphCheckpoints)
      .where(eq(langgraphCheckpoints.threadId, threadId));
  }

  /** 行 → CheckpointTuple（序列化往返 + pendingWrites 三元组反序列化） */
  private async toTuple(
    row: typeof langgraphCheckpoints.$inferSelect,
    config: LangGraphRunnableConfig,
  ): Promise<CheckpointTuple | undefined> {
    try {
      const checkpoint = (await this.serde.loadsTyped(
        'json',
        JSON.stringify(row.checkpoint),
      )) as Checkpoint;
      const metadata = (await this.serde.loadsTyped(
        'json',
        JSON.stringify(row.metadata),
      )) as CheckpointMetadata;
      const writes = await this.db
        .select()
        .from(langgraphCheckpointWrites)
        .where(
          and(
            eq(langgraphCheckpointWrites.threadId, row.threadId),
            eq(langgraphCheckpointWrites.checkpointId, row.checkpointId),
          ),
        )
        .orderBy(asc(langgraphCheckpointWrites.idx));
      const pendingWrites: CheckpointTuple['pendingWrites'] = [];
      for (const w of writes) {
        const entry = (await this.serde.loadsTyped(
          'json',
          JSON.stringify(w.write),
        )) as [string, string, unknown];
        pendingWrites.push([entry[0], entry[1], entry[2]]);
      }
      const tuple: CheckpointTuple = { config, checkpoint, metadata, pendingWrites };
      if (row.parentCheckpointId != null) {
        tuple.parentConfig = {
          configurable: {
            thread_id: row.threadId,
            checkpoint_ns: config.configurable?.checkpoint_ns ?? '',
            checkpoint_id: row.parentCheckpointId,
          },
        };
      }
      return tuple;
    } catch {
      // 脏数据行（版本迁移/格式不符）不阻断图恢复
      return undefined;
    }
  }
}
