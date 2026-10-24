/**
 * V-CLI 独立验证：info 只查询、verify 一次性验证、JSON/文本一致性与退出码。
 *
 * 期望值既来自夹具契约，也用 crypto 公共 API 的 inspect/verifyOfd 作独立
 * oracle，核对 CLI 的序列化、状态与提示没有歪曲底层结果。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect, toBase64, verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';
import type { CliInfoJson } from '../../src/info.js';
import type { CliVerifyJson } from '../../src/verify.js';
import {
  CERT_USER,
  ENCRYPT_KEY,
  FIXTURES,
  PASSWORD,
  PASSWORD_USER,
  ROOT_DER,
  ROOT_PEM,
  cleanupTempDirs,
  createTempDir,
  fixture,
  parseJson,
  runMain,
} from './support.js';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanupTempDirs);

/** 读取夹具字节并交给 crypto 作 oracle。 */
async function sourceOf(name: string) {
  return { kind: 'arraybuffer' as const, data: new Uint8Array(await readFile(fixture(name))) };
}

describe('V-CLI info：只查询、不解密、不验签', () => {
  it('明文包 JSON 固定字段与 crypto inspect 一致，文本携带相同摘要', async () => {
    const cwd = await createTempDir();
    const jsonResult = await runMain(['info', fixture('plain.ofd'), '--json'], cwd);
    expect(jsonResult.code).toBe(0);
    expect(jsonResult.stderr).toBe('');
    const payload = parseJson<CliInfoJson>(jsonResult.stdout);
    const oracle = await inspect(await sourceOf('plain.ofd'));

    expect(payload).toMatchObject({
      command: 'info',
      input: fixture('plain.ofd'),
      packageSize: oracle.packageSize,
      encrypted: false,
      layers: [],
      users: [],
      signatureCount: oracle.signatures.length,
      integrityPresent: oracle.integrityPresent,
      warnings: [],
    });
    if (oracle.ofdVersion === undefined) {
      expect(payload.ofdVersion).toBeUndefined();
    } else {
      expect(payload.ofdVersion).toBe(oracle.ofdVersion);
    }

    const text = await runMain(['info', fixture('plain.ofd')], cwd);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`文件: ${fixture('plain.ofd')}`);
    expect(text.stdout).toContain(`大小: ${payload.packageSize} B`);
    expect(text.stdout).toContain('加密: 否');
    expect(text.stdout).toContain('用户: 无');
    expect(text.stdout).toContain(`签名: ${payload.signatureCount}`);
    expect(text.stdout).toContain(`完整性: ${payload.integrityPresent ? '有' : '无'}`);
    expect(text.stdout).not.toContain('验证结果');
  });

  it('加密包无凭据也成功，显示层数/用户且不输出密文元数据', async () => {
    const cwd = await createTempDir();
    const result = await runMain(['info', fixture('password-encrypted.ofd')], cwd);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('加密: 是（1 层）');
    expect(result.stdout).toContain(`用户: ${PASSWORD_USER} (password)`);
    expect(result.stdout).toContain('签名: 0');
    expect(result.stdout).toContain('完整性: 无');
    expect(result.stdout).not.toContain('EncryptedWK');
    expect(result.stdout).not.toContain(PASSWORD);
    expect(result.stdout).not.toContain('验证结果');
    // 加密内容不可读：info 不得回显正文（夹具正文含以下中文）。
    expect(result.stdout).not.toContain('拿来主义');
    expect(result.stdout).not.toContain('鲁迅');
  });

  it('加密包 JSON 含层/用户摘要，不需要凭据且与 inspect 一致', async () => {
    const cwd = await createTempDir();
    const result = await runMain(['info', fixture('password-encrypted.ofd'), '--json'], cwd);
    expect(result.code).toBe(0);
    const payload = parseJson<CliInfoJson>(result.stdout);
    const oracle = await inspect(await sourceOf('password-encrypted.ofd'));
    expect(payload).toMatchObject({
      command: 'info',
      encrypted: true,
      layers: oracle.layers,
      users: oracle.users,
      signatureCount: 0,
      integrityPresent: false,
    });
    expect(payload.layers).toHaveLength(1);
    expect(payload.users[0]).toMatchObject({ userName: PASSWORD_USER, method: 'password' });
    expect(result.stderr).not.toContain('凭据');
    expect(result.stdout).not.toContain('EncryptedWK');
    expect(result.stdout).not.toContain('拿来主义');
    expect(result.stdout).not.toContain('鲁迅');
  });

  it('被篡改签名的包 info 仍退出 0 且只报摘要，证明不验签', async () => {
    const cwd = await createTempDir();
    const result = await runMain(['info', fixture('negative-tampered-content.ofd'), '--json'], cwd);
    expect(result.code).toBe(0);
    const payload = parseJson<CliInfoJson>(result.stdout);
    expect(payload.signatureCount).toBe(1);
    expect(payload.integrityPresent).toBe(false);
    expect(payload).not.toHaveProperty('overall');
    expect(payload).not.toHaveProperty('signatures');
    expect(result.stderr).not.toContain('CRYPTO_SIGNATURE_INVALID');
  });

  it('签名+完整性包只报告存在性，不输出验证结论', async () => {
    const cwd = await createTempDir();
    const result = await runMain(
      ['info', fixture('combined-signed-integrity.ofd'), '--json'],
      cwd,
    );
    expect(result.code).toBe(0);
    const payload = parseJson<CliInfoJson>(result.stdout);
    expect(payload.signatureCount).toBe(1);
    expect(payload.integrityPresent).toBe(true);
    expect(result.stdout).not.toContain('"overall"');
  });

  it('非法包 info 返回文档级 2 且 stdout 为空', async () => {
    const cwd = await createTempDir();
    const bad = join(cwd, 'bad.ofd');
    await writeFile(bad, 'not-a-zip');
    const result = await runMain(['info', bad, '--json'], cwd);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CRYPTO_INVALID_PACKAGE');
  });
});

