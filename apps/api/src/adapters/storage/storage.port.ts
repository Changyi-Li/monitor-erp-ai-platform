/**
 * 对象存储适配端口（S3 兼容抽象，spec 平台无关约束）。
 * 业务代码只依赖此接口，切换供应商（MinIO/OSS 等）只改配置。
 * presign（前端直传）留待 S3 ticket 需求驱动再引入，不为不存在的场景买单。
 */
export interface StoragePort {
  /** 写入对象，返回可定位的 key（S3 实现返回 URL） */
  put(
    key: string,
    body: Buffer,
    options?: { contentType?: string },
  ): Promise<string>;
  /** 读取对象；不存在返回 null */
  get(key: string): Promise<Buffer | null>;
  /** 删除对象（幂等） */
  delete(key: string): Promise<void>;
}
