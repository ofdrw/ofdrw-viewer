/**
 * T11 Web URL 验收临时静态服务：只读目录、支持 Range 与 CORS。
 *
 * 仅用于本地验收，不参与生产构建。
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(get('--port', '5179'));
const root = resolve(get('--dir', 'test/.fixtures/acceptance'));
const types = {
  '.ofd': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.ttc': 'font/collection',
  '.otf': 'font/otf',
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!path.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const total = stat.size;
  const range = req.headers.range;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'range',
    'access-control-expose-headers': 'content-range, content-length, accept-ranges',
    'accept-ranges': 'bytes',
    'content-type': types[extname(path).toLowerCase()] ?? 'application/octet-stream',
  };
  let start = 0;
  let end = total - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      if (start >= 0 && start < total && start <= end) {
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${total}`;
      } else {
        res.writeHead(416, { 'content-range': `bytes */${total}`, 'access-control-allow-origin': '*' }).end();
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
  createReadStream(path, { start, end }).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`fixture server http://127.0.0.1:${port} root=${root}`);
});
