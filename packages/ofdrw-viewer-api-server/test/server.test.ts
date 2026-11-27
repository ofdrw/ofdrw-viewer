import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startApiServer } from '../src/server.js';
import type { RunningServer } from '../src/server.js';

/** 演示用 OFD（11 页）。 */
const SAMPLE = join(
  import.meta.dirname,
  '../../../demo-dist/samples/doc1File.ofd',
);

/** 加密 OFD，用于验证拒绝路径。 */
const ENCRYPTED = join(
  import.meta.dirname,
  '../../ofdrw-viewer-crypto/test/fixtures/crypto/password-encrypted.ofd',
);

/** 临时工作区。 */
let root = '';
/** 已启动的服务。 */
let server: RunningServer;

/** 构造 multipart 请求体。 */
function form(filePath: string, fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.append('file', new Blob([readFileSync(filePath)]), 'doc.ofd');
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/** 请求辅助。 */
async function call(
  path: string,
  init?: { method?: string; body?: RequestInit['body']; headers?: Record<string, string> },
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
    ...(init?.body === undefined ? {} : { body: init.body }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    // 服务端不再设请求超时，测试侧自设超时避免挂死，单位毫秒。
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ofdrw-api-server-'));
  await mkdir(join(root, 'jobs'), { recursive: true });
  await mkdir(join(root, 'logs'), { recursive: true });
  const loaded = await loadConfig({ cwd: root });
  const logger = pino({ level: 'silent' });
  server = await startApiServer(loaded.config, logger, loaded.jobDir, { port: 0 });
}, 60_000);

afterAll(async () => {
  if (server !== undefined) await server.close();
  if (root !== '') await rm(root, { recursive: true, force: true });
});

describe('系统接口', () => {
  it('GET /api/version 返回版本与平台', async () => {
    const { status, json } = await call('/api/version');
    expect(status).toBe(200);
    expect(json.node).toBe(process.version);
    expect(json.apiVersion).toBe('1');
  });

  it('GET /api/health 返回作业统计', async () => {
    const { status, json } = await call('/api/health');
    expect(status).toBe(200);
    expect(json.status).toBe('ok');
    expect(json.jobDir.path).toContain('jobs');
  });

  it('GET /api/openapi.json 返回 OpenAPI 3.1', async () => {
    const { status, json } = await call('/api/openapi.json');
    expect(status).toBe(200);
    expect(json.openapi).toBe('3.1.0');
  });

  it('未知路径返回 404', async () => {
    const { status, json } = await call('/api/nope');
    expect(status).toBe(404);
    expect(json.code).toBe('CLI_ROUTE_NOT_FOUND');
  });

  it('路径存在但方法不匹配返回 405 并带 Allow', async () => {
    const response = await fetch(`${server.url}/api/convert`, { method: 'GET' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toContain('POST');
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('CLI_METHOD_NOT_ALLOWED');
  });
});

describe('同步接口', () => {
  it('POST /api/info 返回页数', async () => {
    const { status, json } = await call('/api/info', { body: form(SAMPLE) });
    expect(status).toBe(200);
    expect(json.document.pageCount).toBe(11);
    expect(json.encrypted).toBe(false);
  });

  it('POST /api/convert 整本文档不受页数限制', async () => {
    const { status, json } = await call('/api/convert', { body: form(SAMPLE, { dpi: '72' }) });
    expect(status).toBe(200);
    expect(json.pages).toHaveLength(11);
  });

  it('POST /api/convert 指定两页返回 base64 图片', async () => {
    const { status, json } = await call('/api/convert', {
      body: form(SAMPLE, { pages: '1-2', dpi: '72' }),
    });
    expect(status).toBe(200);
    expect(json.pages).toHaveLength(2);
    expect(json.pages[0].image.length).toBeGreaterThan(100);
  });

  it('POST /api/text 返回坐标项', async () => {
    const { status, json } = await call('/api/text', { body: form(SAMPLE, { pages: '1' }) });
    expect(status).toBe(200);
    expect(json.pages[0].items.length).toBeGreaterThan(0);
    expect(json.pages[0].items[0]).toHaveProperty('x');
  });

  it('POST /api/pages 返回页尺寸', async () => {
    const { status, json } = await call('/api/pages', { body: form(SAMPLE) });
    expect(status).toBe(200);
    expect(json.pageCount).toBe(11);
    expect(json.pages[0].widthMm).toBeGreaterThan(0);
  });

  it('POST /api/verify 返回验证报告', async () => {
    const { status, json } = await call('/api/verify', { body: form(SAMPLE) });
    expect(status).toBe(200);
    expect(typeof json.overall).toBe('string');
  });

  it('加密文档返回 415', async () => {
    const { status, json } = await call('/api/info', { body: form(ENCRYPTED) });
    expect(status).toBe(415);
    expect(json.code).toBe('OFD_ENCRYPTED');
  });

  it('JSON 请求体缺少 file 返回 400', async () => {
    const { status, json } = await call('/api/info', {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(status).toBe(400);
    expect(json.code).toBe('CLI_USAGE');
  });

  it('不支持的 Content-Type 返回 415', async () => {
    const { status, json } = await call('/api/info', {
      body: 'raw',
      headers: { 'content-type': 'text/plain' },
    });
    expect(status).toBe(415);
    expect(json.code).toBe('CLI_UNSUPPORTED_MEDIA_TYPE');
  });

  it('JSON 请求体携带 base64 文档', async () => {
    const bytes = readFileSync(SAMPLE);
    const { status, json } = await call('/api/info', {
      body: JSON.stringify({
        file: { name: 'doc.ofd', base64: Buffer.from(bytes).toString('base64') },
        params: {},
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(status).toBe(200);
    expect(json.document.pageCount).toBe(11);
  });
});

describe('作业接口', () => {
  it('创建、执行、取文件、下载 ZIP、删除', async () => {
    const created = await call('/api/jobs', {
      body: form(SAMPLE, { ops: 'images,text', pages: '1-2', ttlSec: '600' }),
    });
    expect(created.status).toBe(201);
    const jobId = created.json.jobId as string;
    expect(jobId).toMatch(/^\d{12}N\d{6}$/u);

    let meta = created.json;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const polled = await call(`/api/jobs/${jobId}/meta.json`);
      meta = polled.json;
      if (meta.status !== 'queued' && meta.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(meta.status).toBe('done');
    expect(meta.files).toHaveLength(4);

    const file = await call(`/api/jobs/${jobId}/files/p001.png`);
    expect(file.status).toBe(200);

    const result = await fetch(`${server.url}/api/jobs/${jobId}/result`);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('application/zip');
    const zip = new Uint8Array(await result.arrayBuffer());
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);

    const removed = await call(`/api/jobs/${jobId}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);

    const after = await call(`/api/jobs/${jobId}/meta.json`);
    expect(after.status).toBe(404);
  }, 60_000);

  it('列表支持 limit 与 status 过滤', async () => {
    const all = await call('/api/jobs');
    expect(all.status).toBe(200);
    expect(Array.isArray(all.json)).toBe(true);
    const limited = await call('/api/jobs?limit=1');
    expect(limited.json.length).toBeLessThanOrEqual(1);
  });

  it('不存在的作业返回 404', async () => {
    const { status } = await call('/api/jobs/202601010000N000000/meta.json');
    expect(status).toBe(404);
  });

  it('非法作业 ID 返回 404', async () => {
    const { status } = await call('/api/jobs/not-a-job/meta.json');
    expect(status).toBe(404);
  });

  it('非法文件名返回 404', async () => {
    const created = await call('/api/jobs', { body: form(SAMPLE, { pages: '1', ttlSec: '600' }) });
    const jobId = created.json.jobId as string;
    const { status } = await call(`/api/jobs/${jobId}/files/..%2Fmeta.json`);
    expect(status).toBe(404);
    await call(`/api/jobs/${jobId}`, { method: 'DELETE' });
  });
});