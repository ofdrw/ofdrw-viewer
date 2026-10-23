/**
 * 零依赖静态服务器：用于本地打开 examples/ 下的无构建示例。
 *
 * 以仓库根目录为站点根，因此示例可读取 examples/assets 下的 OFD 样例；默认端口
 * 5180，可用 `node scripts/serve-examples.mjs 8080` 覆盖。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/** 站点根目录（仓库根）。 */
const ROOT = resolve(process.cwd());
/** 监听端口；命令行第一个参数优先，默认 5180。 */
const PORT = Number.parseInt(process.argv[2] ?? process.env.PORT ?? '5180', 10);

/** 按扩展名返回 MIME 类型；未收录的类型按二进制流处理。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ofd': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * 把请求路径解析为站点根内的文件路径，并阻止目录穿越。
 *
 * @param {string} urlPath 以 `/` 开头的 URL 路径。
 * @returns {string | null} 安全的绝对文件路径；越界时返回 null。
 */
function resolveRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const absolute = resolve(JOIN_ROOT(), relative);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) return null;
  return absolute;
}

/** 返回站点根，独立成函数便于在 resolver 中保持可读。 */
function JOIN_ROOT() {
  return join(ROOT);
}

const server = createServer(async (request, response) => {
  const filePath = resolveRequestPath(request.url ?? '/');
  if (!filePath) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad Request');
    return;
  }

  try {
    let target = filePath;
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, 'index.html');
    const fileInfo = await stat(target);
    if (!fileInfo.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });

    response.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': fileInfo.size,
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`engine-h5 示例已启动：http://127.0.0.1:${PORT}/examples/engine-h5/`);
  console.log('Node/Vue/React 示例请分别执行 pnpm demo:node / demo:vue / demo:react。');
});