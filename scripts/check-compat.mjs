#!/usr/bin/env node
/**
 * Chrome 67 产物兼容卡口（零依赖，仅使用 Node.js 内置模块）。
 *
 * 用途：扫描 engine / crypto / ui 的 `dist` 产物（ESM、CJS、CDN IIFE）与
 * `demo-dist` 的构建产物，阻止 Chrome 67 无法解析的语法、以及未被兼容层
 * 覆盖的“Chrome 67 缺失 API”调用进入发布产物。
 *
 * 设计约定：
 * - 只读仓库文件，不修改任何产物；发现违规时以非 0 退出并输出 `文件:行:列`。
 * - 先做词法遮罩（字符串、模板文本、注释、正则字面量），再匹配规则，
 *   避免把文案中的 `?.`、`??` 当成语法残留。
 * - Chrome 67 原生支持 BigInt 字面量，
 *   因此 `0n` 只统计、不阻塞；如需禁止可加 `--strict-bigint`。
 * - 已知缺失 API（replaceChildren、Object.fromEntries 等）由各包 compat 层
 *   运行时补齐；脚本按“产物内是否存在对应补丁定义”判定是否已被覆盖。
 *   补丁入口文件（`compat*.js`）内部的调用默认放行。
 * - 产物不存在时给出明确提示，默认不误报（退出 0）；CI 使用
 *   `--require-dist` 要求产物必须存在。
 *
 * 用法：
 *   node scripts/check-compat.mjs                 # 扫描全部构建产物
 *   node scripts/check-compat.mjs --self-test     # 运行内置违规/合规样例
 *   node scripts/check-compat.mjs --require-dist  # 产物缺失视为失败（CI）
 *   node scripts/check-compat.mjs --help
 *
 * 退出码：
 *   0 通过（或无产物且未要求）；1 存在阻塞违规；2 参数/配置错误或缺少必需产物。
 *
 * @file Chrome 67 兼容卡口
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 脚本所在目录（`<repo>/scripts`）。 */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录的默认值（脚本目录的上一级）。 */
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

/** 用户配置的多文件白名单文件名（相对仓库根目录）。 */
const WHITELIST_FILE = 'scripts/compat-whitelist.json';

/** 命令行帮助文本。 */
const HELP_TEXT = `Chrome 67 产物兼容卡口

用法：
  node scripts/check-compat.mjs [选项]

选项：
  --root <dir>          仓库根目录（默认：脚本上一级）
  --demo-dir <dir>      站点产物目录（默认：demo-dist/assets）
  --scan <path>         扫描指定文件或目录（可重复；用于验证违规/合规样例）
  --fixture <bad|good>  扫描内置违规/合规样例（bad 退出 1，good 退出 0）
  --self-test           运行内置违规/合规样例，不扫描真实产物
  --require-dist        缺少必需产物时退出 2（CI 使用）
  --strict-api          即使产物内存在 compat 补丁，也按阻塞违规报告缺失 API 调用
  --strict-bigint       BigInt 字面量也作为阻塞违规（默认仅统计）
  --show-covered        输出已被 compat 覆盖的 API 调用明细
  --json                以 JSON 输出扫描结果（便于机器消费）
  --no-demo             跳过站点产物扫描
  --only <ids>          只扫描指定产物集合（engine,crypto,ui,demo，逗号分隔）
  --allow <glob>        额外放行文件（可重复；放行 API 规则，语法仍检查）
  --help                打印本帮助

规则：
  语法阻塞：?.、??、||=/&&=/??=、#私有字段、static {}、数字分隔符、export * as
            （0n 默认只统计，Chrome 67 原生支持）
  API 阻塞：replaceChildren、replaceAll、Object.fromEntries、queueMicrotask、
            flatMap、Promise.allSettled、Blob/File.arrayBuffer，以及
            structuredClone / Object.hasOwn / Promise.any / WeakRef 等未覆盖 API

退出码：0 通过；1 存在阻塞违规；2 参数错误或缺少必需产物。

示例：
  node scripts/check-compat.mjs --help
  node scripts/check-compat.mjs --self-test
  node scripts/check-compat.mjs --fixture bad   # 应退出 1
  node scripts/check-compat.mjs --fixture good  # 应退出 0
  node scripts/check-compat.mjs
  node scripts/check-compat.mjs --scan .cache/fixtures --show-covered
  node scripts/check-compat.mjs --require-dist --json
`;

/**
 * 语法规则定义。
 *
 * `pattern` 在“已遮罩非代码内容”的文本上执行；`blocking: false` 表示
 * 该语法在 Chrome 67 上可用或有明确豁免（BigInt）。
 */
const SYNTAX_RULES = [
  {
    id: 'syntax/optional-chaining',
    label: '可选链 ?.',
    pattern: /\?\.(?!\d)/g,
    chrome: 'Chrome 80',
    blocking: true,
    advice: '把 tsup / esbuild / Vite 的构建目标改为 chrome67',
  },
  {
    id: 'syntax/nullish-coalescing',
    label: '空值合并 ??',
    pattern: /\?\?(?!=)/g,
    chrome: 'Chrome 80',
    blocking: true,
    advice: '把 tsup / esbuild / Vite 的构建目标改为 chrome67',
  },
  {
    id: 'syntax/logical-assignment',
    label: '逻辑赋值 ||= / &&= / ??=',
    pattern: /\|\|=|&&=|\?\?=/g,
    chrome: 'Chrome 85',
    blocking: true,
    advice: '把 tsup / esbuild / Vite 的构建目标改为 chrome67',
  },
  {
    id: 'syntax/bigint-literal',
    label: 'BigInt 字面量 0n',
    pattern: /(?<![\w$.])(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|\d(?:_?\d)*)n\b/g,
    chrome: 'Chrome 67',
    blocking: false,
    advice: 'Chrome 67 原生支持 BigInt（见兼容文档 §2.1/§4.3），保留即可；如需强制禁止用 --strict-bigint',
  },
  {
    id: 'syntax/numeric-separator',
    label: '数字分隔符 1_000',
    pattern: /\b(?:0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)+|0[oO][0-7]+(?:_[0-7]+)+|0[bB][01]+(?:_[01]+)+|\d+(?:_\d+)+)\b/g,
    chrome: 'Chrome 75',
    blocking: true,
    advice: '把构建目标改为 chrome67，或用普通数字字面量',
  },
  {
    id: 'syntax/export-star-as',
    label: 'export * as ns',
    pattern: /\bexport\s*\*\s*as\s+/g,
    chrome: 'Chrome 72',
    blocking: true,
    advice: '改为具名导出或 `import * as ns` 后再导出',
  },
];

