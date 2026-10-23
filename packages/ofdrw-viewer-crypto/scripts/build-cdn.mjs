/**
 * 构建供 CDN 直接使用的 crypto 插件包。
 *
 * 产出（均位于 `dist/`）：
 * - `ofdrw-viewer-crypto.js`：IIFE，未压缩，挂到 `globalThis.OFDRWViewerCrypto`；
 * - `ofdrw-viewer-crypto.min.js`：IIFE，压缩并生成 sourcemap，供 jsDelivr/unpkg 等 CDN 分发。
 *
 * crypto 插件**不内联 engine**：`@ofdrw/ofdrw-viewer-engine` 被替换为
 * `scripts/engine-global-shim.cjs`，运行时从页面已加载的 `globalThis.OFDRWViewer`
 * 取 `OFDError`/`isOFDError`/`openZipVirtualContainer`。因此加载顺序必须是：
 * engine 的 ofdrw-viewer-engine.js/.min.js → crypto 的 ofdrw-viewer-crypto.js/.min.js。
 *
 * 构建完成后会执行自检：
 * - 产物中不得残留 `require()`、动态 `import()` 或 `node:` 引用；
 * - 未加载 engine 时执行产物，必须抛出可读的依赖顺序错误；
 * - 先执行 engine 产物再执行 crypto 产物，确认全局导出完整。
 */

import { gzipSync } from 'node:zlib';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

/** crypto 包根目录。 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 构建产物目录。 */
const DIST_DIR = join(PACKAGE_ROOT, 'dist');
/** 包入口文件。 */
const ENTRY_FILE = join(PACKAGE_ROOT, 'src/index.ts');
/** engine 全局包的构建产物；由 engine 包的 build 生成。 */
const ENGINE_GLOBAL_FILE = join(
  PACKAGE_ROOT,
  '..',
  'ofdrw-viewer-engine',
  'dist',
  'ofdrw-viewer-engine.js',
);
/** engine 的运行时桥接模块。 */
const ENGINE_SHIM_FILE = join(PACKAGE_ROOT, 'scripts', 'engine-global-shim.cjs');
/** IIFE 暴露的全局变量名。 */
const GLOBAL_NAME = 'OFDRWViewerCrypto';
/** 必须出现在全局对象上的公共 API（值导出），用作构建自检。 */
const REQUIRED_EXPORTS = [
  'CRYPTO_ERROR_CODES',
  'CryptoError',
  'isCryptoError',
  'toCryptoError',
  'inspect',
  'verifyOfd',
];

/** 读取包元数据，用于生成 banner。 */
const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/**
 * 解析 esbuild。
 *
 * crypto 不直接依赖 esbuild；优先使用直接依赖，其次复用 tsup 自带的 esbuild。
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
  // SM2/ASN.1 使用 BigInt 字面量，ES2020 是能表达该语法的最低目标。
  target: 'es2020',
  charset: 'utf8',
  legalComments: 'eof',
  alias: {
    // 浏览器插件复用页面已加载的 engine，避免把 engine 再打包一次。
    '@ofdrw/ofdrw-viewer-engine': ENGINE_SHIM_FILE,
  },
  banner: {
    js: `/*! ${pkg.name} v${pkg.version} | ${pkg.license} License | ${pkg.homepage ?? ''} */`,
  },
  logLevel: 'warning',
};

/**
 * 创建 IIFE 自检用的最小浏览器全局环境。
 *
 * @returns {Record<string, unknown>} VM sandbox。
 */
function createSandbox() {
  const sandbox = {
    console,
    TextDecoder,
    TextEncoder,
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    ArrayBuffer,
    Uint8Array,
    Uint8ClampedArray,
    AbortController,
    AbortSignal,
    DOMException,
    performance,
    crypto: globalThis.crypto,
  };
  sandbox.globalThis = sandbox;
  return sandbox;
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
 * 读取 engine 的全局产物并要求其已构建。
 *
 * @returns {Promise<string>} engine 的 ofdrw-viewer-engine.js 源码。
 */
async function loadEngineGlobal() {
  try {
    return await readFile(ENGINE_GLOBAL_FILE, 'utf8');
  } catch {
    throw new Error(
      `未找到 engine 产物 ${ENGINE_GLOBAL_FILE}；请先构建 @ofdrw/ofdrw-viewer-engine`,
    );
  }
}

/**
 * 校验未加载 engine 时插件给出明确的加载顺序错误。
 *
 * @param {string} source crypto 产物源码。
 * @param {string} label 产物文件名，用于错误信息。
 * @returns {void}
 */
function assertMissingEngineError(source, label) {
  const sandbox = createSandbox();
  createContext(sandbox);
  let caught = null;
  try {
    runInContext(source, sandbox, { filename: label });
  } catch (error) {
    caught = error;
  }
  if (caught === null) {
    throw new Error(`${label} 在未加载 engine 时应抛出依赖顺序错误`);
  }
  if (!String(caught.message).includes('请先加载')) {
    throw new Error(`${label} 的依赖顺序错误信息不明确：${caught.message}`);
  }
}

/**
 * 在隔离 VM 中依次执行 engine 与 crypto 的 IIFE 产物，校验全局导出完整。
 *
 * @param {string} engineSource engine 的 ofdrw-viewer-engine.js 源码。
 * @param {string} source crypto 产物源码。
 * @param {string} label 产物文件名，用于错误信息。
 * @returns {Promise<void>}
 */
async function assertGlobalExports(engineSource, source, label) {
  assertSelfContained(source, label);
  assertMissingEngineError(source, label);

  const sandbox = createSandbox();
  createContext(sandbox);
  runInContext(engineSource, sandbox, { filename: 'ofdrw-viewer-engine.js' });
  runInContext(source, sandbox, { filename: label });

  const api = sandbox[GLOBAL_NAME];
  if (api === null || typeof api !== 'object') {
    throw new Error(`${label} 未挂载 globalThis.${GLOBAL_NAME}`);
  }
  const missing = REQUIRED_EXPORTS.filter((name) => !(name in api));
  if (missing.length > 0) {
    throw new Error(`${label} 缺少导出：${missing.join(', ')}`);
  }
}

/** 未压缩的调试版。 */
const unminifiedFile = join(DIST_DIR, 'ofdrw-viewer-crypto.js');
/** 压缩后的 CDN 版。 */
const minFile = join(DIST_DIR, 'ofdrw-viewer-crypto.min.js');

await mkdir(DIST_DIR, { recursive: true });
const engineSource = await loadEngineGlobal();

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

for (const [label, file] of [
  ['ofdrw-viewer-crypto.js', unminifiedFile],
  ['ofdrw-viewer-crypto.min.js', minFile],
]) {
  const source = await readFile(file, 'utf8');
  await assertGlobalExports(engineSource, source, label);
  const info = await stat(file);
  const gzip = gzipSync(Buffer.from(source), { level: 9 }).byteLength;
  console.log(`[cdn] ${label}: ${formatKb(info.size)}（gzip ${formatKb(gzip)}）→ ${file}`);
}