describe('V-CLI verify：一次性完整性 + 签名 + 证书链', () => {
  it('配置根证书时有效签名退出 0，JSON 与文本一致且时间戳仅解析', async () => {
    const cwd = await createTempDir();
    const json = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', ROOT_PEM, '--json'],
      cwd,
    );
    expect(json.code).toBe(0);
    expect(json.stderr).toBe('');
    const payload = parseJson<CliVerifyJson>(json.stdout);
    expect(payload).toMatchObject({
      command: 'verify',
      input: fixture('signed-sesv4.ofd'),
    });
    expect(payload.report.overall).toBe('valid');
    expect(payload.report.rootsConfigured).toBe(true);
    expect(payload.report.package.encrypted).toBe(false);
    expect(payload.report.integrity).toBeNull();
    expect(payload.report.package.integrityPresent).toBe(false);
    expect(payload.report.signatures[0]).toMatchObject({
      id: 's001',
      status: 'valid',
      timestamp: { status: 'parsed-not-verified', note: '已解析，未验证' },
    });

    const oracle = await verifyOfd({
      source: await sourceOf('signed-sesv4.ofd'),
      roots: [new Uint8Array(await readFile(ROOT_DER))],
    });
    expect(payload.report.overall).toBe(oracle.overall);
    expect(payload.report.signatures.map((item) => item.status)).toEqual(
      oracle.signatures.map((item) => item.status),
    );
    expect(payload.report.signatures[0]?.certificate.status).toBe(
      oracle.signatures[0]?.certificate.status,
    );

    const text = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', ROOT_PEM],
      cwd,
    );
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('验证结果: valid');
    expect(text.stdout).toContain('完整性: 未保护');
    expect(text.stdout).toContain('签名 1: s001 valid');
    expect(text.stdout).toContain('时间戳: parsed-not-verified（已解析，未验证）');
    expect(text.stdout).toContain('根证书: 已配置 1 / 链 valid');
    expect(text.stdout).not.toContain('验证通过');
    expect(text.stdout).not.toContain('PASSWORD');
  });

  it('未配置根证书时链 unknown 但 overall=valid、退出 0，JSON 仍可机读且不误判 invalid', async () => {
    const cwd = await createTempDir();
    const json = await runMain(['verify', fixture('signed-sesv4.ofd'), '--json'], cwd);
    expect(json.code).toBe(0);
    const payload = parseJson<CliVerifyJson>(json.stdout);
    expect(payload.report.overall).toBe('valid');
    expect(payload.report.rootsConfigured).toBe(false);
    expect(payload.report.signatures[0]?.status).toBe('valid');
    expect(payload.report.signatures[0]?.certificate.status).toBe('unknown');
    expect(payload.report.signatures[0]?.references.status).toBe('valid');
    expect(json.stderr).toContain('W_CRYPTO_TRUST_UNKNOWN');

    const text = await runMain(['verify', fixture('signed-sesv4.ofd')], cwd);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('验证结果: valid');
    expect(text.stdout).toContain('根证书: 未配置 / 链 unknown');
    expect(text.stdout).toContain('证书链 unknown');
  });

  it('错误根证书链 incomplete 但 overall=valid、退出 0，PEM/DER 混用仍以正确根判定 valid', async () => {
    const cwd = await createTempDir();
    const wrongRoot = join(FIXTURES, 'certs', 'encrypt.crt.pem');
    const wrong = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', wrongRoot, '--json'],
      cwd,
    );
    expect(wrong.code).toBe(0);
    expect(parseJson<CliVerifyJson>(wrong.stdout).report).toMatchObject({
      overall: 'valid',
      signatures: [{ status: 'valid', certificate: { status: 'incomplete' } }],
    });
    const wrongText = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', wrongRoot],
      cwd,
    );
    expect(wrongText.code).toBe(0);
    expect(wrongText.stdout).toContain('根证书: 已配置 1 / 链 incomplete');

    const mixed = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', ROOT_PEM, '--root', ROOT_DER, '--json'],
      cwd,
    );
    expect(mixed.code).toBe(0);
    expect(parseJson<CliVerifyJson>(mixed.stdout).report).toMatchObject({
      overall: 'valid',
      rootsConfigured: true,
    });
    const mixedText = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', ROOT_PEM, '--root', ROOT_DER],
      cwd,
    );
    expect(mixedText.code).toBe(0);
    // 同一根以 PEM/DER 两条路径传入：文本按实际信任锚显示 1，而不是路径数 2。
    expect(mixedText.stdout).toContain('根证书: 已配置 1 / 链 valid');
  });

  it('--root 支持 Base64 文本与多证书 PEM bundle', async () => {
    const cwd = await createTempDir();
    const base64Path = join(cwd, 'root.b64');
    await writeFile(base64Path, toBase64(new Uint8Array(await readFile(ROOT_DER))));
    const base64 = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', base64Path, '--json'],
      cwd,
    );
    expect(base64.code).toBe(0);
    expect(parseJson<CliVerifyJson>(base64.stdout).report.overall).toBe('valid');

    const bundlePath = join(cwd, 'roots.pem');
    await writeFile(bundlePath, `${await readFile(ROOT_PEM, 'utf8')}\n${await readFile(ROOT_PEM, 'utf8')}`);
    const bundle = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', bundlePath],
      cwd,
    );
    expect(bundle.code).toBe(0);
    expect(bundle.stdout).toContain('根证书: 已配置 1 / 链 valid');
  });

  it('内容篡改与夹带文件均 invalid 退出 5，文本与 JSON 状态一致', async () => {
    const cwd = await createTempDir();
    for (const file of ['negative-tampered-content.ofd', 'negative-extra-file.ofd']) {
      const json = await runMain(
        ['verify', fixture(file), '--root', ROOT_PEM, '--json'],
        cwd,
      );
      expect(json.code, file).toBe(5);
      const payload = parseJson<CliVerifyJson>(json.stdout);
      expect(payload.report.overall, file).toBe('invalid');
      if (file === 'negative-extra-file.ofd') {
        expect(payload.report.integrity?.status).toBe('invalid');
        expect(payload.report.integrity?.extraFiles).toContain('evil.txt');
      } else {
        expect(payload.report.signatures[0]?.status).toBe('invalid');
      }

      const text = await runMain(['verify', fixture(file), '--root', ROOT_PEM], cwd);
      expect(text.code, file).toBe(5);
      expect(text.stdout, file).toContain('验证结果: invalid');
    }
  });

  it('加密口令文档在 verify 内解密并验证，不输出口令/密文元数据', async () => {
    const cwd = await createTempDir();
    const result = await runMain(
      [
        'verify',
        fixture('combined-password-encrypted.ofd'),
        '--user',
        PASSWORD_USER,
        '--password',
        PASSWORD,
        '--root',
        ROOT_PEM,
        '--json',
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    const payload = parseJson<CliVerifyJson>(result.stdout);
    expect(payload.report.overall).toBe('valid');
    expect(payload.report.package).toMatchObject({ encrypted: true, decrypted: true });
    expect(payload.report.decryption?.layers).toHaveLength(1);
    expect(result.stdout).not.toContain(PASSWORD);
    expect(result.stderr).not.toContain(PASSWORD);
    expect(result.stdout).not.toContain('EncryptedWK');

    const text = await runMain(
      [
        'verify',
        fixture('combined-password-encrypted.ofd'),
        '--user',
        PASSWORD_USER,
        '--password',
        PASSWORD,
        '--root',
        ROOT_PEM,
      ],
      cwd,
    );
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('解密: 已解密（1 层）');
    expect(text.stdout).toContain('验证结果: valid');
  });

  it('缺少/错误凭据返回 4，错误根路径返回 1，均不泄漏秘密', async () => {
    const cwd = await createTempDir();
    const missing = await runMain(
      ['verify', fixture('password-encrypted.ofd'), '--json'],
      cwd,
    );
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain('CRYPTO_CREDENTIALS_REQUIRED');

    const secret = 'WrongVerifySecret_741';
    const wrong = await runMain(
      [
        'verify',
        fixture('password-encrypted.ofd'),
        '--user',
        PASSWORD_USER,
        '--password',
        secret,
        '--json',
      ],
      cwd,
    );
    expect(wrong.code).toBe(4);
    expect(wrong.stderr).toContain('CRYPTO_WRONG_PASSWORD');
    expect(wrong.stderr).not.toContain(secret);
    expect(wrong.stdout).not.toContain(secret);

    const badRoot = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', join(cwd, 'missing.pem'), '--json'],
      cwd,
    );
    expect(badRoot.code).toBe(1);
    expect(badRoot.stderr).toContain('CLI_ROOT_FILE_NOT_FOUND');
  });

  it('证书加密文档无签名时 verify 为 not-applicable 退出 5（凭据仍被消费）', async () => {
    const cwd = await createTempDir();
    const result = await runMain(
      [
        'verify',
        fixture('cert-encrypted.ofd'),
        '--user',
        CERT_USER,
        '--key',
        ENCRYPT_KEY,
        '--json',
      ],
      cwd,
    );
    expect(result.code).toBe(5);
    const payload = parseJson<CliVerifyJson>(result.stdout);
    expect(payload.report.overall).toBe('not-applicable');
    expect(payload.report.package).toMatchObject({ encrypted: true, decrypted: true });
    expect(result.stderr).not.toContain('BEGIN PRIVATE KEY');
  });

  it('自定义 SM2 userId 使签名 invalid，JSON 可解析且不泄漏参数值', async () => {
    const cwd = await createTempDir();
    const result = await runMain(
      ['verify', fixture('signed-sesv4.ofd'), '--root', ROOT_PEM, '--sm2-user-id', 'wrong-user-id', '--json'],
      cwd,
    );
    expect(result.code).toBe(5);
    const payload = parseJson<CliVerifyJson>(result.stdout);
    expect(payload.report.overall).toBe('invalid');
    expect(payload.report.signatures[0]?.status).toBe('invalid');
    expect(result.stderr).toBe('');
  });
});
