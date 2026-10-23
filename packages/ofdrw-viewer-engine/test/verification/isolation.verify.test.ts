/**
 * V-ENG 独立验收 4：隔离边界与公共 API。
 *
 * - engine 源码/依赖不得引入 crypto/UI/CLI 包；
 * - api 层不得直读 ZipReader，公共包根不得导出 ZIP 内部实现；
 * - 包根类型（VirtualContainer/Factory/ReadOptions/构造器）可用，返回明文。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as engine from '@ofdrw/ofdrw-viewer-engine';
import {
  OFDDocument,
  openZipVirtualContainer,
} from '@ofdrw/ofdrw-viewer-engine';
import type {
  OFDSource,
  OFDWarning,
  OpenZipVirtualContainerOptions,
  VirtualContainer,
  VirtualContainerFactory,
  VirtualFileMeta,
  VirtualReadOptions,
} from '@ofdrw/ofdrw-viewer-engine';
import { rawEntryMap } from './support';

/** engine 包根目录。 */
const ENGINE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** 源码目录。 */
const SRC_ROOT = join(ENGINE_ROOT, 'src');

/** 递归列出 .ts 源码。 */
function listTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(full);
  }
  return result;
}

/** 提取 import/export-from 说明符。 */
function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => Boolean(specifier));
}

/** 判断说明符是否指向同级 viewer 包。 */
function isSiblingViewerPackage(specifier: string): boolean {
  return /^@ofdrw\/ofdrw-viewer-(crypto|ui|cli)(\/|$)/.test(specifier);
}

/** 读取 JSDoc 后的指定签名是否存在。 */
function hasDocBefore(source: string, signature: string): boolean {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`/\\*\\*[\\s\\S]*?\\*/\\s*${escaped}`).test(source);
}

describe('V-ENG 隔离边界', () => {
  it('engine 源码与依赖不引入 crypto/UI/CLI 包', () => {
    const violations: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      for (const specifier of importSpecifiers(file)) {
        if (isSiblingViewerPackage(specifier)) {
          violations.push(`${file.slice(ENGINE_ROOT.length)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(ENGINE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    });
    expect(declared.filter(isSiblingViewerPackage)).toEqual([]);
    // 运行时依赖保持白名单，避免隐式跨包耦合。
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['fflate', 'fontkit', 'saxes']);
  });

  it('api 层不直接 import ZipReader；包根不导出 ZipReader/ZipVirtualContainer', () => {
    const apiRoot = join(SRC_ROOT, 'api');
    const violations: string[] = [];
    for (const file of listTsFiles(apiRoot)) {
      for (const specifier of importSpecifiers(file)) {
        if (/zip-reader$/.test(specifier)) {
          violations.push(`${file.slice(ENGINE_ROOT.length)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);

    const exported = engine as unknown as Record<string, unknown>;
    expect(exported.ZipReader).toBeUndefined();
    expect(exported.ZipVirtualContainer).toBeUndefined();
    expect(Object.keys(exported).some((key) => /^(ZipReader|ZipVirtualContainer)$/.test(key))).toBe(
      false,
    );
    expect(exported.OFDDocument).toBe(OFDDocument);
    expect(typeof exported.openZipVirtualContainer).toBe('function');
  });

  it('包根类型可用：容器实例/工厂/读取选项/元数据/构造器均为公共类型', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../ofd_pdf_match/hello.ofd', import.meta.url)),
    );
    const options: OpenZipVirtualContainerOptions = { limits: { maxEntries: 100 } };
    const container: VirtualContainer = await openZipVirtualContainer(
      { kind: 'arraybuffer', data: bytes } satisfies OFDSource,
      options,
    );
    try {
      const metas: readonly VirtualFileMeta[] = container.list();
      expect(metas.length).toBeGreaterThan(0);
      expect(container.packageSize).toBe(bytes.byteLength);
      expect(container.encrypted).toBe(false);

      const warnings: OFDWarning[] = [];
      const readOptions: VirtualReadOptions = {
        maxBytes: 1024 * 1024,
        verifyChecksum: true,
        onWarning: (warning) => warnings.push(warning),
      };
      const ofdXml = await container.read('OFD.xml', readOptions);
      const rawOfdXml = rawEntryMap(bytes).get('OFD.xml');
      expect(rawOfdXml).toBeDefined();
      expect([...ofdXml]).toEqual([...rawOfdXml!]);
      expect(new TextDecoder().decode(ofdXml)).toContain('ofd:OFD');
      expect(warnings).toEqual([]);
      expect(container.stat('OFD.xml')?.origin).toBe('package');
      expect(container.has('/OFD.xml')).toBe(true);
      expect(container.has('missing.xml')).toBe(false);
    } finally {
      await container.close();
    }

    const factory: VirtualContainerFactory = async (source) => openZipVirtualContainer(source);
    const factoryContainer = await factory({ kind: 'arraybuffer', data: bytes });
    try {
      expect(factoryContainer.encrypted).toBe(false);
      expect(factoryContainer.list().some((meta) => meta.path === 'OFD.xml')).toBe(true);
    } finally {
      await factoryContainer.close();
    }
  });

  it('虚拟容器公共接口与构造器具备完整 JSDoc（类型/参数/返回值/异常）', () => {
    const interfaceSource = readFileSync(join(SRC_ROOT, 'platform/virtual-container.ts'), 'utf8');
    for (const signature of [
      'export interface VirtualFileMeta',
      'export interface VirtualReadOptions',
      'export interface VirtualContainer',
      'export type VirtualContainerFactory',
      'readonly packageSize',
      'readonly encrypted',
      'list()',
      'has(',
      'stat(',
      'read(',
      'close()',
    ]) {
      expect(hasDocBefore(interfaceSource, signature), signature).toBe(true);
    }
    expect(interfaceSource).toMatch(/@param path/);
    expect(interfaceSource).toMatch(/@returns 调用方拥有的条目字节/);
    expect(interfaceSource).toMatch(/raw package container（encrypted=true）可能返回密文/);
    expect(interfaceSource).toMatch(/@throws OFDError/);
    expect(interfaceSource).toMatch(/单位 byte/);

    const containerSource = readFileSync(join(SRC_ROOT, 'api/container.ts'), 'utf8');
    expect(hasDocBefore(containerSource, 'export async function openZipVirtualContainer')).toBe(true);
    expect(containerSource).toMatch(/@param source/);
    expect(containerSource).toMatch(/@returns 默认 ZIP 容器/);
    expect(containerSource).toMatch(/@throws OFDError/);
  });
});