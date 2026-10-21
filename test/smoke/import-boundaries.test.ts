/**
 * 跨模块 import 边界 smoke 测试。
 *
 * 使用 TypeScript AST 读取 `packages/ofdrw-viewer-engine/src/**`，校验：
 * 1. render/common/model/resource/style/font/image/xml/api 不 import DOM/Node/原生 canvas；
 * 2. renderer 只依赖 common/renderer（不依赖 model/style/render/api）；
 * 3. render 不直接 import 渲染器实现（只允许 renderer/types）；
 * 4. common 不产生对 model/style 的运行时依赖（仅允许设计要求的 type-only 前向引用）；
 * 5. model 不产生 render/renderer/api 的运行时依赖。
 *
 * 该测试是架构约束，不是功能测试；新增违规 import 会直接失败。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcRoot = path.join(repoRoot, 'packages', 'ofdrw-viewer-engine', 'src');

/** 递归收集 src 下所有 .ts 文件。 */
function listSourceFiles(dir: string = srcRoot): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listSourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(full);
  }
  return result;
}

interface ImportEdge {
  file: string;
  /** src 下的相对路径，POSIX 分隔。 */
  relativeFile: string;
  /** 目标模块在 src 下的首段；外部包为 null。 */
  targetModule: string | null;
  /** 原始模块说明符。 */
  specifier: string;
  typeOnly: boolean;
}

/** 解析单个文件的 import/export-from 边。 */
function collectImportEdges(file: string): ImportEdge[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];

  const push = (specifier: string, typeOnly: boolean): void => {
    let targetModule: string | null = null;
    if (specifier.startsWith('.')) {
      const target = path.resolve(path.dirname(file), specifier);
      const relative = path.relative(srcRoot, target);
      if (!relative.startsWith('..')) {
        targetModule = relative.split(path.sep)[0] ?? null;
      }
    }
    edges.push({
      file,
      relativeFile: path.relative(srcRoot, file).split(path.sep).join('/'),
      targetModule,
      specifier,
      typeOnly,
    });
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      push(statement.moduleSpecifier.text, statement.importClause?.isTypeOnly ?? false);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      push(statement.moduleSpecifier.text, statement.isTypeOnly);
    }
  }
  return edges;
}

const allFiles = listSourceFiles();
const allEdges = allFiles.flatMap(collectImportEdges);

/** 取某模块目录下的所有 import 边。 */
function edgesFor(moduleName: string): ImportEdge[] {
  return allEdges.filter((edge) => edge.relativeFile.startsWith(`${moduleName}/`));
}

const NODE_BUILTINS = new Set([
  'fs',
  'fs/promises',
  'path',
  'os',
  'url',
  'buffer',
  'crypto',
  'stream',
  'zlib',
  'worker_threads',
  'child_process',
  'module',
]);

/** 判断是否 Node/原生 Canvas 依赖。 */
function isForbiddenPlatformSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    NODE_BUILTINS.has(specifier) ||
    specifier === '@napi-rs/canvas' ||
    specifier === 'canvas' ||
    specifier === 'node-canvas'
  );
}

/** 引擎核心模块：不得依赖 DOM/Node 全局或原生 canvas。 */
const PURE_MODULES = [
  'common',
  'model',
  'resource',
  'style',
  'render',
  'renderer',
  'font',
  'image',
  'xml',
  'api',
];

const FORBIDDEN_GLOBALS = new Set([
  'document',
  'window',
  'navigator',
  'OffscreenCanvas',
  'createImageBitmap',
  'HTMLCanvasElement',
  'ImageBitmap',
  'DOMMatrix',
  'Path2D',
]);

describe('import boundaries', () => {
  it('render/common/model/resource/style/font/image/xml/api 不依赖 Node/原生 canvas', () => {
    const violations = allEdges.filter(
      (edge) =>
        PURE_MODULES.some((moduleName) => edge.relativeFile.startsWith(`${moduleName}/`)) &&
        isForbiddenPlatformSpecifier(edge.specifier),
    );
    expect(violations.map((edge) => `${edge.relativeFile} -> ${edge.specifier}`)).toEqual([]);
  });

  it('renderer 只依赖 common/renderer，不依赖 model/style/render/api', () => {
    const forbidden = new Set([
      'model',
      'style',
      'render',
      'api',
      'container',
      'font',
      'image',
      'resource',
      'xml',
    ]);
    const violations = edgesFor('renderer').filter(
      (edge) => edge.targetModule !== null && forbidden.has(edge.targetModule),
    );
    expect(violations.map((edge) => `${edge.relativeFile} -> ${edge.specifier}`)).toEqual([]);
  });

  it('render 只通过 renderer/types 使用渲染器，不 import 具体实现', () => {
    const violations = edgesFor('render').filter(
      (edge) =>
        edge.targetModule === 'renderer' &&
        !edge.specifier.replace(/\.ts$/, '').endsWith('renderer/types'),
    );
    expect(violations.map((edge) => `${edge.relativeFile} -> ${edge.specifier}`)).toEqual([]);
  });

  it('common 只允许对 model/style 的 type-only 前向引用，不产生运行时依赖', () => {
    const violations = edgesFor('common').filter(
      (edge) =>
        !edge.typeOnly &&
        (edge.targetModule === 'model' ||
          edge.targetModule === 'style' ||
          edge.targetModule === 'render' ||
          edge.targetModule === 'renderer' ||
          edge.targetModule === 'api'),
    );
    expect(violations.map((edge) => `${edge.relativeFile} -> ${edge.specifier}`)).toEqual([]);
  });

  it('model 不产生 render/renderer/api 的运行时依赖', () => {
    const violations = edgesFor('model').filter(
      (edge) =>
        !edge.typeOnly &&
        (edge.targetModule === 'render' ||
          edge.targetModule === 'renderer' ||
          edge.targetModule === 'api'),
    );
    expect(violations.map((edge) => `${edge.relativeFile} -> ${edge.specifier}`)).toEqual([]);
  });

  it('render/common/model/style/font/image/xml 不引用 DOM 全局（renderer 的默认工厂除外）', () => {
    const modules = new Set(['render', 'common', 'model', 'style', 'font', 'image', 'xml']);
    const violations: string[] = [];
    for (const file of allFiles) {
      const relativeFile = path.relative(srcRoot, file).split(path.sep).join('/');
      const moduleName = relativeFile.split('/')[0] ?? '';
      if (!modules.has(moduleName)) continue;
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        // JSDoc/注释不是运行时代码，跳过；只看真实标识符。
        if (ts.isJSDoc(node)) return;
        if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
          violations.push(`${relativeFile}: ${node.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });
});