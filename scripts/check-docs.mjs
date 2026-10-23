#!/usr/bin/env node
/**
 * 文档同步门禁：检查密码能力相关文档的必备内容、链接和过期表述。
 *
 * 仅使用 Node.js 内置模块；退出码 0 表示通过，1 表示存在文档问题。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 需要纳入检查的文档；顺序与文档同步清单一致。 */
const DOC_FILES = [
  'README.md',
  'packages/ofdrw-viewer-engine/README.md',
  'packages/ofdrw-viewer-engine/skills/SKILL.md',
  'packages/ofdrw-viewer-engine/skills/公开API.md',
  'packages/ofdrw-viewer-ui/README.md',
  'packages/ofdrw-viewer-cli/README.md',
  'packages/ofdrw-viewer-cli/skills/SKILL.md',
  'packages/ofdrw-viewer-crypto/README.md',
  'packages/ofdrw-viewer-crypto/skills/SKILL.md',
  'packages/ofdrw-viewer-crypto/skills/公开API.md',
  'docs/ofdrw-viewer-crypto设计方案.md',
  'docs/CONTRACTS.md',
  'docs/OFD渲染引擎设计方案.md',
  'docs/ofdrw-viewer-ui-engine-api.md',
  'docs/ofdrw-viewer-ui设计方案.md',
  'docs/CLI设计方案.md',
  'docs/测试方案.md',
  'docs/验收计划.md',
  'docs/密码学PoC验证报告.md',
];

/** 必备内容：每个文件至少包含一个匹配项。 */
const REQUIRED_TERMS = new Map([
  ['README.md', ['ofdrw-viewer-crypto', 'OFD 密码能力包', '加密文档', '签名验证']],
  [
    'packages/ofdrw-viewer-engine/README.md',
    ['OFDOpenOptions.source', 'OFDOpenFromContainerOptions', 'openZipVirtualContainer', 'VirtualContainer', 'OFD_ENCRYPTED', 'containerFactory'],
  ],
  [
    'packages/ofdrw-viewer-engine/skills/SKILL.md',
    ['OFDOpenFromContainerOptions', 'openZipVirtualContainer', 'OFD_ENCRYPTED', 'VirtualContainer'],
  ],
  [
    'packages/ofdrw-viewer-engine/skills/公开API.md',
    ['openZipVirtualContainer', 'OFDOpenFromContainerOptions', 'encrypted=true', 'AbortSignal'],
  ],
  [
    'packages/ofdrw-viewer-ui/README.md',
    ['crypto', 'verification', 'setRootCertificates', 'parsed-not-verified', 'incomplete', 'integrity', 'ASN.1'],
  ],
  [
    'packages/ofdrw-viewer-cli/README.md',
    ['info', 'verify', '--root', 'parsed-not-verified', 'decrypt'],
  ],
  [
    'packages/ofdrw-viewer-crypto/README.md',
    ['inspect', 'openDecryptingContainer', 'verifyOfd', 'parseSeal', 'parsed-not-verified', 'integrity'],
  ],
  [
    'docs/ofdrw-viewer-crypto设计方案.md',
    ['OFDOpenFromContainerOptions', 'openZipVirtualContainer', 'integrity === null', 'W_CRYPTO_SEAL_PICTURE_INVALID', 'ParsedSeal', 'subjectDer', 'issuerDer', 'incomplete', 'unknown'],
  ],
  [
    'docs/CONTRACTS.md',
    ['OFDOpenFromContainerOptions', 'openZipVirtualContainer', 'W_CRYPTO_SEAL_PICTURE_INVALID', 'subjectDer', 'issuerDer', 'integrity=null', 'incomplete', 'unknown'],
  ],
  [
    'docs/OFD渲染引擎设计方案.md',
    ['VirtualContainer', 'openZipVirtualContainer', 'OFDOpenFromContainerOptions', 'OFD_ENCRYPTED', 'AbortSignal'],
  ],
  [
    'docs/ofdrw-viewer-ui-engine-api.md',
    ['VirtualContainer', 'openZipVirtualContainer', 'ofdrw-viewer-crypto', 'OFD_ENCRYPTED'],
  ],
  [
    'docs/ofdrw-viewer-ui设计方案.md',
    ['verification', 'parsed-not-verified', 'setRootCertificates', 'W_CRYPTO_SEAL_PICTURE_INVALID', 'incomplete', 'unknown'],
  ],
  [
    'docs/测试方案.md',
    ['parsed-not-verified', 'integrity', 'incomplete', 'info', 'verify'],
  ],
  [
    'docs/验收计划.md',
    ['parsed-not-verified', 'integrity', 'incomplete', 'info', 'verify'],
  ],
]);

/** 过期/矛盾表述；按文件作用域检查。 */
const FORBIDDEN = [
  {
    files: ['packages/ofdrw-viewer-ui/README.md', 'docs/ofdrw-viewer-ui设计方案.md'],
    pattern: /签章信息（不验签）|UI 侧用 ASN\.1 库解析|不做电子签章验签|不读取 `Seal\.esl`|时间戳已验证/,
    message: 'UI 文档仍保留 v1 的“不验签/不解析印章/时间戳已验证”过期边界',
  },
  {
    files: ['docs/OFD渲染引擎设计方案.md'],
    pattern: /ASN\.1 是 UI 包的依赖/,
    message: '引擎设计仍把 ASN.1 归为 UI 包依赖',
  },
  {
    files: DOC_FILES,
    pattern: /\bTBD\b/,
    message: '文档不得保留 TBD 未决项',
  },
  {
    files: ['docs/测试方案.md', 'docs/验收计划.md'],
    pattern: /错根\s*`?incomplete`?|错误根\s*=\s*`?incomplete`?/,
    message: '根证书状态口径错误：错误根应为 untrusted，配根缺中间才是 incomplete',
  },
];

const errors = [];

for (const file of DOC_FILES) {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) {
    errors.push(`${file}: 文件不存在`);
    continue;
  }
  const text = readFileSync(absolute, 'utf8');

  const fences = (text.match(/^```/gm) ?? []).length;
  if (fences % 2 !== 0) errors.push(`${file}: 代码围栏数量为奇数（${fences}）`);

  for (const term of REQUIRED_TERMS.get(file) ?? []) {
    if (!text.includes(term)) errors.push(`${file}: 缺少必备内容「${term}」`);
  }

  for (const rule of FORBIDDEN) {
    if (rule.files.includes(file) && rule.pattern.test(text)) {
      errors.push(`${file}: ${rule.message}`);
    }
  }

  for (const target of collectRelativeLinks(text)) {
    const targetPath = resolve(dirname(absolute), target);
    if (!existsSync(targetPath)) {
      errors.push(`${file}: 链接目标不存在「${target}」`);
    }
  }
}

if (errors.length > 0) {
  console.error(`文档同步检查失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`文档同步检查通过：${DOC_FILES.length} 个文件，链接/必备内容/过期表述均通过。`);

/**
 * 从 Markdown 正文提取相对链接。
 *
 * @param {string} text Markdown 文本。
 * @returns {string[]} 去掉锚点/查询串后的相对路径。
 */
function collectRelativeLinks(text) {
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of text.matchAll(pattern)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    // 只检查文档/资源文件；目录链接在本仓库不作为入口。
    if (extname(target) === '' && !target.endsWith('/')) continue;
    links.push(decodeURIComponent(target));
  }
  return links;
}
