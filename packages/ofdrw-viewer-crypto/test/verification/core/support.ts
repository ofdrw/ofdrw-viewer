/**
 * V-CORE 独立验证的共享工具。
 *
 * 只使用 Node 标准库、OpenSSL CLI 与仓库内 fixture，不引用 crypto 实现内部模块，
 * 从而让期望值来自被测实现之外（OpenSSL / GB/T 标准 / Java PoC）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** crypto 包根目录。 */
export const PKG_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 测试 fixture 根目录。 */
export const FIXTURE_ROOT = join(PKG_ROOT, 'test/fixtures/crypto');

/** 构建产物目录。 */
export const DIST_ROOT = join(PKG_ROOT, 'dist');

/** 当前环境是否提供 OpenSSL CLI。 */
export const OPENSSL_AVAILABLE = detectOpenSsl();

/**
 * 检测 OpenSSL 是否可执行。
 *
 * @returns 可用返回 true。
 */
function detectOpenSsl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取 fixture 字节。
 *
 * @param segments 相对 `test/fixtures/crypto/` 的路径片段。
 * @returns 文件字节。
 */
export function fixtureBytes(...segments: string[]): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_ROOT, ...segments)));
}

/**
 * 读取 fixture 文本。
 *
 * @param segments 相对 `test/fixtures/crypto/` 的路径片段。
 * @returns 文件文本。
 */
export function fixtureText(...segments: string[]): string {
  return readFileSync(join(FIXTURE_ROOT, ...segments), 'utf8');
}

/**
 * 十六进制转字节。
 *
 * @param hex 十六进制文本。
 * @returns 字节。
 */
export function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * 字节转小写十六进制。
 *
 * @param bytes 字节。
 * @returns 十六进制文本。
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * UTF-8 编码。
 *
 * @param text 文本。
 * @returns 字节。
 */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 拼接字节。
 *
 * @param parts 字节片段。
 * @returns 拼接结果。
 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * 创建临时目录；调用方负责清理。
 *
 * @param prefix 目录前缀。
 * @returns 临时目录绝对路径。
 */
export function makeTempDir(prefix = 'ofdrw-crypto-verify-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 删除临时目录。
 *
 * @param dir 目录路径。
 */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 写入临时文件。
 *
 * @param dir 目录。
 * @param name 文件名。
 * @param data 字节或文本。
 * @returns 文件绝对路径。
 */
export function writeTemp(dir: string, name: string, data: Uint8Array | string): string {
  const file = join(dir, name);
  writeFileSync(file, data);
  return file;
}

/**
 * 读取临时文件字节。
 *
 * @param dir 目录。
 * @param name 文件名。
 * @returns 字节。
 */
export function readTemp(dir: string, name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dir, name)));
}

/**
 * 执行 OpenSSL 并返回 UTF-8 文本。
 *
 * @param args 参数。
 * @param input 标准输入。
 * @returns 标准输出文本。
 */
