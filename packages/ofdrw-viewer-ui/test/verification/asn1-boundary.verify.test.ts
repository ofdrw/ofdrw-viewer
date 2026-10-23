/**
 * 静态边界验收：UI 只消费 crypto 公共 API，不再携带 ASN.1/SM 解析实现。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 从测试进程目录向上定位 pnpm 工作区根。 */
function repositoryRoot(start: string): string {
  let directory = start;
  while (!existsSync(join(directory, 'pnpm-workspace.yaml'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('未找到 pnpm-workspace.yaml');
    directory = parent;
  }
  return directory;
}

const UI_ROOT = join(repositoryRoot(process.cwd()), 'packages/ofdrw-viewer-ui');
const SRC_ROOT = join(UI_ROOT, 'src');

/** 递归列出源码文件。 */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(name)) files.push(path);
  }
  return files;
}

const sources = sourceFiles(SRC_ROOT).map((path) => ({
  path,
  content: readFileSync(path, 'utf8'),
}));

describe('UI ASN.1/密码学边界', () => {
  it('package.json 不依赖 ASN.1 或 SM 算法实现', () => {
    const pkg = JSON.parse(readFileSync(join(UI_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const forbidden of [
      'asn1js',
      '@peculiar/asn1-x509',
      '@peculiar/asn1-schema',
      'sm-crypto',
    ]) {
      expect(dependencies, forbidden).not.toHaveProperty(forbidden);
    }
    expect(pkg.dependencies).toMatchObject({
      '@ofdrw/ofdrw-viewer-crypto': expect.stringContaining('workspace:'),
      '@ofdrw/ofdrw-viewer-engine': expect.stringContaining('workspace:'),
    });
  });

  it('源码不 import ASN.1 解析库或 SM 原语', () => {
    for (const { path, content } of sources) {
      expect(content, path).not.toMatch(
        /from\s+['"](?:asn1js|@peculiar\/|sm-crypto)(?:[^'"]*)['"]/,
      );
      expect(content, path).not.toMatch(/require\(\s*['"](?:asn1js|@peculiar\/|sm-crypto)/);
    }
  });

  it('已删除旧 ASN.1 签章解析器与本地密码学实现', () => {
    for (const obsolete of [
      'signature/asn1.ts',
      'signature/asn1-parser.ts',
      'signature/errors.ts',
      'signature/limits.ts',
    ]) {
      expect(existsSync(join(SRC_ROOT, obsolete)), obsolete).toBe(false);
    }
    expect(
      sources.some(({ content }) => /BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY/.test(content)),
    ).toBe(false);
  });

  it('签章详情通过 crypto parseSignedValue 获取解析结果', () => {
    const signature = sources.find(({ path }) => path.endsWith('/signature/service.ts'));
    expect(signature).toBeDefined();
    expect(signature!.content).toContain("from '@ofdrw/ofdrw-viewer-crypto'");
    expect(signature!.content).toContain('parseSignedValue');
    expect(signature!.content).toContain('toSealInfo');
    expect(signature!.content).toContain('toSignerInfo');
    expect(signature!.content).not.toMatch(/parseSeal\s*\(/);
  });
});