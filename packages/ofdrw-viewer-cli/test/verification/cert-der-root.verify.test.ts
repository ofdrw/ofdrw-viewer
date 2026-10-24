/**
 * V-CERT 独立验证（CLI）：`verify --root` 支持 PEM/CER/DER/Base64/多证书/CRLF/BOM，
 * 每个文件先读取原始字节并交给 crypto 的 `certificatesToDer`，最终只把 DER 传给
 * `verifyOfd`；错误码、退出码（0/1/5）与“无根链 unknown 不改变 overall”语义保持不回归。
 *
 * 只通过 CLI 源码入口 `main` 观察行为，crypto 公共 API 仅用作 oracle。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseCertificate,
  toBase64,
  verifyOfd,
  type VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import type { CliVerifyJson } from '../../src/verify.js';
import {
  ROOT_DER,
  ROOT_PEM,
  cleanupTempDirs,
  createTempDir,
  fixture,
  parseJson,
  runMain,
} from './support.js';

afterEach(cleanupTempDirs);

/** 根证书 DER 字节与解析指纹。 */
const ROOT_DER_BYTES = new Uint8Array(await readFile(ROOT_DER));
const ROOT_FINGERPRINT = parseCertificate(ROOT_DER_BYTES).fingerprintSha256;
/** 根证书 PEM 文本。 */
const ROOT_PEM_TEXT = await readFile(ROOT_PEM, 'utf8');
/** 私钥 PEM（非证书块）。 */
const SIGNER_KEY_TEXT = await readFile(fixture('certs/signer.key.pem'), 'utf8');

/**
 * 提取跨调用稳定的报告字段，避免绝对时间（startedAt/durationMs/currentTime）
 * 造成无意义差异。
 *
 * @param report 验证报告。
 * @returns 可比较的快照。
 */
function snapshot(report: VerificationReport): unknown {
  return {
    overall: report.overall,
    rootsConfigured: report.rootsConfigured,
    package: report.package,
    integrity:
      report.integrity === null
        ? null
        : {
            status: report.integrity.status,
            entriesPath: report.integrity.entriesPath,
            fileListCount: report.integrity.fileListCount,
            actualFileCount: report.integrity.actualFileCount,
            missingFiles: report.integrity.missingFiles,
            extraFiles: report.integrity.extraFiles,
            certificateStatus: report.integrity.certificate.status,
            chain: report.integrity.certificate.chain.map((item) => item.fingerprintSha256),
          },
    signatures: report.signatures.map((signature) => ({
      id: signature.id,
      status: signature.status,
      certificateStatus: signature.certificate.status,
      signerFingerprint: signature.certificate.signer?.fingerprintSha256,
      trustAnchorFingerprint: signature.certificate.trustAnchor?.fingerprintSha256,
      chain: signature.certificate.chain.map((item) => item.fingerprintSha256),
      sealStatus: signature.seal?.status,
      timestampStatus: signature.timestamp.status,
      timestampNote: signature.timestamp.note,
    })),
    warnings: report.warnings.map((warning) => warning.code),
  };
}

/**
 * 运行 `verify --json` 并解析。
 *
 * @param rootPath 根证书文件路径；省略表示不配置根。
 * @param cwd 工作目录。
 * @returns 退出码、stdout/stderr 与解析后的 JSON。
 */
async function verifyJson(
  rootPath: string | undefined,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string; payload?: CliVerifyJson }> {
  const args = ['verify', fixture('signed-sesv4.ofd'), '--json'];
  if (rootPath !== undefined) args.push('--root', rootPath);
  const result = await runMain(args, cwd);
  return {
    ...result,
    ...(result.stdout === '' ? {} : { payload: parseJson<CliVerifyJson>(result.stdout) }),
  };
}

/**
 * 断言带根验证为 valid 且信任锚为预期根。
 *
 * @param result verify 结果。
 */
function expectValidTrusted(result: {
  code: number;
  stderr: string;
  payload?: CliVerifyJson;
}): void {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.payload?.report.overall).toBe('valid');
  expect(result.payload?.report.rootsConfigured).toBe(true);
  expect(result.payload?.report.signatures[0]?.certificate.status).toBe('valid');
  expect(result.payload?.report.signatures[0]?.certificate.trustAnchor?.fingerprintSha256).toBe(
    ROOT_FINGERPRINT,
  );
}

/**
 * 把文本写入临时文件。
 *
 * @param dir 目录。
 * @param name 文件名。
 * @param data 文本或字节。
 * @returns 文件绝对路径。
 */
