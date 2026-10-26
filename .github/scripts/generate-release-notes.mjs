#!/usr/bin/env node
/**
 * 生成 GitHub Release 正文。
 *
 * 发布说明托管在 GitHub Release 页面，不在仓库内维护。打标签时把面向用户的功能说明
 * 写进注释标签的消息，脚本会直接采用该消息作为正文（安装与下载信息也一并写在其中）；
 * 标签没有消息或消息只有标签名时，退回根据提交历史生成精简摘要。
 *
 * 建议先写好说明再打标签（说明文件用 `##` 分节，不要写一级标题，Release 名称已包含标签）：
 *   git tag -a v0.1.3 -F release-notes-v0.1.3.md --cleanup=verbatim
 *   git push origin v0.1.3
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
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（脚本位于 `.github/scripts/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 发布包名，按安装顺序排列。 */
const PACKAGE_NAMES = [
  '@ofdrw/ofdrw-viewer-engine',
  '@ofdrw/ofdrw-viewer-crypto',
  '@ofdrw/ofdrw-viewer-ui',
  '@ofdrw/ofdrw-viewer-cli',
];

/** 面向用户的提交类型，按输出顺序排列；其余类型只在摘要中计数。 */
const USER_SECTIONS = [
  { type: 'feat', title: '新功能' },
  { type: 'fix', title: '问题修复' },
  { type: 'perf', title: '性能优化' },
  { type: 'revert', title: '回滚' },
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
 * 推导 GitHub Pages 演示站地址。
 *
 * @param {string | null} repository GitHub 仓库标识 `owner/repo`
 * @returns {string | null} 演示站根地址（以 `/` 结尾）；仓库为 `<owner>.github.io` 时解析为其根域名，解析失败时返回 null
 */
function resolvePagesUrl(repository) {
  if (!repository) return null;
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  if (repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return `https://${repo}/`;
  }
  return `https://${owner}.github.io/${repo}/`;
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
 * 读取注释标签中的消息，作为人工编写的发布说明。
 *
 * 轻量标签、消息为空或消息只有标签名时，视为没有手写说明。
 *
 * @param {string} tag 发布标签
 * @returns {string | null} 标签消息；没有可用消息时返回 null
 */
function readCuratedNotes(tag) {
  const raw = git([
    'for-each-ref',
    `refs/tags/${tag}`,
    '--format=%(objecttype)%1f%(contents)',
  ]);
  if (!raw) return null;

  const [objectType, ...messageParts] = raw.split('\x1f');
  if (objectType !== 'tag') return null;

  const message = messageParts.join('\x1f').trim();
  if (!message || message === tag) return null;
  return message;
}

/**
 * 列出两个引用之间的提交。
 *
 * @param {string} tag 当前发布标签
 * @param {string | null} previousTag 上一个标签
 * @returns {Array<{ type: string, message: string }>} 提交列表
 */
function listCommits(tag, previousTag) {
  const range = previousTag ? `${previousTag}..${tag}` : tag;
  const raw = git(['log', range, '--pretty=format:%s%x1e']);
  if (!raw) return [];

  return raw
    .split('\x1e')
    .map((subject) => subject.trim())
    .filter((subject) => subject.length > 0)
    .map((subject) => {
      const parsed = CONVENTIONAL_PATTERN.exec(subject);
      if (!parsed) {
        return { type: 'other', message: subject };
      }
      return { type: parsed[1].toLowerCase(), message: parsed[2] };
    });
}

/**
 * 根据提交生成面向用户的精简摘要。
 *
 * 只列出 feat/fix/perf/revert，其余类型只汇总数量，避免把文档、测试、构建等
 * 内部改动铺满发布页。
 *
 * @param {Array<{ type: string, message: string }>} commits 提交列表
 * @returns {string[]} Markdown 行
 */
function renderCommitSummary(commits) {
  const lines = [];
  let visibleCount = 0;

  for (const section of USER_SECTIONS) {
    const items = commits.filter((commit) => commit.type === section.type);
    if (items.length === 0) continue;
    visibleCount += items.length;
    lines.push(`### ${section.title}`, '');
    for (const item of items) {
      lines.push(`- ${item.message}`);
    }
    lines.push('');
  }

  const hiddenCount = commits.length - visibleCount;

  if (visibleCount === 0 && hiddenCount === 0) {
    lines.push('本次发布没有新的变化。', '');
  } else if (visibleCount === 0) {
    lines.push(`本次发布以文档、测试与构建调整为主（共 ${hiddenCount} 项）。`, '');
  } else if (hiddenCount > 0) {
    lines.push('### 其他调整', '');
    lines.push(`- 文档、测试、构建与内部调整共 ${hiddenCount} 项。`, '');
  }

  return lines;
}

/**
 * 判断正文是否已经包含 GitHub 的对比或提交链接。
 *
 * @param {string} notes 发布说明正文
 * @returns {boolean} 是否已包含链接
 */
function hasCompareLink(notes) {
  return /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:compare|commits)\//.test(notes);
}

/**
 * 追加精简的安装与下载说明。
 *
 * @param {string[]} lines 输出行
 * @param {object} options 安装信息
 * @param {string} options.version 不带 v 的版本号
 * @param {string | null} options.repository GitHub 仓库标识
 * @returns {void}
 */
function appendInstallSection(lines, { version, repository }) {
  lines.push('## 安装', '');
  lines.push('```bash');
  for (const name of PACKAGE_NAMES) {
    const command = name === '@ofdrw/ofdrw-viewer-cli' ? 'npm install -g' : 'npm install';
    lines.push(`${command} ${name}@${version}`);
  }
  lines.push('```', '');

  const tarTargets = CLI_TARGETS.filter((item) => item.suffix === 'tar.gz')
    .map((item) => item.target)
    .join(',');
  const zipTarget = CLI_TARGETS.find((item) => item.suffix === 'zip')?.target ?? 'win32-x64';
  lines.push(
    `- **CLI 二进制**：\`ofdrw-viewer-cli-${version}-{${tarTargets}}.tar.gz\` 或 ` +
      `\`ofdrw-viewer-cli-${version}-${zipTarget}.zip\`，解压即用`,
  );
  lines.push(`- **CDN**：\`cdn-${version}.zip\`（engine → crypto 顺序加载）`);

  const siteArchive = `ofdrw-viewer-ui-demo-${version}`;
  const siteUrl = resolvePagesUrl(repository);
  lines.push(
    `- **演示站**：\`${siteArchive}.zip\`，解压即静态站点${siteUrl ? `；线上 <${siteUrl}>` : ''}`,
    '',
  );
}

/**
 * 追加“完整变更”对比链接。
 *
 * @param {string[]} lines 输出行
 * @param {object} options 链接信息
 * @param {string} options.tag 发布标签
 * @param {string | null} options.previousTag 上一个标签
 * @param {string | null} options.repository GitHub 仓库标识
 * @returns {void}
 */
function appendCompareSection(lines, { tag, previousTag, repository }) {
  if (!repository) return;
  lines.push('## 完整变更', '');
  lines.push(
    previousTag
      ? `https://github.com/${repository}/compare/${previousTag}...${tag}`
      : `https://github.com/${repository}/commits/${tag}`,
    '',
  );
}

/**
 * 根据标签消息或提交历史渲染发布说明。
 *
 * @param {object} options 渲染参数
 * @param {string} options.tag 发布标签
 * @param {string} options.version 不带 v 的版本号
 * @param {string | null} options.previousTag 上一个标签
 * @param {Array<{ type: string, message: string }>} options.commits 提交列表
 * @param {string | null} options.repository GitHub 仓库标识
 * @param {string | null} options.curatedNotes 注释标签中的手写说明
 * @returns {string} Markdown 正文
 */
function renderNotes({ tag, version, previousTag, commits, repository, curatedNotes }) {
  const lines = [];

  if (curatedNotes) {
    lines.push(curatedNotes, '');
    if (!hasCompareLink(curatedNotes)) {
      appendCompareSection(lines, { tag, previousTag, repository });
    }
  } else {
    lines.push(`# ${tag}`, '');
    lines.push('## 本次更新', '');
    lines.push(...renderCommitSummary(commits));
    appendInstallSection(lines, { version, repository });
    appendCompareSection(lines, { tag, previousTag, repository });
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
  const curatedNotes = readCuratedNotes(tag);
  const commits = curatedNotes ? [] : listCommits(tag, previousTag);
  const repository = resolveRepository();
  const notes = renderNotes({
    tag,
    version,
    previousTag,
    commits,
    repository,
    curatedNotes,
  });

  await writeFile(output, notes, 'utf8');

  if (curatedNotes) {
    console.log(`已生成发布说明：${output}（来源：标签 ${tag} 的消息）`);
  } else {
    console.warn(
      `::warning::标签 ${tag} 没有功能说明消息，已根据提交历史生成摘要；` +
        '建议先用 git tag -a ... -F 写好面向用户的说明。',
    );
    console.log(
      `已生成发布说明：${output}（来源：提交历史，${commits.length} 个提交，上一标签：${previousTag ?? '无'}）`,
    );
  }
}

main().catch((error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});