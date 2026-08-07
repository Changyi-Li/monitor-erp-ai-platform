import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { importStagedDocuments } from '../database/schema';
import { RagSyncService } from '../rag/rag-sync.service';
import { backoffDelayMs } from '../rag/rag-backoff';
import { ImportsService } from './imports.service';

/** 重试上限：attempt ≥ MAX_ATTEMPTS 后 failed 留痕停止重试（同 rag-sync.worker） */
const MAX_ATTEMPTS = 5;
/** 定时扫 due 间隔（同 rag-sync.worker 开发量级） */
const POLL_INTERVAL_MS = 2_000;

/**
 * 导入消费 Worker（issue #25，spec §4.4 定时增量同步）：定时扫暂存表 due 任务
 * （pending 或到期的 failed）→ 乐观抢单 → apply 落库（upsert 落草稿 / delete
 * 硬删 + RAG 删除入队）。形态同构 rag-sync.worker（抢单/退避/启动即扫）；
 * 无 MQ 事件驱动（暂存写入量小，2s 轮询足够；apply 后若产生 RAG 任务由
 * ImportsService 在事务提交后 notify 唤醒 rag worker）。
 */
@Injectable()
export class ImportWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportWorker.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly imports: ImportsService,
    private readonly rag: RagSyncService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.processDue().catch((err) =>
        this.logger.error(`扫描导入暂存失败：${String(err)}`),
      );
    }, POLL_INTERVAL_MS);
    // 启动即扫一次（进程重启后未完成的任务）
    void this.processDue().catch((err) => this.logger.error(`启动扫描导入暂存失败：${String(err)}`));
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 扫描到期任务（pending 或 failed 且 nextRetryAt 已到）并逐个消费 */
  async processDue(): Promise<void> {
    const rows = await this.rag.withInternalTx(async (tx) => {
      return tx
        .select({ id: importStagedDocuments.id })
        .from(importStagedDocuments)
        .where(
          and(
            inArray(importStagedDocuments.status, ['pending', 'failed']),
            or(
              isNull(importStagedDocuments.nextRetryAt),
              lte(importStagedDocuments.nextRetryAt, new Date()),
            ),
          ),
        )
        .orderBy(sql`${importStagedDocuments.updatedAt} asc`)
        .limit(50);
    });
    // 串行消费（量小；apply 内 storage/DB 混用，避免连接竞争）
    for (const row of rows) {
      await this.applyAndRetry(row.id);
    }
  }

  /** 单条消费：applyOne + 失败退避（状态流转在 applyOne 内部事务，退避补在异常路径） */
  private async applyAndRetry(stagedId: string): Promise<void> {
    try {
      await this.imports.applyOne(stagedId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // applyOne 内部已把行标 processing；失败路径在这里做 attempt+1 + 退避/留痕
      // （与 rag worker 的「抢单后 try/catch 状态流转」等价，只是跨了两次事务）
      await this.rag.withInternalTx(async (tx) => {
        const [row] = await tx
          .select({ id: importStagedDocuments.id, attempt: importStagedDocuments.attempt })
          .from(importStagedDocuments)
          .where(eq(importStagedDocuments.id, stagedId))
          .limit(1);
        if (!row) {
          return;
        }
        const attempt = row.attempt + 1;
        this.logger.warn(`导入暂存 ${stagedId} 失败（attempt ${attempt}）：${message}`);
        if (attempt >= MAX_ATTEMPTS) {
          this.logger.error(`导入暂存 ${stagedId} 重试 ${MAX_ATTEMPTS} 次后仍失败：${message}`);
          await tx
            .update(importStagedDocuments)
            .set({ status: 'failed', attempt, lastError: message, nextRetryAt: null, updatedAt: new Date() })
            .where(eq(importStagedDocuments.id, stagedId));
        } else {
          await tx
            .update(importStagedDocuments)
            .set({
              status: 'failed',
              attempt,
              lastError: message,
              nextRetryAt: new Date(Date.now() + backoffDelayMs(attempt)),
              updatedAt: new Date(),
            })
            .where(eq(importStagedDocuments.id, stagedId));
        }
      });
    }
  }
}
