/**
 * engine-h5 的零依赖静态服务器。
 *
 * 在示例目录内执行 `node serve.mjs`，然后访问 http://127.0.0.1:5180/。
 * 端口可通过环境变量 PORT 覆盖，例如 `PORT=8080 node serve.mjs`。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 示例根目录（本文件所在目录）。 */
const ROOT = fileURLToPath(new URL('.', import.meta.url));
/** 监听端口；默认 5180。 */
const PORT = Number(process.env.PORT ?? 5180);

/** 常见静态资源的 Content-Type。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ofd': 'application/ofd',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));

  // 拒绝跳出示例目录的路径。
  if (relative.startsWith('..') || relative.startsWith(`..${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(join(ROOT, relative));
    response.writeHead(200, { 'Content-Type': MIME[extname(relative)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not Found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`engine-h5 已启动：http://127.0.0.1:${PORT}/`);
});