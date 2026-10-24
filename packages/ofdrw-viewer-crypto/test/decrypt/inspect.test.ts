/**
 * `inspect`：明文/加密识别、层/用户摘要、签名与完整性、损坏输入。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { inspect, toBase64 } from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes } from '../core/fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 以数组缓冲构造输入。
 *
 * @param name fixture 名。
 * @returns CryptoSource。
 */
function source(name: string): { kind: 'arraybuffer'; data: Uint8Array } {
  return { kind: 'arraybuffer', data: fixtureBytes(name) };
}

/**
 * 修改加密包的 decryptseed.dat 后重新打包。
 *
 * @param name fixture 名。
 * @param mutate 修改 seed XML 文本。
 * @returns 包字节。
 */
function mutateSeed(name: string, mutate: (seed: string) => string): Uint8Array {
  const files = unzipSync(fixtureBytes(name));
  const seed = new TextDecoder().decode(files['decryptseed.dat']);
  files['decryptseed.dat'] = new TextEncoder().encode(mutate(seed));
  return zipSync(files, { level: 0 });
}

/**
 * 取 seed 中第一个 UserInfo XML 块。
 *
 * @param seed seed XML 文本。
 * @returns UserInfo 块。
 */
function firstUser(seed: string): string {
  const match = seed.match(/<ofd:UserInfo[\s\S]*?<\/ofd:UserInfo>/);
  if (!match) throw new Error('fixture 缺少 UserInfo');
  return match[0];
}

