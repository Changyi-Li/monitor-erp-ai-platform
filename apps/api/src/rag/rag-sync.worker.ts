import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { IDX } from '../adapters/indexing/indexing.module';
import type { DocumentIndexPort } from '../adapters/indexing/document-index.port';
import { MQ } from '../adapters/mq/mq.module';
import type { MessageQueuePort } from '../adapters/mq/message-queue.port';
import { documentSyncs } from '../database/schema';
import { RagSyncService } from './rag-sync.service';
import { backoffDelayMs } from './rag-backoff';

/** 重试上限：attempt ≥ MAX_ATTEMPTS 后 failed 留痕停止重试（spec 56「超出记日志」） */
const MAX_ATTEMPTS = 5;
/** 定时扫 due 间隔（开发量级；事件驱动为主，此兜底覆盖 MQ 事件丢失/进程重启） */
const POLL_INTERVAL_MS = 2_000;

/**
 * 同步 Worker（issue #21，spec §4.3）：消费「文档变更」事件 + 定时扫 due 兜底。
 * - 事件驱动：subscribe('document.sync')（事务提交后的唤醒信号）
 * - 兜底：setInterval 扫 queued 或到期的 failed（nextRetryAt <= now）
 * - 乐观抢单：UPDATE ... WHERE status IN ('queued','failed')——并发（事件+定时）
 *   同时命中时只有一个成功，防重复导入
 * - 失败：attempt + 1 → nextRetryAt = now + 指数退避（backoffDelayMs）
 * 全程在内部上下文事务内（SET LOCAL is_internal，旁路 RLS 跨租户读写）。
 */
@Injectable()
export class RagSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RagSyncWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private unsubscriber: (() => void) | null = null;

  constructor(
    private readonly syncs: RagSyncService,
    @Inject(MQ) private readonly mq: MessageQueuePort,
    @Inject(IDX) private readonly idx: DocumentIndexPort,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscriber = await this.mq.subscribe('document.sync', (message) => {
      const { syncId } = message as { syncId: string };
      void this.processOne(syncId).catch((err) =>
        this.logger.error(`处理同步任务 ${syncId} 失败：${String(err)}`),
      );
    });
    this.timer = setInterval(() => {
      void this.processDue().catch((err) => this.logger.error(`扫描同步任务失败：${String(err)}`));
    }, POLL_INTERVAL_MS);
    // 启动即扫一次（进程重启后未完成的任务）
    void this.processDue().catch((err) => this.logger.error(`启动扫描同步任务失败：${String(err)}`));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.unsubscriber?.();
  }

  /** 扫描到期任务（queued 或 failed 且 nextRetryAt 已到）并逐个处理 */
  async processDue(): Promise<void> {
    const rows = await this.syncs.withInternalTx(async (tx) => {
      return tx
        .select({ id: documentSyncs.id })
        .from(documentSyncs)
        .where(
          and(
            inArray(documentSyncs.status, ['queued', 'failed']),
            // 未失败过（queued，nextRetryAt 空）或 重试已到点（failed，nextRetryAt <= now）
            or(isNull(documentSyncs.nextRetryAt), lte(documentSyncs.nextRetryAt, new Date())),
          ),
        )
        // delete 优先于同版本 upsert（「归档→恢复」时序：Index 先下架再重建，最终状态正确）
        .orderBy(sql`${documentSyncs.action} = 'delete' desc, ${documentSyncs.updatedAt} asc`)
        .limit(50);
    });
    // 串行处理（量小；IDX 内存实现无并发收益，避免 DB 连接竞争）
    for (const row of rows) {
      await this.processOne(row.id);
    }
  }

  /** 处理单个任务（乐观抢单 → 提取内容 → 导入/删除 → 状态流转） */
  async processOne(syncId: string): Promise<void> {
    await this.syncs.withInternalTx(async (tx) => {
      const [claimed] = await tx
        .update(documentSyncs)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(
          and(
            eq(documentSyncs.id, syncId),
            inArray(documentSyncs.status, ['queued', 'failed']),
          ),
        )
        .returning();
      if (!claimed) {
        return; // 已被其他消费者处理（processing/succeeded）——幂等防重入
      }
      try {
        if (claimed.action === 'delete') {
          await this.idx.remove(claimed.documentId, claimed.scope);
        } else {
          const entry = await this.syncs.buildEntry(tx, claimed);
          await this.idx.upsert(entry);
        }
        await tx
          .update(documentSyncs)
          .set({ status: 'succeeded', lastError: null, updatedAt: new Date() })
          .where(eq(documentSyncs.id, syncId));
      } catch (err) {
        const attempt = claimed.attempt + 1;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `同步失败（${claimed.documentType} ${claimed.documentId} v${claimed.versionNumber}，attempt ${attempt}）：${message}`,
        );
        if (attempt >= MAX_ATTEMPTS) {
          // 超出重试上限：failed 留痕 + 记日志（告警/文档级同步状态为 spec 后续增强）
          this.logger.error(
            `同步任务 ${syncId} 重试 ${MAX_ATTEMPTS} 次后仍失败：${message}`,
          );
          await tx
            .update(documentSyncs)
            .set({ status: 'failed', attempt, lastError: message, nextRetryAt: null, updatedAt: new Date() })
            .where(eq(documentSyncs.id, syncId));
        } else {
          // 指数退避：下次拾取时间 = now + backoff(attempt)
          await tx
            .update(documentSyncs)
            .set({
              status: 'failed',
              attempt,
              lastError: message,
              nextRetryAt: new Date(Date.now() + backoffDelayMs(attempt)),
              updatedAt: new Date(),
            })
            .where(eq(documentSyncs.id, syncId));
        }
      }
    });
  }
}
