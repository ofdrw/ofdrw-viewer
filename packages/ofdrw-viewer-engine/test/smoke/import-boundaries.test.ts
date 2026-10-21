/**
 * 包内 import 边界 smoke（等价于根 `test/smoke/import-boundaries.test.ts` 的最小检查）。
 *
 * 根测试用 TypeScript AST 做完整依赖方向校验；这里用源码 import 说明符做快速回归，
 * 保证 `vitest run test/smoke` 在本包内始终有边界测试可跑。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../../src', import.meta.url));

/** 递归列出模块目录下的 .ts 文件。 */
function listFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(full);
  }
  return result;
}

/** 提取文件中的 import/export-from 说明符。 */
function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const result: string[] = [];
  const pattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) result.push(match[1]);
  }
  return result;
}

/** 是否 Node/原生 Canvas 依赖。 */
function isPlatformSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    ['fs', 'path', 'os', 'url', 'buffer', 'crypto', 'stream', 'zlib', 'worker_threads'].includes(
      specifier,
    ) ||
    specifier === '@napi-rs/canvas' ||
    specifier === 'canvas' ||
    specifier === 'node-canvas'
  );
}

describe('package import boundaries', () => {
  it('render/common 不 import Node 或原生 canvas', () => {
    const violations: string[] = [];
    for (const moduleName of ['render', 'common']) {
      for (const file of listFiles(path.join(srcRoot, moduleName))) {
        for (const specifier of importSpecifiers(file)) {
          if (isPlatformSpecifier(specifier)) {
            violations.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('renderer 不 import model/style/render/api', () => {
    const violations: string[] = [];
    for (const file of listFiles(path.join(srcRoot, 'renderer'))) {
      for (const specifier of importSpecifiers(file)) {
        if (/(^|\/)\.\.\/(model|style|render|api)(\/|$)/.test(specifier)) {
          violations.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});