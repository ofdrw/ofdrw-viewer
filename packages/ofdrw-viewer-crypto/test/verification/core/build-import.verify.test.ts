/**
 * V-CORE 独立验证：构建产物、Node/浏览器导入路径与公共导出。
 *
 * 不依赖 tsup 内部实现：先执行包内 build，再分别以 ESM import、CJS require、
 * esbuild browser bundle 三种方式加载产物并调用真实算法。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CertificateDer,
  CertificateSummary,
  CryptoErrorCode,
  CryptoOptions,
  CryptoWarning,
  Sm2Cipher,
  Sm2PrivateKey,
  X509Certificate,
} from '@ofdrw/ofdrw-viewer-crypto';
import type * as PackageNamespace from '@ofdrw/ofdrw-viewer-crypto';
import { DEFAULT_SM2_USER_ID } from '@ofdrw/ofdrw-viewer-crypto';
import {
  DIST_ROOT,
  PKG_ROOT,
  buildCryptoPackage,
  bytesToHex,
  makeTempDir,
  removeTempDir,
  utf8,
} from './support';

/** 期望存在的运行时导出（公共 API 关键面）。 */
const EXPECTED_EXPORTS = [
  'CRYPTO_ERROR_CODES',
  'CRYPTO_WARNING_CODES',
  'CryptoError',
  'DEFAULT_CRYPTO_LIMITS',
  'DEFAULT_SM2_USER_ID',
  'c1c3c2ToSm2Cipher',
  'derivePasswordKey',
  'encodeSm2Cipher',
  'fromBase64',
  'fromHex',
  'isCryptoError',
  'kdfSm3',
  'loadCertificate',
  'loadCertificates',
  'parseCertificate',
  'parseCertificates',
  'parseSm2Cipher',
  'parseSm2PrivateKey',
  'certificatesToDer',
  'parseX509Certificate',
  'sha256',
  'sm2CipherToC1C3C2',
  'sm2Decrypt',
  'sm2Encrypt',
  'sm2GetPublicKey',
  'sm2Sign',
  'sm2Verify',
  'sm3Digest',
  'sm3Hex',
  'sm3OfText',
  'sm4DecryptCbc',
  'sm4EncryptCbc',
  'toBase64',
  'toCertificateSummary',
  'toHex',
  'toUint8Array',
  'utf8Decode',
  'utf8Encode',
] as const;

let esm: typeof PackageNamespace;
let cjs: typeof PackageNamespace;
let tempDir: string;

beforeAll(async () => {
  buildCryptoPackage();
  tempDir = makeTempDir('ofdrw-crypto-build-');
  esm = await import(`${pathToFileURL(join(DIST_ROOT, 'index.js')).href}?v=${Date.now()}`);
  const require = createRequire(import.meta.url);
  cjs = require(join(DIST_ROOT, 'index.cjs')) as typeof PackageNamespace;
}, 180_000);

afterAll(() => {
  if (tempDir) removeTempDir(tempDir);
});