/** `#private` 字段与静态块需要自定义匹配（保留捕获位置）。 */
const PRIVATE_FIELD_PATTERN = /(^|[^\w$])#([A-Za-z_$][\w$]*)/g;
const STATIC_BLOCK_PATTERN = /\bstatic\s*\{/g;

/**
 * 已知 Chrome 67 缺失 API 规则。
 *
 * `coveredBy` 指向 `COVERED_APIS` 中的键：产物里能找到对应补丁定义时，
 * 调用视为已兼容（只统计，不阻塞）。没有 `coveredBy` 的 API 永不被覆盖。
 */
const API_RULES = [
  {
    id: 'api/replace-children',
    label: 'Element/Document/DocumentFragment.replaceChildren',
    pattern: /\.replaceChildren\s*\(/g,
    chrome: 'Chrome 86',
    coveredBy: 'replaceChildren',
  },
  {
    id: 'api/replace-all',
    label: 'String.prototype.replaceAll',
    pattern: /\.replaceAll\s*\(/g,
    chrome: 'Chrome 85',
    coveredBy: 'replaceAll',
  },
  {
    id: 'api/object-from-entries',
    label: 'Object.fromEntries',
    pattern: /(?:Object|globalThis\.Object)\.fromEntries\s*\(/g,
    chrome: 'Chrome 73',
    coveredBy: 'fromEntries',
  },
  {
    id: 'api/queue-microtask',
    label: 'queueMicrotask',
    pattern: /(?:^|[^\w$.])queueMicrotask\s*\(/g,
    chrome: 'Chrome 71',
    coveredBy: 'queueMicrotask',
  },
  {
    id: 'api/array-flat-map',
    label: 'Array.prototype.flatMap',
    pattern: /\.flatMap\s*\(/g,
    chrome: 'Chrome 69',
    coveredBy: 'flatMap',
  },
  {
    id: 'api/promise-all-settled',
    label: 'Promise.allSettled',
    pattern: /(?:Promise|globalThis\.Promise)\.allSettled\s*\(/g,
    chrome: 'Chrome 76',
    coveredBy: 'allSettled',
  },
  {
    id: 'api/blob-array-buffer',
    label: 'Blob/File.prototype.arrayBuffer',
    pattern: /\.arrayBuffer\s*\(/g,
    chrome: 'Chrome 76',
    coveredBy: 'arrayBuffer',
    /** 只检查 Blob/File 风格的接收者；Response.arrayBuffer 自 Chrome 42 起可用。 */
    filter: (text, match) => !isResponseArrayBuffer(text, match.index),
  },
  {
    id: 'api/global-this',
    label: 'globalThis',
    pattern: /(?<![\w$.])globalThis\b/g,
    chrome: 'Chrome 71',
    coveredBy: 'globalThis',
  },
  {
    id: 'api/structured-clone',
    label: 'structuredClone',
    pattern: /\bstructuredClone\s*\(/g,
    chrome: 'Chrome 98',
  },
  {
    id: 'api/object-has-own',
    label: 'Object.hasOwn',
    pattern: /(?:Object|globalThis\.Object)\.hasOwn\s*\(/g,
    chrome: 'Chrome 93',
  },
  {
    id: 'api/promise-any',
    label: 'Promise.any',
    pattern: /(?:Promise|globalThis\.Promise)\.any\s*\(/g,
    chrome: 'Chrome 85',
  },
  {
    id: 'api/promise-with-resolvers',
    label: 'Promise.withResolvers',
    pattern: /(?:Promise|globalThis\.Promise)\.withResolvers\s*\(/g,
    chrome: 'Chrome 119',
  },
  {
    id: 'api/crypto-random-uuid',
    label: 'crypto.randomUUID',
    pattern: /\bcrypto\.randomUUID\s*\(/g,
    chrome: 'Chrome 92',
  },
  {
    id: 'api/weak-ref',
    label: 'WeakRef / FinalizationRegistry',
    pattern: /\bnew\s+(?:WeakRef|FinalizationRegistry)\s*\(/g,
    chrome: 'Chrome 84',
  },
  {
    id: 'api/abort-signal-static',
    label: 'AbortSignal.timeout / AbortSignal.any',
    pattern: /\bAbortSignal\.(?:timeout|any)\s*\(/g,
    chrome: 'Chrome 103/116',
  },
  {
    id: 'api/array-find-last',
    label: 'Array.prototype.findLast / findLastIndex',
    pattern: /\.findLast(?:Index)?\s*\(/g,
    chrome: 'Chrome 97',
  },
  {
    id: 'api/object-group-by',
    label: 'Object.groupBy / Map.groupBy',
    pattern: /(?:Object|Map)\.groupBy\s*\(/g,
    chrome: 'Chrome 117',
  },
  {
    id: 'api/array-change-by-copy',
    label: 'Array.prototype.toSorted/toReversed/toSpliced',
    pattern: /\.(?:toSorted|toReversed|toSpliced)\s*\(/g,
    chrome: 'Chrome 110',
  },
  {
    id: 'api/array-from-async',
    label: 'Array.fromAsync',
    pattern: /\bArray\.fromAsync\s*\(/g,
    chrome: 'Chrome 121',
  },
  {
    id: 'api/url-parse',
    label: 'URL.canParse / URL.parse',
    pattern: /\bURL\.(?:canParse|parse)\s*\(/g,
    chrome: 'Chrome 120/126',
  },
];

/**
 * 已被 compat 层覆盖的 API：用于在产物里寻找“补丁定义”证据。
 *
 * 证据形式覆盖 `Object.defineProperty(..., 'name', ...)`、`X.prototype.name =`
 * 以及 `if (!X.name) X.name = ...` 等常见写法。字符串/注释已被遮罩，
 * 所以这里的字符串匹配只可能来自代码中的属性名字面量。
 */
const COVERED_APIS = {
  replaceChildren: {
    label: 'Element/Document/DocumentFragment.replaceChildren',
    evidence: [
      { pattern: /\.prototype\.replaceChildren\s*=[^=]/ },
      {
        pattern: /["'`]replaceChildren["'`]/,
        context: /(?:defineProperty|prototype|patch|install|shim|polyfill)/i,
      },
    ],
  },
  replaceAll: {
    label: 'String.prototype.replaceAll',
    evidence: [
      { pattern: /\.prototype\.replaceAll\s*=[^=]/ },
      { pattern: /["'`]replaceAll["'`]/, context: /(?:defineProperty|prototype|patch|install|shim|polyfill)/i },
    ],
  },
  fromEntries: {
    label: 'Object.fromEntries',
    evidence: [
      { pattern: /Object\.fromEntries\s*=[^=]/ },
      { pattern: /["'`]fromEntries["'`]/, context: /(?:defineProperty|patch|install|shim|polyfill)/i },
    ],
  },
  queueMicrotask: {
    label: 'queueMicrotask',
    evidence: [
      { pattern: /(?:globalThis|window|self)\.queueMicrotask\s*=[^=]/ },
      {
        pattern: /["'`]queueMicrotask["'`]/,
        context: /(?:defineProperty|globalThis|window|self|patch|install|shim|polyfill)/i,
      },
    ],
  },
  flatMap: {
    label: 'Array.prototype.flatMap',
    evidence: [
      { pattern: /\.prototype\.flatMap\s*=[^=]/ },
      { pattern: /["'`]flatMap["'`]/, context: /(?:defineProperty|prototype|patch|install|shim|polyfill)/i },
    ],
  },
  allSettled: {
    label: 'Promise.allSettled',
    evidence: [
      { pattern: /Promise\.allSettled\s*=[^=]/ },
      { pattern: /["'`]allSettled["'`]/, context: /(?:defineProperty|patch|install|shim|polyfill)/i },
    ],
  },
  arrayBuffer: {
    label: 'Blob/File.prototype.arrayBuffer',
    evidence: [
      { pattern: /\.prototype\.arrayBuffer\s*=[^=]/ },
      { pattern: /["'`]arrayBuffer["'`]/, context: /(?:defineProperty|prototype|patch|install|shim|polyfill)/i },
    ],
  },
  globalThis: {
    label: 'globalThis',
    evidence: [
      { pattern: /(?:var|let|const)\s+globalThis\b/ },
      { pattern: /globalThis\s*=[^=]/ },
      { pattern: /["'`]globalThis["'`]/, context: /(?:defineProperty|prototype|patch|install|shim|polyfill)/i },
    ],
  },
};

/** 默认放行规则：compat 入口内部就是补丁实现，允许出现缺失 API 的调用。 */
const DEFAULT_ALLOWED_FILES = [
  {
    glob: '**/compat.js',
    rules: ['api/*'],
    reason: 'compat 入口自身实现缺失 API 的补丁',
  },
  {
    glob: '**/compat.cjs',
    rules: ['api/*'],
    reason: 'compat 入口自身实现缺失 API 的补丁',
  },
  {
    glob: '**/compat-*.js',
    rules: ['api/*'],
    reason: 'compat 分块自身实现缺失 API 的补丁',
  },
  {
    glob: '**/compat-*.cjs',
    rules: ['api/*'],
    reason: 'compat 分块自身实现缺失 API 的补丁',
  },
];

/** 需要扫描的产物目录（相对仓库根目录）。 */
const PRODUCTS = [
  {
    id: 'engine',
    title: '@ofdrw/ofdrw-viewer-engine',
    dir: 'packages/ofdrw-viewer-engine/dist',
    required: true,
  },
  {
    id: 'crypto',
    title: '@ofdrw/ofdrw-viewer-crypto',
    dir: 'packages/ofdrw-viewer-crypto/dist',
    required: true,
  },
  {
    id: 'ui',
    title: '@ofdrw/ofdrw-viewer-ui',
    dir: 'packages/ofdrw-viewer-ui/dist',
    required: true,
  },
  {
    id: 'demo',
    title: 'demo 演示站',
    dir: 'demo-dist/assets',
    required: false,
  },
];

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 不含 `node` 与脚本路径的参数数组。
 * @returns {object} 解析后的选项。
 */
function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    siteDir: null,
    scan: [],
    fixture: null,
    selfTest: false,
    requireDist: false,
    strictApi: false,
    strictBigint: false,
    showCovered: false,
    json: false,
    noSite: false,
    only: null,
    allow: [],
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`参数 ${name} 需要一个值`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case '--root':
        options.root = path.resolve(readValue(arg));
        break;
      case '--demo-dir':
        options.siteDir = path.resolve(readValue(arg));
        break;
      case '--scan':
        options.scan.push(path.resolve(readValue(arg)));
        break;
      case '--fixture':
        options.fixture = readValue(arg);
        break;
      case '--self-test':
        options.selfTest = true;
        break;
      case '--require-dist':
        options.requireDist = true;
        break;
      case '--strict-api':
        options.strictApi = true;
        break;
      case '--strict-bigint':
        options.strictBigint = true;
        break;
      case '--show-covered':
        options.showCovered = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--no-demo':
        options.noSite = true;
        break;
      case '--only':
        options.only = readValue(arg)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      case '--allow':
        options.allow.push(readValue(arg));
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}（使用 --help 查看用法）`);
    }
  }
  return options;
}

/**
 * 把路径统一为 POSIX 风格，便于跨平台匹配与输出。
 *
 * @param {string} value 文件路径。
 * @returns {string} POSIX 风格路径。
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * 把简化 glob 转为正则。
 *
 * 支持 `**`（跨目录）、`*`（单层）、`?`（单字符）；不支持字符组。
 *
 * @param {string} glob 简化 glob 表达式。
 * @returns {RegExp} 用于匹配 POSIX 相对路径的正则。
 */
function globToRegExp(glob) {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * 判断某条规则是否被文件白名单放行。
 *
 * @param {string} relPath 产物相对仓库根目录的 POSIX 路径。
 * @param {string} ruleId 规则 id，例如 `api/replace-children`。
 * @param {Array<{glob: string, rules: string[], reason?: string}>} entries 白名单条目。
 * @returns {{allowed: boolean, reason: string}} 是否放行与原因。
 */
function matchAllowEntry(relPath, ruleId, entries) {
  for (const entry of entries) {
    const glob = globToRegExp(entry.glob);
    if (!glob.test(relPath)) continue;
    const rules = entry.rules || [];
    if (rules.includes('*') || rules.includes(ruleId)) {
      return { allowed: true, reason: entry.reason || `白名单 ${entry.glob}` };
    }
    const family = ruleId.split('/')[0];
    if (rules.includes(`${family}/*`)) {
      return { allowed: true, reason: entry.reason || `白名单 ${entry.glob}` };
    }
  }
  return { allowed: false, reason: '' };
}

/**
 * 读取用户白名单配置。
 *
 * 文件不存在或格式错误时给出提示；格式错误按退出码 2 处理。
 *
 * @param {string} root 仓库根目录。
 * @returns {Array<{glob: string, rules: string[], reason?: string}>} 白名单条目。
 */
function loadWhitelist(root) {
  const file = path.join(root, WHITELIST_FILE);
  if (!existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析 ${WHITELIST_FILE}：${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = Array.isArray(parsed) ? parsed : parsed.files;
  if (!Array.isArray(entries)) {
    throw new Error(`${WHITELIST_FILE} 必须是数组，或包含 files 数组`);
  }
  return entries.map((entry, index) => {
    if (!entry || typeof entry.glob !== 'string') {
      throw new Error(`${WHITELIST_FILE} 第 ${index + 1} 项缺少 glob 字符串`);
    }
    const rules = Array.isArray(entry.rules) ? entry.rules : ['api/*'];
    return { glob: entry.glob, rules, reason: entry.reason };
  });
}

/**
 * 递归列出目录下的 JavaScript 产物。
 *
 * 跳过 sourcemap、类型声明、CSS 与压缩包内嵌文件。
 *
 * @param {string} dir 目录绝对路径。
 * @returns {string[]} JavaScript 文件绝对路径列表（已排序）。
 */
function listJsFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:js|cjs|mjs)$/.test(name)) continue;
      if (/\.d\.(?:ts|cts|mts)$/.test(name)) continue;
      files.push(full);
    }
  };
  walk(dir);
  return files;
}

/**
 * 计算字符串下标对应的行号、列号与整行文本。
 *
 * @param {string} text 原始文件内容。
 * @param {number} index 字符下标（从 0 开始）。
 * @returns {{line: number, column: number, snippet: string}} 行号/列号从 1 开始。
 */
function positionAt(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text[cursor] === '\n') {
      line += 1;
      lineStart = cursor + 1;
    }
  }
  let lineEnd = text.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = text.length;
  const snippet = text.slice(lineStart, lineEnd).trim();
  return {
    line,
    column: index - lineStart + 1,
    snippet: snippet.length > 200 ? `${snippet.slice(0, 197)}...` : snippet,
  };
}

/**
 * 判断 `/` 是否为正则字面量起始（而不是除号）。
 *
 * @param {string} masked 已遮罩的文本（注释/字符串为空格）。
 * @param {number} index `/` 的下标。
 * @returns {boolean} true 表示按正则字面量处理。
 */
function isRegexStart(masked, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(masked[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  const previous = masked[cursor];
  if ('([{,;:=!&|?+-*%^~<>'.includes(previous)) return true;
  const head = masked.slice(Math.max(0, cursor - 12), cursor + 1);
  return /(?:^|[^\w$])(?:return|case|typeof|instanceof|in|of|new|delete|void|throw|else|do|yield|await)$/.test(
    head,
  );
}

/**
 * 把字符串、模板文本、注释与正则字面量替换为空格，保留换行与代码结构。
 *
 * 这样后续正则只会命中真正的代码；模板字面量 `${...}` 内的表达式仍按代码处理。
 *
 * @param {string} text 原始文本。
 * @returns {string} 与原文等长的遮罩文本。
 */
function maskNonCode(text) {
  const output = text.split('');
  const mask = (index) => {
    if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
  };
  const contexts = [{ type: 'code', brace: 0, templateExpression: false }];
  const current = () => contexts[contexts.length - 1];
  let index = 0;
  while (index < text.length) {
    const context = current();
    const char = text[index];
    if (context.type === 'code') {
      if (char === '/' && text[index + 1] === '/') {
        mask(index);
        mask(index + 1);
        index += 2;
        while (index < text.length && text[index] !== '\n') {
          mask(index);
          index += 1;
        }
        continue;
      }
      if (char === '/' && text[index + 1] === '*') {
        mask(index);
        mask(index + 1);
        index += 2;
        while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
          mask(index);
          index += 1;
        }
        if (index < text.length) {
          mask(index);
          mask(index + 1);
          index += 2;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        const quote = char;
        mask(index);
        index += 1;
        while (index < text.length) {
          const inner = text[index];
          mask(index);
          if (inner === '\\') {
            index += 1;
            if (index < text.length) {
              mask(index);
              index += 1;
            }
            continue;
          }
          index += 1;
          if (inner === quote) break;
        }
        continue;
      }
      if (char === '`') {
        mask(index);
        index += 1;
        contexts.push({ type: 'template' });
        continue;
      }
      if (char === '/' && isRegexStart(output, index)) {
        mask(index);
        index += 1;
        let inClass = false;
        while (index < text.length) {
          const inner = text[index];
          mask(index);
          if (inner === '\\') {
            index += 1;
            if (index < text.length) {
              mask(index);
              index += 1;
            }
            continue;
          }
          if (inner === '\n') break;
          if (inner === '[') inClass = true;
          else if (inner === ']') inClass = false;
          else if (inner === '/' && !inClass) {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (char === '{') context.brace += 1;
      else if (char === '}') {
        if (context.brace === 0 && context.templateExpression) {
          mask(index);
          contexts.pop();
          index += 1;
          continue;
        }
        if (context.brace > 0) context.brace -= 1;
      }
      index += 1;
      continue;
    }
    // template 文本：保留 `${` 以便进入表达式，其余内容遮罩。
    if (char === '\\') {
      mask(index);
      index += 1;
      if (index < text.length) {
        mask(index);
        index += 1;
      }
      continue;
    }
    if (char === '`') {
      mask(index);
      index += 1;
      contexts.pop();
      continue;
    }
    if (char === '$' && text[index + 1] === '{') {
      mask(index);
      mask(index + 1);
      index += 2;
      contexts.push({ type: 'code', brace: 0, templateExpression: true });
      continue;
    }
    mask(index);
    index += 1;
  }
  return output.join('');
}

/**
 * 判断 `.arrayBuffer()` 的接收者是否为 Response（Chrome 42 起支持，无需兼容）。
 *
 * @param {string} text 遮罩后的代码文本。
 * @param {number} dotIndex `.arrayBuffer` 中 `.` 的下标。
 * @returns {boolean} true 表示应按 Response 放行。
 */
function isResponseArrayBuffer(text, dotIndex) {
  let cursor = dotIndex - 1;
  while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
  let receiver = '';
  if (text[cursor] === ')') {
    let depth = 0;
    let scan = cursor;
    while (scan >= 0) {
      if (text[scan] === ')') depth += 1;
      else if (text[scan] === '(') {
        depth -= 1;
        if (depth === 0) break;
      }
      scan -= 1;
    }
    let end = scan - 1;
    while (end >= 0 && /\s/.test(text[end])) end -= 1;
    let start = end;
    while (start >= 0 && /[\w$.[\]]/.test(text[start])) start -= 1;
    receiver = text.slice(start + 1, end + 1);
  } else {
    let start = cursor;
    while (start >= 0 && /[\w$.[\]]/.test(text[start])) start -= 1;
    receiver = text.slice(start + 1, cursor + 1);
  }
  return /(?:^|[.])(?:response|res|resp|rawResponse|fetchResponse|reader)$/i.test(receiver);
}

/**
 * 在遮罩文本中执行一条正则规则，并对每个命中生成发现项。
 *
 * @param {string} relPath 产物相对路径。
 * @param {string} original 原始文件内容（用于取行文本）。
 * @param {string} masked 遮罩后的代码。
 * @param {object} rule 规则定义。
 * @param {object} options 扫描选项。
 * @param {object} context 覆盖率与白名单上下文。
 * @returns {object[]} 发现项列表。
 */
function collectRuleFindings(relPath, original, masked, rule, options, context) {
  const findings = [];
  rule.pattern.lastIndex = 0;
  let match = rule.pattern.exec(masked);
  while (match !== null) {
    const index = match.index;
    if (rule.filter && !rule.filter(masked, match)) {
      match = rule.pattern.exec(masked);
      continue;
    }
    const position = positionAt(original, index);
    const allow = matchAllowEntry(relPath, rule.id, context.allowedFiles);
    let covered = false;
    let coveredReason = '';
    if (rule.coveredBy && context.coverage[rule.coveredBy]) {
      covered = true;
      coveredReason = '产物内存在对应 compat 补丁定义';
    }
    if (allow.allowed) {
      covered = true;
      coveredReason = allow.reason;
    }
    if (covered && options.strictApi && !allow.allowed) {
      covered = false;
      coveredReason = '';
    }
    const blocking = rule.blocking !== false && !covered;
    findings.push({
      file: relPath,
      line: position.line,
      column: position.column,
      rule: rule.id,
      kind: rule.id.startsWith('syntax/') ? 'syntax' : 'api',
      label: rule.label,
      chrome: rule.chrome,
      advice: rule.advice,
      snippet: position.snippet,
      blocking,
      covered,
      coveredReason,
    });
    match = rule.pattern.exec(masked);
  }
  return findings;
}

/**
 * 扫描单个文本内容。
 *
 * @param {string} relPath 产物相对路径（POSIX）。
 * @param {string} text 文件内容。
 * @param {object} options 扫描选项。
 * @param {object} context `{coverage, allowedFiles}`。
 * @returns {object[]} 发现项列表。
 */
function scanText(relPath, text, options, context) {
  const masked = maskNonCode(text);
  const findings = [];
  for (const rule of SYNTAX_RULES) {
    if (rule.id === 'syntax/bigint-literal' && options.strictBigint) {
      rule.blocking = true;
    } else if (rule.id === 'syntax/bigint-literal') {
      rule.blocking = false;
    }
    findings.push(...collectRuleFindings(relPath, text, masked, rule, options, context));
  }
  // 私有字段：保留 `#` 的精确位置。
  PRIVATE_FIELD_PATTERN.lastIndex = 0;
  let privateMatch = PRIVATE_FIELD_PATTERN.exec(masked);
  while (privateMatch !== null) {
    const hashIndex = privateMatch.index + privateMatch[1].length;
    const position = positionAt(text, hashIndex);
    const allow = matchAllowEntry(relPath, 'syntax/private-field', context.allowedFiles);
    findings.push({
      file: relPath,
      line: position.line,
      column: position.column,
      rule: 'syntax/private-field',
      kind: 'syntax',
      label: '私有字段 #x',
      chrome: 'Chrome 84',
      advice: '把构建目标改为 chrome67，或改用 WeakMap/闭包',
      snippet: position.snippet,
      blocking: !allow.allowed,
      covered: allow.allowed,
      coveredReason: allow.reason,
    });
    privateMatch = PRIVATE_FIELD_PATTERN.exec(masked);
  }
  // 静态初始化块。
  STATIC_BLOCK_PATTERN.lastIndex = 0;
  let staticMatch = STATIC_BLOCK_PATTERN.exec(masked);
  while (staticMatch !== null) {
    const position = positionAt(text, staticMatch.index);
    const allow = matchAllowEntry(relPath, 'syntax/static-block', context.allowedFiles);
    findings.push({
      file: relPath,
      line: position.line,
      column: position.column,
      rule: 'syntax/static-block',
      kind: 'syntax',
      label: '类静态初始化块 static {}',
      chrome: 'Chrome 94',
      advice: '把构建目标改为 chrome67，或移到类外初始化',
      snippet: position.snippet,
      blocking: !allow.allowed,
      covered: allow.allowed,
      coveredReason: allow.reason,
    });
    staticMatch = STATIC_BLOCK_PATTERN.exec(masked);
  }
  for (const rule of API_RULES) {
    findings.push(...collectRuleFindings(relPath, text, masked, rule, options, context));
  }
  return findings;
}

/**
 * 在产物语料中查找每个已知缺失 API 的 compat 补丁证据。
 *
 * @param {Array<{text: string}>} files 产物文件内容列表。
 * @returns {Record<string, boolean>} API 键到“是否已有补丁”的映射。
 */
function detectCoverage(files) {
  const coverage = {};
  for (const [api, definition] of Object.entries(COVERED_APIS)) {
    coverage[api] = files.some((file) =>
      definition.evidence.some(
        (entry) => entry.pattern.test(file.text) && (!entry.context || entry.context.test(file.text)),
      ),
    );
  }
  return coverage;
}

/**
 * 扫描一组内存中的文件（供 self-test 与真实产物共用）。
 *
 * @param {Array<{relPath: string, text: string}>} files 文件列表。
 * @param {object} options 扫描选项。
 * @returns {{findings: object[], coverage: Record<string, boolean>}} 扫描结果。
 */
function analyzeCorpus(files, options) {
  const allowedFiles = [...DEFAULT_ALLOWED_FILES];
  for (const glob of options.allow || []) {
    allowedFiles.push({ glob, rules: ['api/*'], reason: `命令行 --allow ${glob}` });
  }
  for (const entry of options.whitelist || []) allowedFiles.push(entry);
  const coverage = detectCoverage(files);
  const findings = [];
  for (const file of files) {
    findings.push(...scanText(file.relPath, file.text, options, { coverage, allowedFiles }));
  }
  findings.sort((left, right) => {
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    if (left.line !== right.line) return left.line - right.line;
    return left.column - right.column;
  });
  return { findings, coverage };
}

/**
 * 发现需要扫描的产品及其文件。
 *
 * @param {object} options 命令行选项。
 * @returns {{products: object[], missing: string[]}} 产品列表与缺失目录。
 */
function discoverProducts(options) {
  const products = [];
  const missing = [];
  if (options.scan && options.scan.length > 0) {
    for (const target of options.scan) {
      if (!existsSync(target)) {
        missing.push(target);
        continue;
      }
      const statistics = statSync(target);
      const files = statistics.isDirectory() ? listJsFiles(target) : [target];
      if (files.length === 0) {
        missing.push(target);
        continue;
      }
      products.push({
        id: 'scan',
        title: target,
        dir: statistics.isDirectory() ? target : path.dirname(target),
        files,
      });
    }
    return { products, missing };
  }
  const only = options.only ? new Set(options.only) : null;
  for (const product of PRODUCTS) {
    if (only && !only.has(product.id)) continue;
    if (product.id === 'demo') {
      if (options.noSite) continue;
      const siteDir = options.siteDir || path.join(options.root, product.dir);
      const fileList = listJsFiles(siteDir);
      if (fileList.length === 0) {
        missing.push(toPosix(path.relative(options.root, siteDir)) || siteDir);
        continue;
      }
      products.push({ ...product, dir: siteDir, files: fileList });
      continue;
    }
    const dir = path.join(options.root, product.dir);
    const fileList = listJsFiles(dir);
    if (fileList.length === 0) {
      missing.push(product.dir);
      continue;
    }
    products.push({ ...product, dir, files: fileList });
  }
  return { products, missing };
}

/**
 * 输出一条发现项。
 *
 * @param {object} finding 发现项。
 * @param {object} options 命令行选项。
 */
function printFinding(finding, options) {
  if (!finding.blocking && !options.showCovered) return;
  const marker = finding.blocking ? '✗' : '·';
  const suffix = finding.covered ? `（已覆盖：${finding.coveredReason}）` : '';
  process.stdout.write(
    `[compat] ${marker} ${finding.file}:${finding.line}:${finding.column}  ${finding.rule}  ${finding.label}${suffix}\n`,
  );
  if (finding.blocking) {
    process.stdout.write(`          ${finding.snippet}\n`);
    if (finding.advice) process.stdout.write(`          建议：${finding.advice}\n`);
  }
}

/**
 * 运行内置 self-test：违规样例必须报错，合规样例必须放行。
 *
 * @returns {number} 退出码（0 通过，1 失败）。
 */
function runSelfTest() {
  const cases = [];
  const baseOptions = {
    strictApi: false,
    strictBigint: false,
    showCovered: false,
    allow: [],
    whitelist: [],
  };
  const scan = (files, options = {}) =>
    analyzeCorpus(
      files.map((file) => ({ relPath: file.relPath, text: file.text })),
      { ...baseOptions, ...options },
    );

  // 1. 现代语法违规样例。
  const syntaxBad = scan([
    {
      relPath: 'samples/bad-syntax.js',
      text: [
        'const a = obj?.x;',
        'const b = value ?? fallback;',
        'let c = 0; c ||= 1;',
        'class Example { #secret = 1; static { init(); } }',
        'const big = 123n;',
        'const separated = 1_000_000;',
        'export * as ns from "./mod.js";',
      ].join('\n'),
    },
  ]);
  const syntaxRules = new Set(syntaxBad.findings.filter((item) => item.blocking).map((item) => item.rule));
  for (const expected of [
    'syntax/optional-chaining',
    'syntax/nullish-coalescing',
    'syntax/logical-assignment',
    'syntax/private-field',
    'syntax/static-block',
    'syntax/numeric-separator',
    'syntax/export-star-as',
  ]) {
    cases.push({
      name: `违规语法被检出：${expected}`,
      pass: syntaxRules.has(expected),
    });
  }
  cases.push({
    name: 'BigInt 字面量默认只统计、不阻塞（Chrome 67 原生支持）',
    pass:
      syntaxBad.findings.some((item) => item.rule === 'syntax/bigint-literal') &&
      syntaxBad.findings.filter((item) => item.rule === 'syntax/bigint-literal').every((item) => !item.blocking),
  });
  const strictBigint = scan(
    [{ relPath: 'samples/bigint.js', text: 'const big = 123n;' }],
    { strictBigint: true },
  );
  cases.push({
    name: '--strict-bigint 可把 BigInt 视为阻塞',
    pass: strictBigint.findings.some((item) => item.rule === 'syntax/bigint-literal' && item.blocking),
  });

  // 2. 字符串/注释/模板/正则中的伪语法必须被遮罩。
  const clean = scan([
    {
      relPath: 'samples/clean.js',
      text: [
        'const text = "a?.b ?? 0n #x static {";',
        "const comment = 1; // ?. ?? 0n #x",
        'const template = `value ${text} ??`;',
        'const regex = /a\\?\\?b/;',
        'const number = value == null ? .353 : value;',
        'await response.arrayBuffer();',
      ].join('\n'),
    },
  ]);
  cases.push({
    name: '字符串/注释/模板/正则中的伪语法不误报',
    pass: clean.findings.filter((item) => item.blocking).length === 0,
  });
  cases.push({
    name: 'Response.arrayBuffer 不按 Blob 缺失 API 误报',
    pass: clean.findings.filter((item) => item.rule === 'api/blob-array-buffer' && item.blocking).length === 0,
  });

  // 3. 未安装 compat 时，缺失 API 调用必须失败。
  const apiBad = scan([
    {
      relPath: 'samples/bad-api.js',
      text: [
        'element.replaceChildren(child);',
        'text.replaceAll("a", "b");',
        'Object.fromEntries(entries);',
        'queueMicrotask(task);',
        'items.flatMap(fn);',
        'Promise.allSettled(tasks);',
        'const bytes = await file.arrayBuffer();',
      ].join('\n'),
    },
  ]);
  const badApiRules = new Set(apiBad.findings.filter((item) => item.blocking).map((item) => item.rule));
  for (const expected of [
    'api/replace-children',
    'api/replace-all',
    'api/object-from-entries',
    'api/queue-microtask',
    'api/array-flat-map',
    'api/promise-all-settled',
    'api/blob-array-buffer',
  ]) {
    cases.push({ name: `缺失 API 被检出：${expected}`, pass: badApiRules.has(expected) });
  }

  // 4. 产物内存在 compat 补丁时，同类调用放行。
  const shimText = [
    'if (!Element.prototype.replaceChildren) Element.prototype.replaceChildren = function () {};',
    'if (!String.prototype.replaceAll) String.prototype.replaceAll = function () {};',
    'if (!Object.fromEntries) Object.fromEntries = function () {};',
    'if (typeof queueMicrotask !== "function") globalThis.queueMicrotask = function (fn) { fn(); };',
    'if (!Array.prototype.flatMap) Array.prototype.flatMap = function () {};',
    'if (!Promise.allSettled) Promise.allSettled = function () {};',
    'if (!Blob.prototype.arrayBuffer) Blob.prototype.arrayBuffer = function () {};',
    'if (typeof globalThis === "undefined") { globalThis = {}; }',
  ].join('\n');
  const apiCovered = scan([
    { relPath: 'samples/chunk-ok.js', text: shimText },
    {
      relPath: 'samples/app-ok.js',
      text: [
        'element.replaceChildren(child);',
        'text.replaceAll("a", "b");',
        'Object.fromEntries(entries);',
        'queueMicrotask(task);',
        'items.flatMap(fn);',
        'Promise.allSettled(tasks);',
        'const bytes = await file.arrayBuffer();',
      ].join('\n'),
    },
  ]);
  cases.push({
    name: '存在 compat 补丁时，缺失 API 调用放行',
    pass: apiCovered.findings.filter((item) => item.blocking).length === 0,
  });
  cases.push({
    name: '放行项仍被统计为已覆盖',
    pass: apiCovered.findings.filter((item) => item.covered && item.blocking === false).length >= 7,
  });

  // 5. compat 入口文件白名单：补丁实现内部的调用放行。
  const whitelisted = scan([
    {
      relPath: 'packages/demo/dist/compat.js',
      text: 'function shim() { element.replaceChildren(child); }',
    },
  ]);
  cases.push({
    name: 'compat*.js 白名单放行补丁实现内部调用',
    pass: whitelisted.findings.filter((item) => item.blocking).length === 0,
  });

  // 6. 未覆盖的新 API 即使有 compat 补丁也应阻塞。
  const forbidden = scan([
    {
      relPath: 'samples/bad-new-api.js',
      text: 'const clone = structuredClone(value); const uuid = crypto.randomUUID();',
    },
  ]);
  cases.push({
    name: '未覆盖的新 API（structuredClone / randomUUID）阻塞',
    pass: forbidden.findings.filter((item) => item.blocking).length >= 2,
  });

  // 7. 压缩产物用反引号包 API 名时，覆盖判定仍然有效。
  const minifiedEvidence = scan([
    {
      relPath: 'samples/minified.js',
      text: 'function y(e,t,n){return Object.defineProperty(e,t,{value:n})}y(self,`queueMicrotask`,function(e){e()});queueMicrotask(task);',
    },
  ]);
  cases.push({
    name: '压缩产物反引号 API 名可作为 compat 覆盖证据',
    pass: minifiedEvidence.findings.filter((item) => item.blocking).length === 0,
  });

  // 8. 合规产物样例。
  const compliant = scan([
    {
      relPath: 'packages/demo/dist/index.js',
      text: [
        'import "./compat.js";',
        'const value = object && object.property;',
        'const fallback = value == null ? 1 : value;',
        'const bytes = await blob.arrayBuffer();',
      ].join('\n'),
    },
    { relPath: 'packages/demo/dist/compat.js', text: shimText },
  ]);
  cases.push({
    name: '合规产物样例（有 compat）返回 0',
    pass: compliant.findings.filter((item) => item.blocking).length === 0,
  });

  let failures = 0;
  for (const testCase of cases) {
    const mark = testCase.pass ? '✓' : '✗';
    process.stdout.write(`[self-test] ${mark} ${testCase.name}\n`);
    if (!testCase.pass) failures += 1;
  }
  process.stdout.write(
    `[self-test] ${cases.length - failures}/${cases.length} 通过${failures ? `，${failures} 项失败` : ''}\n`,
  );
  return failures === 0 ? 0 : 1;
}

/**
 * 运行内置违规/合规样例，按真实扫描规则输出并返回对应退出码。
 *
 * `bad` 样例包含 Chrome 67 不支持的语法与未被 compat 覆盖的 API，
 * 预期退出 1；`good` 样例包含 compat 补丁定义，预期退出 0。
 *
 * @param {string} mode `bad` 或 `good`。
 * @returns {number} 退出码。
 */
function runFixture(mode) {
  if (mode !== 'bad' && mode !== 'good') {
    process.stderr.write(`[compat] --fixture 只接受 bad 或 good，收到：${mode}\n`);
    return 2;
  }
  const fixtures =
    mode === 'bad'
      ? [
          {
            relPath: 'fixtures/bad/sample.js',
            text: [
              'const value = obj?.field;',
              'const fallback = value ?? 1;',
              'class Demo { #secret = 1; static { init(); } }',
              'const big = 123n;',
              'element.replaceChildren(child);',
              'Object.fromEntries(entries);',
              'await file.arrayBuffer();',
            ].join('\n'),
          },
        ]
      : [
          {
            relPath: 'fixtures/good/compat.js',
            text: [
              'if (!Element.prototype.replaceChildren) Element.prototype.replaceChildren = function () {};',
              'if (!Object.fromEntries) Object.fromEntries = function () {};',
              'if (!Blob.prototype.arrayBuffer) Blob.prototype.arrayBuffer = function () {};',
            ].join('\n'),
          },
          {
            relPath: 'fixtures/good/index.js',
            text: [
              'const value = object && object.field;',
              'const fallback = value == null ? 1 : value;',
              'element.replaceChildren(child);',
              'Object.fromEntries(entries);',
              'await file.arrayBuffer();',
            ].join('\n'),
          },
        ];
  const options = {
    strictApi: false,
    strictBigint: false,
    showCovered: false,
    allow: [],
    whitelist: [],
  };
  const { findings } = analyzeCorpus(fixtures, options);
  const blocking = findings.filter((item) => item.blocking);
  process.stdout.write(`[fixture] 内置${mode === 'bad' ? '违规' : '合规'}样例扫描\n`);
  for (const finding of findings) printFinding(finding, options);
  process.stdout.write(
    `[fixture] 阻塞违规 ${blocking.length} 处，预期退出码 ${mode === 'bad' ? 1 : 0}：${blocking.length > 0 ? '失败' : '通过'}\n`,
  );
  if (mode === 'bad') return blocking.length > 0 ? 1 : 2;
  return blocking.length === 0 ? 0 : 1;
}

/**
 * 主流程。
 *
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）。
 * @returns {number} 退出码。
 */
function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[compat] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (options.selfTest) return runSelfTest();
  if (options.fixture) return runFixture(options.fixture);
  if (options.only) {
    const unknown = options.only.filter((id) => !PRODUCTS.some((product) => product.id === id));
    if (unknown.length > 0) {
      process.stderr.write(`[compat] 未知产物集合：${unknown.join('、')}（可选：${PRODUCTS.map((product) => product.id).join(',')}）\n`);
      return 2;
    }
  }

  let whitelist;
  try {
    whitelist = loadWhitelist(options.root);
  } catch (error) {
    process.stderr.write(`[compat] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const { products, missing } = discoverProducts(options);
  if (options.scan && options.scan.length > 0 && missing.length > 0) {
    process.stderr.write(`[compat] 指定的扫描路径不存在或不含 JS 文件：${missing.join('、')}\n`);
    return 2;
  }
  if (products.length === 0) {
    process.stdout.write('[compat] 未找到任何构建产物。\n');
    if (missing.length > 0) {
      process.stdout.write(`[compat] 缺少目录：${missing.join('、')}\n`);
    }
    process.stdout.write('[compat] 请先运行 `pnpm build`（站点：`pnpm -C demo build`）后重试。\n');
    if (options.requireDist) {
      process.stderr.write('[compat] --require-dist 要求产物存在，按失败处理。\n');
      return 2;
    }
    process.stdout.write('[compat] 已跳过产物扫描（退出 0，避免误报）。\n');
    return 0;
  }
  if (missing.length > 0) {
    const message = `[compat] 提示：以下产物目录不存在或为空，已跳过：${missing.join('、')}\n`;
    if (options.requireDist) {
      process.stderr.write(message);
      process.stderr.write('[compat] --require-dist 要求全部产物存在，按失败处理。\n');
      return 2;
    }
    process.stdout.write(message);
  }

  const files = [];
  const findings = [];
  const coverage = {};
  for (const product of products) {
    const productFiles = [];
    for (const file of product.files) {
      const entry = {
        relPath: toPosix(path.relative(options.root, file)),
        text: readFileSync(file, 'utf8'),
      };
      files.push(entry);
      productFiles.push(entry);
    }
    // 每个产物集合独立判定 compat 覆盖，避免某个包的补丁“放行”另一个包的调用。
    const result = analyzeCorpus(productFiles, { ...options, whitelist });
    findings.push(...result.findings);
    coverage[product.id] = result.coverage;
  }
  const blocking = findings.filter((item) => item.blocking);
  const covered = findings.filter((item) => !item.blocking && item.covered);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          products: products.map((product) => ({
            id: product.id,
            dir: toPosix(path.relative(options.root, product.dir)),
            files: product.files.length,
          })),
          files: files.length,
          coverage,
          blocking: blocking.length,
          covered: covered.length,
          findings,
        },
        null,
        2,
      )}\n`,
    );
    return blocking.length === 0 ? 0 : 1;
  }

  process.stdout.write(
    `[compat] 扫描 ${products.length} 个产物集合、${files.length} 个 JS 文件（目标：Chrome 67）\n`,
  );
  for (const finding of findings) printFinding(finding, options);

  const coveredByApi = {};
  for (const finding of covered) {
    coveredByApi[finding.rule] = (coveredByApi[finding.rule] || 0) + 1;
  }
  if (covered.length > 0) {
    const summary = Object.entries(coveredByApi)
      .map(([rule, count]) => `${rule}×${count}`)
      .join('、');
    process.stdout.write(`[compat] 已被 compat 覆盖/白名单放行 ${covered.length} 处：${summary}\n`);
  }
  const bigints = findings.filter((item) => item.rule === 'syntax/bigint-literal');
  if (bigints.length > 0) {
    process.stdout.write(
      `[compat] BigInt 字面量 ${bigints.length} 处：Chrome 67 原生支持，按兼容文档保留（不阻塞）。\n`,
    );
  }
  if (blocking.length > 0) {
    const syntaxCount = blocking.filter((item) => item.kind === 'syntax').length;
    const apiCount = blocking.length - syntaxCount;
    process.stderr.write(
      `[compat] 失败：${blocking.length} 处阻塞违规（语法 ${syntaxCount}、API ${apiCount}）。\n`,
    );
    process.stderr.write('[compat] 修复后重新构建再运行：pnpm build && node scripts/check-compat.mjs\n');
    return 1;
  }
  process.stdout.write('[compat] 通过：未发现 Chrome 67 不兼容的产物语法或未覆盖 API。\n');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}

export { analyzeCorpus, main, maskNonCode, parseArgs, scanText, runSelfTest };