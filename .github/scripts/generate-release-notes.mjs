#!/usr/bin/env node
/**
 * 根据提交历史生成 GitHub Release 正文。
 *
 * 发布说明托管在 GitHub Release 页面，不在仓库内维护；发布时由本脚本生成初始正文，
 * 之后可以直接在 Release 页面继续编辑。
 *
 * 用法：
 *   node .github/scripts/generate-release-notes.mjs <tag> <version> [output]
 *
 * 参数：
 *   tag     - 发布标签，如 `v0.1.0`
 *   version - 不带 `v` 的版本号，如 `0.1.0`
 *   output  - 输出文件路径，默认 `release-notes.md`
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（脚本位于 `.github/scripts/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 发布包清单：包名与相对仓库根目录的路径。 */
const PACKAGES = [
  { name: '@ofdrw/ofdrw-viewer-engine', dir: 'packages/ofdrw-viewer-engine' },
  { name: '@ofdrw/ofdrw-viewer-crypto', dir: 'packages/ofdrw-viewer-crypto' },
  { name: '@ofdrw/ofdrw-viewer-ui', dir: 'packages/ofdrw-viewer-ui' },
  { name: '@ofdrw/ofdrw-viewer-cli', dir: 'packages/ofdrw-viewer-cli' },
];

/** commit 类型到中文小节的映射，按输出顺序排列。 */
const SECTIONS = [
  { type: 'feat', title: '新功能' },
  { type: 'fix', title: '问题修复' },
  { type: 'perf', title: '性能优化' },
  { type: 'refactor', title: '重构' },
  { type: 'docs', title: '文档' },
  { type: 'test', title: '测试' },
  { type: 'build', title: '构建' },
  { type: 'ci', title: '持续集成' },
  { type: 'revert', title: '回滚' },
  { type: 'chore', title: '其他改动' },
  { type: 'other', title: '未分类' },
];

/** 未匹配 Conventional Commits 的提交归入 other。 */
const CONVENTIONAL_PATTERN = /^([a-zA-Z]+)(?:\([^)]*\))?!?:\s*(.+)$/;

/** CLI 发布平台：target 与压缩包后缀。 */
const CLI_TARGETS = [
  { target: 'linux-x64-gnu', suffix: 'tar.gz' },
  { target: 'linux-arm64-gnu', suffix: 'tar.gz' },
  { target: 'darwin-x64', suffix: 'tar.gz' },
  { target: 'darwin-arm64', suffix: 'tar.gz' },
  { target: 'win32-x64', suffix: 'zip' },
];

/**
 * 执行 git 命令并返回标准输出。
 *
 * @param {string[]} args git 参数
 * @returns {string | null} 去除首尾空白后的输出；命令失败时返回 null
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 读取包元数据。
 *
 * @param {string} packageDir 包目录（相对仓库根）
 * @returns {Promise<{ name: string, version: string, description: string }>} 包元数据
 */
async function readPackage(packageDir) {
  const raw = await readFile(join(REPO_ROOT, packageDir, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);
  return {
    name: pkg.name,
    version: pkg.version,
    description: typeof pkg.description === 'string' ? pkg.description : '',
  };
}

/**
 * 解析当前仓库的 `owner/repo`。
 *
 * @returns {string | null} GitHub 仓库标识；无法解析时返回 null
 */
function resolveRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  const remote = git(['remote', 'get-url', 'origin']);
  if (!remote) return null;
  const matched = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return matched ? matched[1] : null;
}

/**
 * 查找当前标签之前最近的一个标签。
 *
 * @param {string} tag 当前发布标签
 * @returns {string | null} 上一个标签；当前是首个标签时返回 null
 */
function findPreviousTag(tag) {
  return git(['describe', '--tags', '--abbrev=0', `${tag}^`]);
}

/**
 * 列出两个引用之间的提交。
 *
 * @param {string} tag 当前发布标签
 * @param {string | null} previousTag 上一个标签
 * @returns {Array<{ hash: string, subject: string, type: string, message: string }>} 提交列表
 */
function listCommits(tag, previousTag) {
  const range = previousTag ? `${previousTag}..${tag}` : tag;
  const raw = git(['log', range, '--pretty=format:%h%x1f%s%x1e']);
  if (!raw) return [];

  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, subject] = record.split('\x1f');
      const parsed = CONVENTIONAL_PATTERN.exec(subject);
      if (!parsed) {
        return { hash, subject, type: 'other', message: subject };
      }
      const type = parsed[1].toLowerCase();
      return {
        hash,
        subject,
        type: SECTIONS.some((section) => section.type === type) ? type : 'other',
        message: parsed[2],
      };
    });
}