describe('ESM / CJS / d.ts 构建产物', () => {
  it('产物体积与类型声明存在，package.json 导出映射指向产物', () => {
    for (const file of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
      const path = join(DIST_ROOT, file);
      expect(existsSync(path), file).toBe(true);
      expect(readFileSync(path).byteLength, file).toBeGreaterThan(1024);
    }

    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      type?: string;
      main?: string;
      module?: string;
      types?: string;
      exports?: Record<string, Record<string, string>>;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('./dist/index.cjs');
    expect(pkg.module).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(pkg.exports?.['.']).toMatchObject({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      require: './dist/index.cjs',
    });

    const dts = readFileSync(join(DIST_ROOT, 'index.d.ts'), 'utf8');
    for (const symbol of [
      'declare function sm3Hex',
      'declare function sm4EncryptCbc',
      'declare function sm2Sign',
      'declare function sm2Encrypt',
      'declare function parseSm2Cipher',
      'declare function parseCertificate',
      'declare function certificatesToDer',
      'declare function loadCertificates',
      'DEFAULT_SM2_USER_ID',
    ]) {
      expect(dts, symbol).toContain(symbol);
    }
    for (const typeName of [
      'type CertificateDer = Uint8Array',
      'interface CertificateSummary',
      'interface CryptoOptions',
      'interface Sm2Cipher',
      'interface X509Certificate',
    ]) {
      expect(dts, typeName).toContain(typeName);
    }
    expect(dts).not.toContain('interface CertificateInput');
  });

  it('ESM 与 CJS 运行时导出集合一致且关键 API 齐全', () => {
    const esmKeys = Object.keys(esm).sort();
    const cjsKeys = Object.keys(cjs).sort();
    expect(esmKeys).toEqual(cjsKeys);
    for (const name of EXPECTED_EXPORTS) {
      expect(typeof (esm as unknown as Record<string, unknown>)[name], `ESM ${name}`).not.toBe(
        'undefined',
      );
      expect(typeof (cjs as unknown as Record<string, unknown>)[name], `CJS ${name}`).not.toBe(
        'undefined',
      );
    }
    expect(esmKeys.filter((key) => /^ZipReader$|^ZipVirtualContainer$/.test(key))).toEqual([]);
    expect(esmKeys.filter((key) => esm[key as keyof typeof esm] === undefined)).toEqual([]);
  });

  it('ESM/CJS 产物执行同一算法并得到一致结果', () => {
    expect(esm.sm3Hex(utf8('abc'))).toBe(
      '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0',
    );
    expect(cjs.sm3Hex(utf8('abc'))).toBe(esm.sm3Hex(utf8('abc')));
    expect(esm.toHex(esm.sm3Digest(new Uint8Array(0)))).toBe(
      '1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b',
    );
    expect(cjs.toHex(cjs.sm3Digest(new Uint8Array(0)))).toBe(
      esm.toHex(esm.sm3Digest(new Uint8Array(0))),
    );
    expect(esm.DEFAULT_SM2_USER_ID).toBe('1234567812345678');
    expect(cjs.DEFAULT_SM2_USER_ID).toBe(DEFAULT_SM2_USER_ID);
    expect(new esm.CryptoError('CRYPTO_INVALID_ARGUMENT', 'esm').code).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(new cjs.CryptoError('CRYPTO_INVALID_ARGUMENT', 'cjs').code).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
  });

  it('src/dist 无 node:* 运行时依赖，tsup 使用 platform neutral', () => {
    const sourceFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) sourceFiles.push(full);
      }
    };
    walk(join(PKG_ROOT, 'src'));
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)) {
        if (match[1]?.startsWith('node:')) violations.push(`${file} -> ${match[1]}`);
      }
    }
    expect(violations).toEqual([]);

    for (const file of ['index.js', 'index.cjs']) {
      const text = readFileSync(join(DIST_ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/(?:from|import)\s*\(?\s*['"]node:/);
      expect(text, file).not.toMatch(/require\(\s*['"]node:/);
    }

    const tsupConfig = readFileSync(join(PKG_ROOT, 'tsup.config.ts'), 'utf8');
    expect(tsupConfig).toContain("platform: 'neutral'");
  });

  it('esbuild browser bundle 成功、无 node:* 且可导入执行', async () => {
    const esbuild = join(PKG_ROOT, 'node_modules/.bin/esbuild');
    expect(existsSync(esbuild)).toBe(true);
    const bundle = join(tempDir, 'browser-bundle.mjs');
    execFileSync(
      esbuild,
      [
        join(DIST_ROOT, 'index.js'),
        '--bundle',
        '--platform=browser',
        '--format=esm',
        `--outfile=${bundle}`,
        '--log-level=warning',
      ],
      { cwd: PKG_ROOT, stdio: 'pipe', timeout: 120_000 },
    );

    const text = readFileSync(bundle, 'utf8');
    expect(text.length).toBeGreaterThan(100_000);
    expect(text).not.toMatch(/(?:from|import)\s*\(?\s*['"]node:/);
    expect(text).not.toMatch(/require\(\s*['"]node:/);

    const browser = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);
    expect(typeof browser.sm3Hex).toBe('function');
    expect(browser.sm3Hex(utf8('abc'))).toBe(
      '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0',
    );
    expect(browser.sm3Hex(utf8('OFD 浏览器'))).toBe(
      bytesToHex(esm.sm3Digest(utf8('OFD 浏览器'))),
    );
  });

  it('包根公共类型可用于典型调用（编译期）', () => {
    const options: CryptoOptions = {
      limits: { maxAsn1Bytes: 1024 },
      signal: new AbortController().signal,
      onWarning: (_warning: CryptoWarning) => undefined,
      sm2UserId: DEFAULT_SM2_USER_ID,
      now: new Date('2025-06-01T00:00:00Z'),
    };
    const input: CertificateDer = new Uint8Array([0x30, 0x00]);
    const cipher: Sm2Cipher = {
      x: new Uint8Array(32),
      y: new Uint8Array(32),
      c3: new Uint8Array(32),
      c2: Uint8Array.of(1),
    };
    const code: CryptoErrorCode = 'CRYPTO_INVALID_ARGUMENT';
    const typeCheck = (
      _options: CryptoOptions,
      _input: CertificateDer,
      _cipher: Sm2Cipher,
      _code: CryptoErrorCode,
      _certificate: X509Certificate,
      _summary: CertificateSummary,
      _key: Sm2PrivateKey,
    ): void => undefined;
    expect(typeof typeCheck).toBe('function');
    expect(typeof options).toBe('object');
    expect(input).toBeInstanceOf(Uint8Array);
    expect(cipher.c2).toHaveLength(1);
    expect(code).toBe('CRYPTO_INVALID_ARGUMENT');
  });
});