async function writeRoot(
  dir: string,
  name: string,
  data: string | Uint8Array,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

describe('CLI --root：各格式都经 certificatesToDer 转 DER', () => {
  it('PEM 单证书、DER、CER、Base64、CRLF、BOM 结果一致且退出 0', async () => {
    const cwd = await createTempDir();
    const variants: ReadonlyArray<readonly [string, string | Uint8Array]> = [
      ['root.pem', ROOT_PEM_TEXT],
      ['root.der', ROOT_DER_BYTES],
      ['root.cer', ROOT_DER_BYTES],
      ['root.b64', toBase64(ROOT_DER_BYTES)],
      ['root-crlf.pem', ROOT_PEM_TEXT.replaceAll('\n', '\r\n')],
      ['root-bom.pem', `\uFEFF${ROOT_PEM_TEXT}`],
    ];
    const oracle = await verifyOfd({
      source: { kind: 'arraybuffer', data: new Uint8Array(await readFile(fixture('signed-sesv4.ofd'))) },
      roots: [ROOT_DER_BYTES],
    });
    for (const [name, data] of variants) {
      const rootPath = await writeRoot(cwd, name, data);
      const result = await verifyJson(rootPath, cwd);
      expectValidTrusted(result);
      expect(snapshot(result.payload!.report), name).toEqual(snapshot(oracle));
    }
  });

  it('多证书 PEM bundle 与重复根：契约数量去重后仍为有效，链锚不变', async () => {
    const cwd = await createTempDir();
    // 第二张放入无关的终端实体证书，既证明多证书解析，又不抢占正确信任锚。
    const unrelatedPem = await readFile(fixture('certs/encrypt.crt.pem'), 'utf8');
    const bundlePath = await writeRoot(
      cwd,
      'roots.pem',
      `${ROOT_PEM_TEXT}\n${unrelatedPem}`,
    );
    const bundle = await verifyJson(bundlePath, cwd);
    expectValidTrusted(bundle);
    expect(bundle.payload?.report.signatures[0]?.certificate.chain).toHaveLength(2);

    const duplicatePath = await writeRoot(
      cwd,
      'duplicate.pem',
      `${ROOT_PEM_TEXT}\n${ROOT_PEM_TEXT}`,
    );
    const duplicate = await verifyJson(duplicatePath, cwd);
    expectValidTrusted(duplicate);

    const text = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', duplicatePath],
      cwd,
    );
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('根证书: 已配置 1 / 链 valid');
  });

  it('同一根证书以 PEM+DER 两个文件传入，文本仍显示实际信任锚 1 个', async () => {
    const cwd = await createTempDir();
    const pemCopy = await writeRoot(cwd, 'root.pem', ROOT_PEM_TEXT);
    const derCopy = await writeRoot(cwd, 'root.der', ROOT_DER_BYTES);
    const result = await runMain(
      [
        'verify',
        fixture('signed-sesv4.ofd'),
        '--root',
        pemCopy,
        '--root',
        derCopy,
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('根证书: 已配置 1 / 链 valid');
    expect(result.stdout).toContain('验证结果: valid');
  });
});

describe('CLI --root：错误码/退出码/链状态语义不回归', () => {
  it('未配置根：链 unknown 但 overall=valid、退出 0，warning 仍为 W_CRYPTO_TRUST_UNKNOWN', async () => {
    const cwd = await createTempDir();
    const result = await verifyJson(undefined, cwd);
    expect(result.code).toBe(0);
    expect(result.payload?.report.overall).toBe('valid');
    expect(result.payload?.report.rootsConfigured).toBe(false);
    expect(result.payload?.report.signatures[0]?.status).toBe('valid');
    expect(result.payload?.report.signatures[0]?.references.status).toBe('valid');
    expect(result.payload?.report.signatures[0]?.certificate.status).toBe('unknown');
    expect(result.stderr).toContain('W_CRYPTO_TRUST_UNKNOWN');
  });

  it('错误根证书（非签发者）：链 incomplete 但 overall=valid、退出 0，不误报证书格式错误', async () => {
    const cwd = await createTempDir();
    const wrongRoot = join(fixture('certs/encrypt.crt.pem'));
    const result = await verifyJson(wrongRoot, cwd);
    expect(result.code).toBe(0);
    expect(result.payload?.report.overall).toBe('valid');
    expect(result.payload?.report.signatures[0]?.status).toBe('valid');
    expect(result.payload?.report.signatures[0]?.certificate.status).toBe('incomplete');
    expect(result.stderr).not.toContain('CRYPTO_CERTIFICATE_INVALID');
  });

  it('非法 PEM / 空文件 / 私钥 PEM：CRYPTO_CERTIFICATE_INVALID、退出 5、stdout 为空', async () => {
    const cwd = await createTempDir();
    const badPem = await writeRoot(
      cwd,
      'bad.pem',
      '-----BEGIN CERTIFICATE-----\n****\n-----END CERTIFICATE-----',
    );
    const empty = await writeRoot(cwd, 'empty.pem', '');
    const key = await writeRoot(cwd, 'key.pem', SIGNER_KEY_TEXT);
    for (const rootPath of [badPem, empty, key]) {
      const result = await verifyJson(rootPath, cwd);
      expect(result.code, rootPath).toBe(5);
      expect(result.stdout, rootPath).toBe('');
      expect(result.stderr, rootPath).toContain('CRYPTO_CERTIFICATE_INVALID');
    }
  });

  it('根证书文件缺失仍是用法错误退出 1（CLI_ROOT_FILE_NOT_FOUND）', async () => {
    const cwd = await createTempDir();
    const result = await verifyJson(join(cwd, 'missing.pem'), cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CLI_ROOT_FILE_NOT_FOUND');
  });

  it('根证书目录不可读/是目录：退出 1 且错误码稳定', async () => {
    const cwd = await createTempDir();
    const result = await verifyJson(cwd, cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/CLI_ROOT_FILE_(NOT_FOUND|UNREADABLE)/);
  });
});