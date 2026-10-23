/**
 * 构建供 CDN 直接使用的独立浏览器包。
 *
 * 产出（均位于 `dist/`）：
 * - `ofdrw-viewer-engine.js`：IIFE，未压缩，挂到 `globalThis.OFDRWViewer`，便于本地调试；
 * - `ofdrw-viewer-engine.min.js`：IIFE，压缩并生成 sourcemap，供 jsDelivr/unpkg 等 CDN 分发。
 *
 * 两个产物都把 fontkit/saxes/fflate 与内置图片解码器内联，运行时不需要任何
 * 模块加载器或外部依赖。构建完成后会执行自检：
 * - 产物中不得残留 `require()`、动态 `import()` 或 `node:` 引用；
 * - 在隔离的 VM 上下文中执行 `ofdrw-viewer-engine.js`，确认全局导出与包入口一致。
 */

import { gzipSync } from 'node:zlib';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

/** 包根目录（`packages/ofdrw-viewer-engine`）。 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 构建产物目录。 */
const DIST_DIR = join(PACKAGE_ROOT, 'dist');
/** 包入口文件。 */
const ENTRY_FILE = join(PACKAGE_ROOT, 'src/index.ts');
/** IIFE 暴露的全局变量名。 */
const GLOBAL_NAME = 'OFDRWViewer';
/** 必须出现在全局对象上的公共 API（值导出），用作构建自检。 */
const REQUIRED_EXPORTS = [
  'OFDDocument',
  'OFDPage',
  'RenderTask',
  'H5Canvas2DRenderer',
  'OFDError',
  'isOFDError',
  'toOFDError',
  'WARNING_CODES',
  'WarningCollector',
  'DEFAULT_CACHE_OPTIONS',
  'DEFAULT_RESOURCE_LIMITS',
  'DEFAULT_DPI',
  'MM_PER_INCH',
  'getPageTransform',
  'getPageViewport',
  'openZipVirtualContainer',
];

/** 读取包元数据，用于生成 banner。 */
const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/**
 * 解析 esbuild。
 *
 * 引擎不直接依赖 esbuild；优先使用直接依赖，其次复用 tsup 自带的 esbuild，
 * 避免为构建脚本新增依赖。
 *
 * @returns {typeof import('esbuild')} esbuild 模块。
 */
function loadEsbuild() {
  const require = createRequire(import.meta.url);
  try {
    return require('esbuild');
  } catch {
    // 继续尝试 tsup 的依赖。
  }
  try {
    const tsupRequire = createRequire(require.resolve('tsup'));
    return tsupRequire('esbuild');
  } catch {
    throw new Error('未找到 esbuild；请安装 esbuild 或确认 tsup 已正确安装');
  }
}

const { build } = loadEsbuild();

/** 所有产物共用的 esbuild 配置。 */
const sharedOptions = {
  entryPoints: [ENTRY_FILE],
  bundle: true,
  format: 'iife',
  globalName: GLOBAL_NAME,
  platform: 'browser',
  target: 'es2017',
  charset: 'utf8',
  legalComments: 'eof',
  banner: {
    js: `/*! ${pkg.name} v${pkg.version} | ${pkg.license} License | ${pkg.homepage ?? ''} */`,
  },
  logLevel: 'warning',
};

/**
 * 把一个产物文件压缩为 gzip，用于输出体积参考。
 *
 * @param {string} filePath 产物绝对路径。
 * @returns {Promise<{ raw: number; gzip: number }>} 原始字节数与 gzip 字节数。
 */
async function measure(filePath) {
  const bytes = await readFile(filePath);
  return { raw: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength };
}

/**
 * 把字节数格式化为便于阅读的 KB 文本。
 *
 * @param {number} bytes 字节数。
 * @returns {string} 例如 `716.8 KB`。
 */
function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * 扫描产物，拒绝任何运行时外部依赖。
 *
 * @param {string} code 产物源码。
 * @param {string} label 产物文件名，用于错误信息。
 * @returns {void}
 */
function assertSelfContained(code, label) {
  const patterns = [
    { name: 'CommonJS require()', regex: /\brequire\s*\(/ },
    { name: '动态 import()', regex: /\bimport\s*\(/ },
    // 只匹配带引号的模块说明符，避免误伤压缩后形如 `{node:c}` 的普通对象键。
    { name: 'Node 内建模块', regex: /(['"])node:[a-z/]+\1/ },
  ];
  for (const { name, regex } of patterns) {
    if (regex.test(code)) {
      throw new Error(`${label} 不是自包含产物：检测到 ${name}`);
    }
  }
}

/**
 * 在隔离 VM 中执行 IIFE 产物，校验全局导出完整。
 *
 * @param {string} filePath 产物绝对路径。
 * @param {string} label 产物文件名，用于错误信息。
 * @returns {Promise<Record<string, unknown>>} 产物挂载的全局对象。
 */
async function assertGlobalExports(filePath, label) {
  const source = await readFile(filePath, 'utf8');
  assertSelfContained(source, label);

  /** IIFE 只依赖少量标准全局；这里提供最小运行环境。 */
  const sandbox = {
    console,
    TextDecoder,
    TextEncoder,
    URL,
    Blob,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(source, sandbox, { filename: label });

  const api = sandbox[GLOBAL_NAME];
  if (api === null || typeof api !== 'object') {
    throw new Error(`${label} 未挂载 globalThis.${GLOBAL_NAME}`);
  }
  const missing = REQUIRED_EXPORTS.filter((name) => !(name in api));
  if (missing.length > 0) {
    throw new Error(`${label} 缺少导出：${missing.join(', ')}`);
  }
  return api;
}

await mkdir(DIST_DIR, { recursive: true });

/** 未压缩的调试版。 */
const unminifiedFile = join(DIST_DIR, 'ofdrw-viewer-engine.js');
/** 压缩后的 CDN 版。 */
const minFile = join(DIST_DIR, 'ofdrw-viewer-engine.min.js');

await build({
  ...sharedOptions,
  outfile: unminifiedFile,
  minify: false,
  // 未压缩产物本身可读，不再附带体积更大的 sourcemap。
  sourcemap: false,
});

await build({
  ...sharedOptions,
  outfile: minFile,
  minify: true,
  sourcemap: true,
});

await assertGlobalExports(unminifiedFile, 'ofdrw-viewer-engine.js');
await assertGlobalExports(minFile, 'ofdrw-viewer-engine.min.js');

for (const [label, file] of [
  ['ofdrw-viewer-engine.js', unminifiedFile],
  ['ofdrw-viewer-engine.min.js', minFile],
]) {
  const info = await stat(file);
  const size = await measure(file);
  console.log(
    `[cdn] ${label}: ${formatKb(info.size)}（gzip ${formatKb(size.gzip)}）→ ${file}`,
  );
}