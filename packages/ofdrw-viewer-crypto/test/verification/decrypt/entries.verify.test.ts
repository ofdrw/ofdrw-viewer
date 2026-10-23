/**
 * V-DEC 独立验收：entriesmap 密文/明文兼容、路径映射、加密元数据过滤与
 * 同一 Encryptions.xml 内多个 EncryptInfo 的逐层解密。
 *
 * 测试包由 Node 内置 crypto（SM3/SM4-CBC）独立构造，不复用 crypto 包的
 * SM 实现；fixture 没有现成的多 EncryptInfo 样例。
 */

import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import {
  inspect,
  openDecryptingContainer,
  type CryptoCredential,
} from '@ofdrw/ofdrw-viewer-crypto';
import { codeOf, decryptBytes, fixtureBytes, readEntries } from './support';

/** XML 头。 */
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** 测试口令。 */
const PASSWORD = 'LayerPass123';

/** 16 byte 固定测试密钥。 */
const FEK_1 = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
/** 第二层 FEK。 */
const FEK_2 = Uint8Array.from({ length: 16 }, (_, index) => 0x31 + index);
/** 第一层 IV。 */
const IV_1 = Uint8Array.from({ length: 16 }, (_, index) => 0x10 + index);
/** 第二层 IV。 */
const IV_2 = Uint8Array.from({ length: 16 }, (_, index) => 0x50 + index);

/**
 * 字符串转 UTF-8。
 *
 * @param value 文本。
 * @returns 字节。
 */
function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * 拼接字节。
 *
 * @param parts 字节片段。
 * @returns 拼接结果。
 */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * 独立 SM3（Node OpenSSL 实现）。
 *
 * @param parts 字节片段。
 * @returns 32 byte 摘要。
 */