export function opensslText(args: readonly string[], input?: Uint8Array): string {
  return execFileSync('openssl', [...args], {
    input: input ? Buffer.from(input) : undefined,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * 执行 OpenSSL 并返回二进制标准输出。
 *
 * @param args 参数。
 * @param input 标准输入。
 * @returns 标准输出字节。
 */
export function opensslBytes(args: readonly string[], input?: Uint8Array): Uint8Array {
  return new Uint8Array(
    execFileSync('openssl', [...args], {
      input: input ? Buffer.from(input) : undefined,
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

/**
 * 执行 OpenSSL 并返回退出码，用于断言“验签失败”。
 *
 * @param args 参数。
 * @param input 标准输入。
 * @returns 退出码；进程无法启动时为 -1。
 */
export function opensslStatus(args: readonly string[], input?: Uint8Array): number {
  const result = spawnSync('openssl', [...args], {
    input: input ? Buffer.from(input) : undefined,
    encoding: 'utf8',
  });
  return result.status ?? -1;
}

/**
 * 捕获同步调用的错误码。
 *
 * @param fn 被测调用。
 * @returns `code` 字段；未抛错返回 undefined。
 */
export function syncErrorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { readonly code?: string }).code;
  }
}

/**
 * 捕获异步调用的错误码。
 *
 * @param promise 被测 Promise。
 * @returns `code` 字段；未拒绝返回 undefined。
 */
export async function asyncErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { readonly code?: string }).code;
  }
}

/** OpenSSL 证书事实。 */
export interface OpenSslCertificateFacts {
  /** 主体 DN（与证书编码顺序一致）。 */
  readonly subject: string;
  /** 颁发者 DN。 */
  readonly issuer: string;
  /** 序列号小写十六进制（无前导零）。 */
  readonly serialNumber: string;
  /** 生效时间。 */
  readonly notBefore: Date;
  /** 失效时间。 */
  readonly notAfter: Date;
  /** SHA-256 指纹（小写十六进制）。 */
  readonly fingerprintSha256: string;
  /** 是否 CA。 */
  readonly isCA: boolean;
  /** KeyUsage 可读名（OpenSSL 顺序）。 */
  readonly keyUsage: readonly string[];
  /** ExtendedKeyUsage OID（按 OpenSSL 名称映射）。 */
  readonly extendedKeyUsage: readonly string[];
  /** SubjectKeyIdentifier 小写十六进制。 */
  readonly subjectKeyIdentifier?: string;
  /** AuthorityKeyIdentifier 小写十六进制。 */
  readonly authorityKeyIdentifier?: string;
  /** 未压缩公钥点（65 byte）。 */
  readonly publicKey: Uint8Array;
}

/** OpenSSL KeyUsage 名称到包内名称的映射。 */
const KEY_USAGE_OID: Readonly<Record<string, string>> = {
  'Digital Signature': 'digitalSignature',
  'Non Repudiation': 'nonRepudiation',
  'Key Encipherment': 'keyEncipherment',
  'Data Encipherment': 'dataEncipherment',
  'Key Agreement': 'keyAgreement',
  'Certificate Sign': 'keyCertSign',
  'CRL Sign': 'cRLSign',
  'Encipher Only': 'encipherOnly',
  'Decipher Only': 'decipherOnly',
};

/** OpenSSL ExtendedKeyUsage 名称到 OID 的映射。 */
const EXTENDED_KEY_USAGE_OID: Readonly<Record<string, string>> = {
  'TLS Web Server Authentication': '1.3.6.1.5.5.7.3.1',
  'TLS Web Client Authentication': '1.3.6.1.5.5.7.3.2',
  'Code Signing': '1.3.6.1.5.5.7.3.3',
  'E-mail Protection': '1.3.6.1.5.5.7.3.4',
  'Time Stamping': '1.3.6.1.5.5.7.3.8',
  'OCSP Signing': '1.3.6.1.5.5.7.3.9',
};

/**
 * 用 OpenSSL 读取证书字段。
 *
 * @param pemFile PEM 证书路径。
 * @returns 字段事实。
 */
export function readOpenSslCertificate(pemFile: string): OpenSslCertificateFacts {
  const fields = opensslText([
    'x509',
    '-in',
    pemFile,
    '-noout',
    '-subject',
    '-issuer',
    '-serial',
    '-startdate',
    '-enddate',
    '-fingerprint',
    '-sha256',
    '-nameopt',
    'sep_comma_plus',
  ]);
  const extensions = opensslText([
    'x509',
    '-in',
    pemFile,
    '-noout',
    '-ext',
    'basicConstraints,keyUsage,extendedKeyUsage,subjectKeyIdentifier,authorityKeyIdentifier',
  ]);

  const line = (prefix: string): string => {
    const found = fields.split(/\r?\n/).find((item) => item.startsWith(prefix));
    if (!found) throw new Error(`OpenSSL 输出缺少 ${prefix}`);
    return found.slice(prefix.length);
  };

  const publicKeyPem = opensslText(['x509', '-in', pemFile, '-noout', '-pubkey']);
  const publicKeyDer = opensslBytes(
    ['pkey', '-pubin', '-outform', 'DER'],
    utf8(publicKeyPem),
  );
  const publicKey = publicKeyDer.slice(-65);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error('OpenSSL 公钥不是未压缩 EC 点');
  }

  const fingerprint = /sha256 Fingerprint=(.*)/.exec(fields)?.[1]?.replace(/:/g, '').toLowerCase();
  const keyUsageText = /Key Usage:[^\n]*\n\s*([^\n]+)/.exec(extensions)?.[1];
  const extendedKeyUsageText = /Extended Key Usage:[^\n]*\n\s*([^\n]+)/.exec(extensions)?.[1];
  const subjectKeyIdentifier = /Subject Key Identifier:\s*\n\s*([0-9A-F:]+)/i
    .exec(extensions)?.[1]
    ?.replace(/:/g, '')
    .toLowerCase();
  const authorityKeyIdentifier = /keyid:([0-9A-F:]+)/i
    .exec(extensions)?.[1]
    ?.replace(/:/g, '')
    .toLowerCase();
  const ca = /CA:(TRUE|FALSE)/.exec(extensions)?.[1];

  if (!fingerprint || !ca) throw new Error('OpenSSL 证书扩展输出不完整');

  return {
    subject: line('subject='),
    issuer: line('issuer='),
    serialNumber: BigInt(`0x${line('serial=')}`).toString(16),
    notBefore: new Date(line('notBefore=')),
    notAfter: new Date(line('notAfter=')),
    fingerprintSha256: fingerprint,
    isCA: ca === 'TRUE',
    keyUsage: keyUsageText
      ? keyUsageText.split(',').map((name) => KEY_USAGE_OID[name.trim()] ?? name.trim())
      : [],
    extendedKeyUsage: extendedKeyUsageText
      ? extendedKeyUsageText
          .split(',')
          .map((name) => EXTENDED_KEY_USAGE_OID[name.trim()] ?? name.trim())
      : [],
    subjectKeyIdentifier,
    authorityKeyIdentifier,
    publicKey,
  };
}

/**
 * 用 OpenSSL 验证证书链。
 *
 * @param pemFile 待验证证书。
 * @param caFile 根证书。
 * @returns 验证通过返回 true。
 */
export function opensslVerifyCertificate(pemFile: string, caFile: string): boolean {
  // 证书由 ofdrw Java 以 GB/T 默认 userId 签发；OpenSSL 默认空 ID，必须显式传 distid。
  return (
    opensslStatus([
      'verify',
      '-CAfile',
      caFile,
      '-vfyopt',
      'distid:1234567812345678',
      pemFile,
    ]) === 0
  );
}

/**
 * 执行 crypto 包构建（含 ESM/CJS/d.ts）。
 *
 * @returns 构建耗时说明。
 */
export function buildCryptoPackage(): string {
  return execFileSync('pnpm', ['run', 'build'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}