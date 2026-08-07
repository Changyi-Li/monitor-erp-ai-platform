'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  AiConfigResponseSchema,
  AiImageParsingResponseSchema,
  type AiConfigResponse,
  type AiImageParsingResponse,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../lib/api';
import { useAuth } from '../../components/auth-provider';
import { isPlatformRole } from '../../lib/roles';

/**
 * AI 配置页（issue #24 验收④ demo path）：
 * - 场景 → 模型映射表（GET /api/ai/config；换模型 = 改 .env 的 LLM_DRIVER_* + LLM_OPENAI_*
 *   后重启服务，业务代码零改动——映射随配置变化）
 * - 图片解析演示（多模态）：上传 draw.io 蓝图截图/文档截图 → LLM 返回结构化流程描述 + 用量
 * 内部专属（agent:use 权限域）；客户用户访问后端 403 兜底。
 */

const SOURCE_LABELS: Record<string, string> = {
  scene: '场景专属',
  global: '全局 LLM_DRIVER',
  default: '内置兜底',
};

const DRIVER_LABELS: Record<string, string> = {
  memory: 'memory（内置 fake）',
  openai: 'openai（兼容协议）',
};

/** 读取文件 → base64（同 kb/blueprint 上传链路；≤8M 字符 ≈ 6MB 二进制） */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.replace(/^data:[^;]+;base64,/, ''));
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export default function AiPage() {
  const { user } = useAuth();
  const [config, setConfig] = useState<AiConfigResponse | null>(null);
  const [configError, setConfigError] = useState('');

  // 图片解析演示
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState('');
  const [prompt, setPrompt] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<AiImageParsingResponse | null>(null);
  const [parseError, setParseError] = useState('');

  useEffect(() => {
    apiFetch('/api/ai/config', { schema: AiConfigResponseSchema })
      .then(setConfig)
      .catch((err: unknown) => setConfigError(errorMessage(err)));
  }, []);

  async function handleParse(e: React.FormEvent) {
    e.preventDefault();
    setParseError('');
    setParseResult(null);
    const input = document.getElementById('image-input') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      setParseError('请先选择图片');
      return;
    }
    setParsing(true);
    try {
      const base64 = await readFileAsBase64(file);
      const res = await apiFetch('/api/ai/image-parsing', {
        method: 'POST',
        body: {
          image: { base64, contentType: file.type || 'image/png' },
          prompt: prompt || undefined,
        },
        schema: AiImageParsingResponseSchema,
      });
      setParseResult(res);
      setFileName(file.name);
      setFileType(file.type || 'image/png');
    } catch (err) {
      setParseError(errorMessage(err));
    } finally {
      setParsing(false);
    }
  }

  if (!user || !isPlatformRole(user.role)) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <h2>AI 配置</h2>
        <p style={{ color: '#b91c1c' }}>无权访问——AI 配置为内部功能（客户账号不可用）。</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <p>
        <Link href="/">← 返回首页</Link>
      </p>
      <h2>AI 配置</h2>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        场景化多模型路由（issue #24）：每个场景映射独立驱动（LLM_DRIVER_&lt;场景&gt; 回退 LLM_DRIVER）。
        切换模型 = 修改 .env 后重启服务，业务代码零改动；重新生成后下方用量可观测
        usage.model 变化（场景隔离：一个场景的模型故障不影响其他场景）。
      </p>

      {/* 区块 1：场景 → 模型映射 */}
      <section style={{ marginTop: 16 }}>
        <h3>场景 → 模型映射</h3>
        {configError && <p style={{ color: '#b91c1c' }}>{configError}</p>}
        {config && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ color: '#6b7280', fontSize: 12, textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>场景</th>
                <th style={{ padding: '6px 8px' }}>驱动</th>
                <th style={{ padding: '6px 8px' }}>模型</th>
                <th style={{ padding: '6px 8px' }}>配置来源</th>
                <th style={{ padding: '6px 8px' }}>状态</th>
              </tr>
            </thead>
            <tbody>
              {config.scenes.map((s) => (
                <tr key={s.scene} style={{ borderTop: '1px solid #e5e7eb' }}>
                  <td style={{ padding: '6px 8px' }}>
                    {s.label}
                    <span style={{ color: '#9ca3af', fontSize: 12 }}>（{s.scene}）</span>
                  </td>
                  <td style={{ padding: '6px 8px' }}>{DRIVER_LABELS[s.driver] ?? s.driver}</td>
                  <td style={{ padding: '6px 8px' }}>{s.model}</td>
                  <td style={{ padding: '6px 8px' }}>{SOURCE_LABELS[s.source] ?? s.source}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {s.enabled ? (
                      <span style={{ color: '#15803d' }}>可用</span>
                    ) : (
                      <span style={{ color: '#b91c1c' }}>不可用（{s.reason ?? '未知原因'}）</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 区块 2：图片解析演示 */}
      <section style={{ marginTop: 24 }}>
        <h3>图片解析演示（多模态）</h3>
        <p style={{ color: '#6b7280', fontSize: 13 }}>
          上传一张 draw.io 蓝图截图或文档截图 → AI 返回结构化流程描述（memory fake 为确定性模拟；
          配置 LLM_DRIVER_DOCUMENT_PARSING=openai + LLM_OPENAI_* 后由真实视觉模型解析）。
        </p>
        <form onSubmit={handleParse} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}>
          <input id="image-input" type="file" accept="image/*" required />
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="附加指令（可选，如：提取审批流）"
            style={{ padding: '6px 10px' }}
          />
          <button type="submit" disabled={parsing} style={{ alignSelf: 'flex-start' }}>
            {parsing ? '解析中…' : '解析图片'}
          </button>
        </form>
        {parseError && <p style={{ color: '#b91c1c', marginTop: 8 }}>{parseError}</p>}
        {parseResult && (
          <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px' }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {fileName}（{fileType}）
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 14, margin: '8px 0' }}>{parseResult.content}</pre>
            <div style={{ fontSize: 12, color: '#6b7280', borderTop: '1px solid #e5e7eb', paddingTop: 8 }}>
              用量：模型 {parseResult.usage.model} · 输入 {parseResult.usage.inputTokens.toLocaleString('zh-CN')} tokens ·
              输出 {parseResult.usage.outputTokens.toLocaleString('zh-CN')} tokens（已计入 AI 用量统计）
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
