#!/usr/bin/env node
/**
 * Web 验证页 smoke check。
 *
 * 启动 `vite preview`（默认 5178，可用 WEB_PORT 覆盖），轮询首页与内置示例，
 * 断言 HTTP 200 后关闭 preview 进程。退出码 0 表示通过，1 表示失败。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 仓库根目录。 */
const root = fileURLToPath(new URL('../..', import.meta.url));
/** 示例目录。 */
const webDir = fileURLToPath(new URL('.', import.meta.url));
/** 端口；非法值回退 5178。 */
const port = Number(process.env.WEB_PORT) || 5178;
/** 监听地址。 */
const host = '127.0.0.1';
/** 首页 URL。 */
const baseUrl = `http://${host}:${port}/`;
/** Vite CLI 路径；pnpm 在仓库根安装了 vite，但没有给 examples 建立 node_modules。 */
const viteBin = fileURLToPath(
  new URL(process.platform === 'win32' ? '../../node_modules/.bin/vite.cmd' : '../../node_modules/.bin/vite', import.meta.url),
);

if (!existsSync(viteBin)) {
  console.error(`[check] 找不到 vite CLI：${viteBin}`);
  process.exit(1);
}

/** preview 子进程。 */
let child = null;
/** preview 输出，失败时打印。 */
let output = '';

/**
 * 等待 HTTP 200。
 *
 * @param url 目标 URL。
 * @param timeoutMs 超时，毫秒。
 * @returns 响应正文。
 */
async function waitForOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`vite preview 提前退出（code=${child.exitCode}）\n${output}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return await response.text();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待 ${url} 超时：${lastError instanceof Error ? lastError.message : String(lastError)}\n${output}`);
}

/** 停止 preview；先 SIGTERM，超时再 SIGKILL。 */
async function stopPreview() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  child = spawn(viteBin, ['preview', '--host', host, '--port', String(port), '--strictPort'], {
    cwd: webDir,
    env: { ...process.env, WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const html = await waitForOk(baseUrl, 30_000);
  if (!html.includes('id="app"')) throw new Error('首页 HTML 缺少 #app');
  if (!html.includes('page-canvas')) throw new Error('首页 HTML 缺少 page-canvas');

  const sample = await fetch(new URL('samples/hello.ofd', baseUrl));
  if (sample.status !== 200) throw new Error(`内置示例 HTTP ${sample.status}`);
  const bytes = (await sample.arrayBuffer()).byteLength;
  if (bytes < 1024) throw new Error(`内置示例字节数异常：${bytes}`);

  console.log(`[check] preview ${baseUrl} 200 OK；内置示例 ${bytes} byte`);
  console.log('[check] PASS');
  process.exitCode = 0;
} catch (error) {
  console.error(`[check] FAIL：${error instanceof Error ? error.message : String(error)}`);
  if (output) console.error(`[check] vite 输出：\n${output}`);
  process.exitCode = 1;
} finally {
  await stopPreview();
}