/**
 * 返回指定时区的当天日期（ISO 格式）。
 *
 * @returns {string} `YYYY-MM-DD` 格式的日期
 */
function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

/**
 * 转义 Markdown 表格单元格中的竖线。
 *
 * @param {string} value 原始文本
 * @returns {string} 转义后的文本
 */
function escapeTableCell(value) {
  return value.replace(/\|/g, '\\|');
}

/**
 * 根据提交历史渲染发布说明。
 *
 * @param {object} options 渲染参数
 * @param {string} options.tag 发布标签
 * @param {string} options.version 不带 v 的版本号
 * @param {string | null} options.previousTag 上一个标签
 * @param {Array<{ hash: string, subject: string, type: string, message: string }>} options.commits 提交列表
 * @param {Array<{ name: string, version: string, description: string }>} options.packages 发布包
 * @param {string | null} options.repository GitHub 仓库标识
 * @returns {string} Markdown 正文
 */
function renderNotes({ tag, version, previousTag, commits, packages, repository }) {
  const lines = [];

  lines.push(`# ${tag}`, '');
  lines.push(`发布日期：${today()}`, '');
  lines.push('## 变更', '');

  if (commits.length === 0) {
    lines.push('本次发布没有新的提交。', '');
  } else {
    for (const section of SECTIONS) {
      const items = commits.filter((commit) => commit.type === section.type);
      if (items.length === 0) continue;
      lines.push(`### ${section.title}`, '');
      for (const item of items) {
        lines.push(`- ${item.message}（${item.hash}）`);
      }
      lines.push('');
    }
  }

  lines.push('## 发布包', '');
  lines.push('| 包 | 版本 | 说明 |');
  lines.push('| --- | --- | --- |');
  for (const pkg of packages) {
    lines.push(
      `| \`${pkg.name}\` | ${pkg.version} | ${escapeTableCell(pkg.description)} |`,
    );
  }
  lines.push('');

  lines.push('## 安装', '');
  lines.push('### npm', '');
  lines.push('```bash');
  for (const pkg of packages) {
    if (pkg.name === '@ofdrw/ofdrw-viewer-cli') {
      lines.push(`npm install -g ${pkg.name}@${version}`);
    } else {
      lines.push(`npm install ${pkg.name}@${version}`);
    }
  }
  lines.push('```', '');

  lines.push('### CLI 二进制', '');
  lines.push(
    '从本页附件下载对应平台的压缩包，解压后直接运行，无需安装 Node.js：',
    '',
  );
  for (const target of CLI_TARGETS) {
    lines.push(
      `- \`ofdrw-viewer-cli-${version}-${target.target}.${target.suffix}\``,
    );
  }
  lines.push('');

  lines.push('### CDN', '');
  lines.push(
    `\`cdn-${version}.zip\` 内含 engine 与 crypto 的 IIFE 产物，请按 engine → crypto 的顺序加载。`,
    '',
  );

  lines.push('## 校验', '');
  lines.push('下载 `SHA256SUMS` 后，在同一目录执行：', '');
  lines.push('```bash');
  lines.push('sha256sum -c SHA256SUMS');
  lines.push('```', '');

  if (repository) {
    lines.push('## 完整变更', '');
    lines.push(
      previousTag
        ? `https://github.com/${repository}/compare/${previousTag}...${tag}`
        : `https://github.com/${repository}/commits/${tag}`,
      '',
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * 生成入口。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const tag = process.argv[2];
  const version = process.argv[3];
  const output = process.argv[4] ?? 'release-notes.md';

  if (!tag || !version) {
    throw new Error(
      '缺少参数；用法：node .github/scripts/generate-release-notes.mjs <tag> <version> [output]',
    );
  }

  const previousTag = findPreviousTag(tag);
  const commits = listCommits(tag, previousTag);
  const packages = await Promise.all(PACKAGES.map((pkg) => readPackage(pkg.dir)));
  const repository = resolveRepository();
  const notes = renderNotes({ tag, version, previousTag, commits, packages, repository });

  await writeFile(output, notes, 'utf8');
  console.log(
    `已自动生成发布说明：${output}（${commits.length} 个提交，上一标签：${previousTag ?? '无'}）`,
  );
}

main().catch((error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});