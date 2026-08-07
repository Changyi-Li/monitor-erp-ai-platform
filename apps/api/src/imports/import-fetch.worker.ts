import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImportsService } from './imports.service';

/**
 * 定时拉取 Worker（issue #25 定时增量同步）：按 IMPORT_FETCH_INTERVAL_MS 轮询外部
 * 导入源清单 → runFetch（增量暂存 + 删除派生）。IMPORT_FETCH_URL 未配置 → 不启动
 * （env.schema 校验通过即可，无拉取源时功能自然关闭）；异常仅记日志不炸进程
 * （下轮重试；失败清单拉取不会破坏已暂存内容）。
 */
@Injectable()
export class ImportFetchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportFetchWorker.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly imports: ImportsService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<string>('IMPORT_FETCH_URL')) {
      this.logger.log('未配置 IMPORT_FETCH_URL，定时拉取通道未启动');
      return;
    }
    const intervalMs = this.config.get<number>('IMPORT_FETCH_INTERVAL_MS') ?? 60_000;
    // 启动即拉一次（进程重启后追赶增量）
    void this.runSilently();
    this.timer = setInterval(() => {
      void this.runSilently();
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 静默拉取（定时器路径：无审计 actor，异常仅记日志） */
  private async runSilently(): Promise<void> {
    try {
      await this.imports.runFetch(null);
    } catch (err) {
      this.logger.error(`定时拉取失败：${String(err)}`);
    }
  }
}