describe('inspect', () => {
  it('识别明文包并读取 OFD 版本', async () => {
    const result = await inspect(source('plain.ofd'));
    expect(result.encrypted).toBe(false);
    expect(result.layers).toEqual([]);
    expect(result.users).toEqual([]);
    expect(result.packageSize).toBe(fixtureBytes('plain.ofd').length);
    expect(result.entryCount).toBeGreaterThan(0);
    expect(result.ofdVersion).toBe('1.0');
    expect(result.integrityPresent).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('解析口令加密层和用户', async () => {
    const result = await inspect(source('password-encrypted.ofd'));
    expect(result.encrypted).toBe(true);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]).toMatchObject({
      layer: 0,
      id: '1',
      decryptSeedPath: 'decryptseed.dat',
      entriesMapPath: 'entriesmap.dat',
    });
    expect(result.layers[0].encryptDate).toBeTruthy();
    expect(result.users).toEqual([{ userName: 'fixture-password-user', method: 'password' }]);
    expect(result.signatures).toEqual([]);
    expect(result.integrityPresent).toBe(false);
  });

  it('解析证书加密用户并输出证书摘要', async () => {
    const result = await inspect(source('cert-encrypted.ofd'));
    expect(result.users).toHaveLength(1);
    const user = result.users[0];
    expect(user.userName).toBe('fixture-cert-user');
    expect(user.method).toBe('certificate');
    expect(user.certificate?.subject).toContain('Encrypt');
    expect(user.certificate?.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('汇总签名条目摘要但不解析 SignedValue', async () => {
    const result = await inspect(source('signed-sesv4.ofd'));
    expect(result.encrypted).toBe(false);
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0]).toMatchObject({
      id: 's001',
      type: 'Seal',
      baseLoc: '/Doc_0/Signs/Sign_0/Signature.xml',
      signedValuePath: 'Doc_0/Signs/Sign_0/SignedValue.dat',
    });
    expect(result.integrityPresent).toBe(false);
  });

  it('识别防夹带完整性文件', async () => {
    const result = await inspect(source('integrity.ofd'));
    expect(result.integrityPresent).toBe(true);
  });

  it('加密包中的明文 Signatures.xml 仍返回签名摘要', async () => {
    const files = unzipSync(fixtureBytes('password-encrypted.ofd'));
    files['Doc_0/Signs/Signatures.xml'] = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
        '<ofd:Signature ID="s-visible" Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>' +
        '</ofd:Signatures>',
    );
    files['Doc_0/Signs/Sign_0/SignedValue.dat'] = Uint8Array.of(1);
    const result = await inspect({ kind: 'arraybuffer', data: zipSync(files, { level: 0 }) });
    expect(result.encrypted).toBe(true);
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0]).toMatchObject({
      id: 's-visible',
      type: 'Seal',
      baseLoc: '/Doc_0/Signs/Sign_0/Signature.xml',
      signedValuePath: 'Doc_0/Signs/Sign_0/SignedValue.dat',
    });
  });

  it('非根 Signatures.xml 的相对 BaseLoc 按清单目录解析', async () => {
    const files = unzipSync(fixtureBytes('plain.ofd'));
    files['Doc_0/Signatures.xml'] = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
        '<ofd:Signature ID="nested" Type="Seal" BaseLoc="Sign_0/Signature.xml"/>' +
        '</ofd:Signatures>',
    );
    files['Doc_0/Sign_0/SignedValue.dat'] = Uint8Array.of(1);
    const result = await inspect({ kind: 'arraybuffer', data: zipSync(files, { level: 0 }) });
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0]?.signedValuePath).toBe('Doc_0/Sign_0/SignedValue.dat');
  });

  it('签名条目缺少 Type/BaseLoc 时只置空字段，不中断检测', async () => {
    const files = unzipSync(fixtureBytes('plain.ofd'));
    files['Doc_0/Signs/Signatures.xml'] = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
        '<ofd:Signature ID="no-type" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>' +
        '<ofd:Signature ID="no-baseloc" Type="Seal"/>' +
        '</ofd:Signatures>',
    );
    files['Doc_0/Signs/Sign_0/SignedValue.dat'] = Uint8Array.of(1);
    const result = await inspect({ kind: 'arraybuffer', data: zipSync(files, { level: 0 }) });
    expect(result.signatures).toEqual([
      {
        id: 'no-type',
        type: '',
        baseLoc: '/Doc_0/Signs/Sign_0/Signature.xml',
        signedValuePath: 'Doc_0/Signs/Sign_0/SignedValue.dat',
      },
      { id: 'no-baseloc', type: 'Seal', baseLoc: '', signedValuePath: undefined },
    ]);
  });

  it('真实样本缺 Type：检测成功、明文、type 空串且已解析 SignedValue', async () => {
    // 夹具 signatures-no-type.ofd 是仓库 ofd_pdf_match/draw_param_ref.ofd 的原样副本：
    // 其 Signatures.xml 为 <Signature ID="2" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>。
    const bytes = fixtureBytes('signatures-no-type.ofd');
    expect(bytes.length).toBeGreaterThan(0);
    const result = await inspect({ kind: 'arraybuffer', data: bytes });
    expect(result.encrypted).toBe(false);
    expect(result.users).toEqual([]);
    expect(result.signatures).toEqual([
      {
        id: '2',
        type: '',
        baseLoc: '/Doc_0/Signs/Sign_0/Signature.xml',
        signedValuePath: 'Doc_0/Signs/Sign_0/SignedValue.dat',
      },
    ]);
  });

  it('同时缺 ID/Type/BaseLoc 的签名条目只置空字段，不影响其他签名', async () => {
    const files = unzipSync(fixtureBytes('plain.ofd'));
    files['Doc_0/Signs/Signatures.xml'] = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
        '<ofd:Signature/>' +
        '<ofd:Signature ID="ok" Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>' +
        '</ofd:Signatures>',
    );
    files['Doc_0/Signs/Sign_0/SignedValue.dat'] = Uint8Array.of(1);
    const result = await inspect({ kind: 'arraybuffer', data: zipSync(files, { level: 0 }) });
    expect(result.signatures).toEqual([
      { id: '', type: '', baseLoc: '', signedValuePath: undefined },
      {
        id: 'ok',
        type: 'Seal',
        baseLoc: '/Doc_0/Signs/Sign_0/Signature.xml',
        signedValuePath: 'Doc_0/Signs/Sign_0/SignedValue.dat',
      },
    ]);
  });

  it('缺 ID 但 Type/BaseLoc 正常的签名条目保留空 ID，其他签名不受影响', async () => {
    const files = unzipSync(fixtureBytes('plain.ofd'));
    files['Doc_0/Signs/Signatures.xml'] = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
        '<ofd:Signature Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>' +
        '<ofd:Signature ID="second" Type="Sign" BaseLoc="/Doc_0/Signs/Sign_1/Signature.xml"/>' +
        '</ofd:Signatures>',
    );
    files['Doc_0/Signs/Sign_0/SignedValue.dat'] = Uint8Array.of(1);
    files['Doc_0/Signs/Sign_1/SignedValue.dat'] = Uint8Array.of(2);
    const result = await inspect({ kind: 'arraybuffer', data: zipSync(files, { level: 0 }) });
    expect(result.signatures).toEqual([
      {
        id: '',
        type: 'Seal',
        baseLoc: '/Doc_0/Signs/Sign_0/Signature.xml',
        signedValuePath: 'Doc_0/Signs/Sign_0/SignedValue.dat',
      },
      {
        id: 'second',
        type: 'Sign',
        baseLoc: '/Doc_0/Signs/Sign_1/Signature.xml',
        signedValuePath: 'Doc_0/Signs/Sign_1/SignedValue.dat',
      },
    ]);
  });

  it('缺 BaseLoc 的签名条目不推导 SignedValue，同清单其他签名仍解析', async () => {
    const files = unzipSync(fixtureBytes('plain.ofd'));
    files['Doc_0/Signatures.xml'] = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
        '<ofd:Signature ID="no-baseloc" Type="Seal"/>' +
        '<ofd:Signature ID="with-baseloc" Type="Seal" BaseLoc="Sign_1/Signature.xml"/>' +
        '</ofd:Signatures>',
    );
    files['Doc_0/Signatures/SignedValue.dat'] = Uint8Array.of(9);
    files['Doc_0/Sign_1/SignedValue.dat'] = Uint8Array.of(1);
    const result = await inspect({ kind: 'arraybuffer', data: zipSync(files, { level: 0 }) });
    expect(result.signatures).toEqual([
      { id: 'no-baseloc', type: 'Seal', baseLoc: '', signedValuePath: undefined },
      {
        id: 'with-baseloc',
        type: 'Seal',
        baseLoc: 'Sign_1/Signature.xml',
        signedValuePath: 'Doc_0/Sign_1/SignedValue.dat',
      },
    ]);
  });

  it('签名 BaseLoc 路径穿越仍抛 CRYPTO_INVALID_PACKAGE', async () => {
    const files = unzipSync(fixtureBytes('plain.ofd'));
    files['Doc_0/Signatures.xml'] = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
        '<ofd:Signature ID="bad" Type="Seal" BaseLoc="../../Signature.xml"/>' +
        '</ofd:Signatures>',
    );
    await expect(
      inspect({ kind: 'arraybuffer', data: zipSync(files, { level: 0 }) }),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_PACKAGE' });
  });

  it('签名清单 XML 超限不被吞掉，仍抛 CRYPTO_LIMIT_EXCEEDED', async () => {
    const bytes = fixtureBytes('plain.ofd');
    // 用极小上限让 Signatures.xml 读取直接超限：该错误必须穿透 readSignatures。
    await expect(
      inspect(
        {
          kind: 'arraybuffer',
          data: zipSync(
            {
              ...unzipSync(bytes),
              'Doc_0/Signs/Signatures.xml': new TextEncoder().encode(
                '<?xml version="1.0" encoding="UTF-8"?><ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016"/>',
              ),
            },
            { level: 0 },
          ),
        },
        { limits: { maxAsn1Bytes: 8 } },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
  });

  it('onWarning 取消后在 inspect 返回前抛出 CRYPTO_ABORTED', async () => {
    const data = mutateSeed('cert-encrypted.ofd', (seed) => {
      const user = firstUser(seed);
      return seed.replace('</ofd:DecyptSeed>', `${user}</ofd:DecyptSeed>`);
    });
    const controller = new AbortController();
    await expect(
      inspect(
        { kind: 'arraybuffer', data },
        { signal: controller.signal, onWarning: () => controller.abort() },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });
  });

  it('口令 EncryptedWK 非 SM4 块长返回 CRYPTO_INVALID_PACKAGE', async () => {
    const data = mutateSeed('password-encrypted.ofd', (seed) =>
      seed.replace(/<ofd:EncryptedWK>[^<]+<\/ofd:EncryptedWK>/, `<ofd:EncryptedWK>${toBase64(Uint8Array.of(1, 2, 3))}</ofd:EncryptedWK>`),
    );
    await expect(inspect({ kind: 'arraybuffer', data })).rejects.toMatchObject({
      code: 'CRYPTO_INVALID_PACKAGE',
    });
  });

  it('合并包中不可读的签名清单返回空数组', async () => {
    const result = await inspect(source('combined-password-encrypted.ofd'));
    expect(result.encrypted).toBe(true);
    expect(result.signatures).toEqual([]);
    expect(result.integrityPresent).toBe(false);
  });

  it('完全重复的 UserInfo 告警后去重', async () => {
    const data = mutateSeed('cert-encrypted.ofd', (seed) => {
      const user = firstUser(seed);
      return seed.replace('</ofd:DecyptSeed>', `${user}</ofd:DecyptSeed>`);
    });
    const result = await inspect({ kind: 'arraybuffer', data });
    expect(result.users).toHaveLength(1);
    expect(result.warnings.map((warning) => warning.code)).toContain('W_CRYPTO_DUPLICATE_USER');
  });

  it('同名不同证书的 UserInfo 告警但保留两条', async () => {
    const data = mutateSeed('cert-encrypted.ofd', (seed) => {
      const user = firstUser(seed);
      const alternative = user.replace(
        /<ofd:UserCert>[^<]+<\/ofd:UserCert>/,
        `<ofd:UserCert>${toBase64(fixtureBytes('certs', 'seal.crt.der'))}</ofd:UserCert>`,
      );
      return seed.replace('</ofd:DecyptSeed>', `${alternative}</ofd:DecyptSeed>`);
    });
    const result = await inspect({ kind: 'arraybuffer', data });
    expect(result.users).toHaveLength(2);
    expect(new Set(result.users.map((user) => user.userName)).size).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toContain('W_CRYPTO_DUPLICATE_USER');
  });

  it('URL 源无 content-length 也按流式上限拒绝 inspect', async () => {
    const bytes = fixtureBytes('plain.ofd');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 16));
        controller.enqueue(bytes.subarray(16));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', async () => new Response(stream));
    await expect(
      inspect(
        { kind: 'url', url: 'https://example.invalid/plain.ofd' },
        { limits: { maxSourceBytes: 32 } },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
  });

  it('损坏输入抛 CryptoError', async () => {
    await expect(
      inspect({ kind: 'arraybuffer', data: new TextEncoder().encode('not a zip') }),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_PACKAGE' });
  });

  it('输入大小超限抛 CryptoError', async () => {
    await expect(
      inspect(source('plain.ofd'), { limits: { maxSourceBytes: 8 } }),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
  });

  it('取消信号生效', async () => {
    await expect(
      inspect(source('plain.ofd'), { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });
  });
});
