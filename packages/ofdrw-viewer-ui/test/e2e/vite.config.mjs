import { createReadStream, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const fixtureTypes = {
  '.ofd': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.ttc': 'font/collection',
  '.otf': 'font/otf',
  '.pem': 'application/x-pem-file',
};

/**
 * OFD 夹具使用 Range 分段读取；Vite 静态中间件不保证 206，故在它之前自行处理。
 *
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {() => void} next 后续中间件。
 */
function serveFixture(req, res, next) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!/(?:\.ofd|\.pem)$/i.test(url.pathname)) {
    next();
    return;
  }
  const filePath = resolve(repositoryRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!filePath.startsWith(repositoryRoot)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const total = stat.size;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'range',
    'access-control-expose-headers': 'content-range, content-length, accept-ranges',
    'accept-ranges': 'bytes',
    'content-type': fixtureTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
  };
  let start = 0;
  let end = total - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      if (start >= 0 && start < total && start <= end) {
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${total}`;
      } else {
        res.writeHead(416, {
          'content-range': `bytes */${total}`,
          'access-control-allow-origin': '*',
        });
        res.end();
        return;
      }
    }
  }
  headers['content-length'] = String(end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

/**
 * E2E 静态服务配置：仓库根为 Vite root，测试产物不参与文件监听。
 * 不引入 `vite` 包，避免 E2E 额外声明未提交的依赖。
 */
export default {
  root: repositoryRoot,
  cacheDir: fileURLToPath(new URL('../../../../node_modules/.vite-e2e', import.meta.url)),
  server: {
    host: '127.0.0.1',
    strictPort: true,
    fs: { allow: [repositoryRoot] },
    hmr: false,
    watch: {
      ignored: ['**/test/acceptance/artifacts/**', '**/dist/**', '**/node_modules/**'],
    },
  },
  plugins: [
    {
      name: 'ofd-range-fixtures',
      configureServer(server) {
        server.middlewares.use((req, res, next) => serveFixture(req, res, next));
      },
    },
  ],
  optimizeDeps: {
    entries: ['packages/ofdrw-viewer-ui/test/e2e/index.html'],
  },
};