function sm3(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash('sm3');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

/**
 * GB/T 32918.3 KDF 派生 16 byte KEK。
 *
 * @param password 口令。
 * @returns KEK。
 */
function deriveKek(password: string): Uint8Array {
  return sm3(utf8(password), Uint8Array.of(0, 0, 0, 1)).slice(0, 16);
}

/**
 * 独立 SM4-CBC/PKCS#7 加密。
 *
 * @param plaintext 明文。
 * @param key 16 byte 密钥。
 * @param iv 16 byte IV。
 * @returns 密文。
 */
function encryptSm4(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const cipher = createCipheriv('sm4-cbc', key, iv);
  return concat(new Uint8Array(cipher.update(plaintext)), new Uint8Array(cipher.final()));
}

/**
 * base64 编码。
 *
 * @param bytes 字节。
 * @returns base64。
 */
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** 构造选项。 */
interface BuildOptions {
  /** 第一层 entriesmap 是否使用明文 XML。 */
  readonly plaintextMap?: boolean;
  /** 第二层 entriesmap 是否使用明文 XML。 */
  readonly plaintextSecondMap?: boolean;
  /** 是否在 Encryptions.xml 中声明两个层；默认 true。 */
  readonly twoLayers?: boolean;
}

/**
 * 用独立 SM 实现构造含两个 EncryptInfo 的等价加密包。
 *
 * 第 1 层用 FEK1/IV1 加密全部明文条目，并把第 2 层的内层密文
 * `e2/ofd2.dat` 原样保留（其自身由 FEK1 加密）；第 2 层用 FEK2/IV2
 * 把该内层密文解为 `OFD2.xml`。
 *
 * @param options 构造选项。
 * @returns ZIP 字节与期望明文条目表。
 */
function buildPackage(options: BuildOptions = {}): {
  readonly data: Uint8Array;
  readonly expected: Map<string, Uint8Array>;
} {
  const plain = unzipSync(fixtureBytes('plain.ofd'));
  const plainEntries = Object.entries(plain).filter(([path]) => !path.endsWith('/'));
  const kek = deriveKek(PASSWORD);
  const entries: Record<string, Uint8Array> = {};
  const map1: string[] = [];
  let index = 0;
  for (const [path, bytes] of plainEntries) {
    const ePath = `e1/${index}.dat`;
    index += 1;
    entries[ePath] = encryptSm4(bytes, FEK_1, IV_1);
    map1.push(`<ofd:EncryptEntry Path="/${path}" EPath="/${ePath}"/>`);
  }

  if (options.twoLayers !== false) {
    const innerCipher = encryptSm4(plain['OFD.xml'] as Uint8Array, FEK_2, IV_2);
    entries['e2/ofd2.dat'] = encryptSm4(innerCipher, FEK_1, IV_1);
    map1.push('<ofd:EncryptEntry Path="/e2/ofd2.dat" EPath="/e2/ofd2.dat"/>');
  }

  const mapText1 = `${XML_HEAD}<ofd:EncryptEntries xmlns:ofd="http://www.ofdspec.org/2016" ID="1">${map1.join('')}</ofd:EncryptEntries>`;
  const mapText2 = `${XML_HEAD}<ofd:EncryptEntries xmlns:ofd="http://www.ofdspec.org/2016" ID="2"><ofd:EncryptEntry Path="/OFD2.xml" EPath="/e2/ofd2.dat"/></ofd:EncryptEntries>`;
  entries['entriesmap.dat'] = options.plaintextMap
    ? utf8(mapText1)
    : encryptSm4(utf8(mapText1), FEK_1, IV_1);
  if (options.twoLayers !== false) {
    entries['entriesmap2.dat'] = options.plaintextSecondMap
      ? utf8(mapText2)
      : encryptSm4(utf8(mapText2), FEK_2, IV_2);
  }

  const seed1 = `${XML_HEAD}<ofd:DecyptSeed xmlns:ofd="http://www.ofdspec.org/2016" ID="1"><ofd:UserInfo UserName="layer-user"><ofd:IVValue>${b64(IV_1)}</ofd:IVValue><ofd:EncryptedWK>${b64(encryptSm4(FEK_1, kek, IV_1))}</ofd:EncryptedWK></ofd:UserInfo></ofd:DecyptSeed>`;
  entries['decryptseed.dat'] = utf8(seed1);
  if (options.twoLayers !== false) {
    const seed2 = `${XML_HEAD}<ofd:DecyptSeed xmlns:ofd="http://www.ofdspec.org/2016" ID="2"><ofd:UserInfo UserName="layer-user"><ofd:IVValue>${b64(IV_2)}</ofd:IVValue><ofd:EncryptedWK>${b64(encryptSm4(FEK_2, kek, IV_2))}</ofd:EncryptedWK></ofd:UserInfo></ofd:DecyptSeed>`;
    entries['decryptseed2.dat'] = utf8(seed2);
  }

  const second = options.twoLayers === false
    ? ''
    : '<ofd:EncryptInfo ID="2"><ofd:DecryptSeedLoc>/decryptseed2.dat</ofd:DecryptSeedLoc><ofd:EntriesMapLoc>/entriesmap2.dat</ofd:EntriesMapLoc></ofd:EncryptInfo>';
  entries['Encryptions.xml'] = utf8(
    `${XML_HEAD}<ofd:Encryptions xmlns:ofd="http://www.ofdspec.org/2016"><ofd:EncryptInfo ID="1"><ofd:DecryptSeedLoc>/decryptseed.dat</ofd:DecryptSeedLoc><ofd:EntriesMapLoc>/entriesmap.dat</ofd:EntriesMapLoc></ofd:EncryptInfo>${second}</ofd:Encryptions>`,
  );

  const expected = new Map<string, Uint8Array>(plainEntries);
  if (options.twoLayers !== false) expected.set('OFD2.xml', plain['OFD.xml'] as Uint8Array);
  return { data: zipSync(entries, { level: 0 }), expected };
}

/** 独立构造包的口令凭据。 */
const LAYER_CREDENTIAL: CryptoCredential = {
  kind: 'password',
  userName: 'layer-user',
  password: PASSWORD,
};

describe('entriesmap 与多层解密', () => {
  it('密文 entriesmap：逐层解密、路径映射与明文条目一致', async () => {
    const { data, expected } = buildPackage();
    const inspection = await inspect({ kind: 'arraybuffer', data });
    expect(inspection.encrypted).toBe(true);
    expect(inspection.layers).toHaveLength(2);
    expect(inspection.layers.map((layer) => layer.id)).toEqual(['1', '2']);

    const result = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data },
      credentials: LAYER_CREDENTIAL,
    });
    try {
      expect(result.layers).toHaveLength(2);
      expect(result.layers.map((layer) => layer.id)).toEqual(['1', '2']);
      expect(result.layers.map((layer) => layer.entriesMapMode)).toEqual([
        'encrypted',
        'encrypted',
      ]);
      expect(result.warnings.map((warning) => warning.code)).toContain('W_CRYPTO_MULTI_LAYER');
      const actual = await readEntries(result.container);
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [path, bytes] of expected) {
        expect(Buffer.compare(Buffer.from(actual.get(path)!), Buffer.from(bytes)), path).toBe(0);
      }
      expect(result.container.has('Encryptions.xml')).toBe(false);
      expect(result.container.has('decryptseed.dat')).toBe(false);
      expect(result.container.has('decryptseed2.dat')).toBe(false);
      expect(result.container.has('entriesmap.dat')).toBe(false);
      expect(result.container.has('entriesmap2.dat')).toBe(false);
      expect(result.container.list().some((meta) => meta.path.endsWith('.dat'))).toBe(false);
    } finally {
      await result.container.close();
    }
  });

  it('第一层 entriesmap 为明文 XML 时 warning 后继续', async () => {
    const { data, expected } = buildPackage({ plaintextMap: true });
    const result = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data },
      credentials: LAYER_CREDENTIAL,
    });
    try {
      expect(result.layers[0].entriesMapMode).toBe('plaintext');
      expect(result.warnings.map((warning) => warning.code)).toContain(
        'W_CRYPTO_ENTRIES_MAP_PLAINTEXT',
      );
      const actual = await readEntries(result.container);
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    } finally {
      await result.container.close();
    }
  });

  it('第二层 entriesmap 为明文 XML 时同样兼容', async () => {
    const { data, expected } = buildPackage({ plaintextSecondMap: true });
    const result = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data },
      credentials: LAYER_CREDENTIAL,
    });
    try {
      expect(result.layers[1].entriesMapMode).toBe('plaintext');
      const actual = await readEntries(result.container);
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    } finally {
      await result.container.close();
    }
  });

  it('单层包与多层包在 maxDecryptLayers 边界上行为正确', async () => {
    const single = buildPackage({ twoLayers: false });
    const singleResult = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data: single.data },
      credentials: LAYER_CREDENTIAL,
      limits: { maxDecryptLayers: 1 },
    });
    expect(singleResult.layers).toHaveLength(1);
    await singleResult.container.close();

    const two = buildPackage();
    expect(
      await codeOf(
        openDecryptingContainer({
          source: { kind: 'arraybuffer', data: two.data },
          credentials: LAYER_CREDENTIAL,
          limits: { maxDecryptLayers: 1 },
        }),
      ),
    ).toBe('CRYPTO_DECRYPT_LAYER_LIMIT');
    const twoResult = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data: two.data },
      credentials: LAYER_CREDENTIAL,
      limits: { maxDecryptLayers: 2 },
    });
    expect(twoResult.layers).toHaveLength(2);
    await twoResult.container.close();
  });

  it('entriesmap 覆盖加密元数据保留路径时拒绝', async () => {
    const { data } = buildPackage();
    // 在已构造的 ZIP 上把第一层 entriesmap 改为明文并注入保留路径，验证
    // parseEntriesMap 的保留路径检查；重新加密不可行，故直接修改明文形态。
    const zip = unzipSync(data);
    const malformedMap = `${XML_HEAD}<ofd:EncryptEntries xmlns:ofd="http://www.ofdspec.org/2016" ID="1"><ofd:EncryptEntry Path="/Encryptions.xml" EPath="/e1/0.dat"/></ofd:EncryptEntries>`;
    zip['entriesmap.dat'] = utf8(malformedMap) as Uint8Array<ArrayBuffer>;
    expect(
      await codeOf(
        decryptBytes(zipSync(zip, { level: 0 }), LAYER_CREDENTIAL),
      ),
    ).toBe('CRYPTO_ENTRY_MAP_INVALID');
  });
});
