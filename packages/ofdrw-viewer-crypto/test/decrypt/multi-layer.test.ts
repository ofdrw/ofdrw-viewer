/**
 * 多 EncryptInfo 层、明文 entriesmap 与层数上限。
 *
 * 仓库夹具没有嵌套加密层；这里用 crypto 自身的 SM4/KDF 构造一个包含两个
 * `EncryptInfo` 的等价包，验证逐层恢复 FEK、删除元数据与 `maxDecryptLayers`。
 */

import { describe, expect, it } from 'vitest';
import { zipSync, unzipSync } from 'fflate';
import {
  derivePasswordKey,
  inspect,
  openDecryptingContainer,
  sm4EncryptCbc,
  toBase64,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes } from '../core/fixtures';

/** 测试口令。 */
const PASSWORD = 'FixturePass123';

/** XML 头。 */
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** 构造参数。 */
interface BuildOptions {
  /** entriesmap 是否保持明文。 */
  readonly plaintextMap?: boolean;
}

/**
 * 把 XML 文本编码为字节。
 *
 * @param text XML 文本。
 * @returns UTF-8 字节。
 */
function xml(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 构造包含两个加密层的口令包。
 *
 * 第 1 层把所有明文条目加密为 `e1/<n>.dat`；第 2 层额外提供一个
 * `OFD2.xml`（内容为 OFD.xml 的副本），用于验证多层循环。
 *
 * @param options 构造选项。
 * @returns OFD 包字节。
 */
function buildTwoLayerPackage(options: BuildOptions = {}): Uint8Array {
  const plain = unzipSync(fixtureBytes('plain.ofd'));
  const fek = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const iv = Uint8Array.from({ length: 16 }, (_, index) => 0x10 + index);
  const fek2 = Uint8Array.from({ length: 16 }, (_, index) => 0x40 + index);
  const iv2 = Uint8Array.from({ length: 16 }, (_, index) => 0x60 + index);
  const kek = derivePasswordKey(PASSWORD);
  const encryptedWk = sm4EncryptCbc(fek, kek, iv);
  const encryptedWk2 = sm4EncryptCbc(fek2, kek, iv2);

  const files: Record<string, Uint8Array> = {};
  const mapEntries: string[] = [];
  let index = 0;
  for (const [path, bytes] of Object.entries(plain)) {
    const ePath = `e1/${index}.dat`;
    index += 1;
    files[ePath] = sm4EncryptCbc(bytes, fek, iv);
    mapEntries.push(`<ofd:EncryptEntry Path="/${path}" EPath="/${ePath}"/>`);
  }

  // 第 2 层的密文先按 fek2 加密，再由第 1 层包裹为 e2/ofd2.dat；
  // 第 1 层解密后得到内层密文，第 2 层继续解出 OFD2.xml。
  const innerCipher = sm4EncryptCbc(plain['OFD.xml'] as Uint8Array, fek2, iv2);
  files['e2/ofd2.dat'] = sm4EncryptCbc(innerCipher, fek, iv);
  mapEntries.push('<ofd:EncryptEntry Path="/e2/ofd2.dat" EPath="/e2/ofd2.dat"/>');

  const map1 = `${XML_HEAD}<ofd:EncryptEntries xmlns:ofd="http://www.ofdspec.org/2016" ID="1">${mapEntries.join('')}</ofd:EncryptEntries>`;
  const map2 = `${XML_HEAD}<ofd:EncryptEntries xmlns:ofd="http://www.ofdspec.org/2016" ID="2"><ofd:EncryptEntry Path="/OFD2.xml" EPath="/e2/ofd2.dat"/></ofd:EncryptEntries>`;
  files['entriesmap.dat'] = options.plaintextMap ? xml(map1) : sm4EncryptCbc(xml(map1), fek, iv);
  files['entriesmap2.dat'] = options.plaintextMap ? xml(map2) : sm4EncryptCbc(xml(map2), fek2, iv2);

  const seed = `${XML_HEAD}<ofd:DecyptSeed xmlns:ofd="http://www.ofdspec.org/2016" ID="1"><ofd:UserInfo UserName="fixture-password-user"><ofd:IVValue>${toBase64(iv)}</ofd:IVValue><ofd:EncryptedWK>${toBase64(encryptedWk)}</ofd:EncryptedWK></ofd:UserInfo></ofd:DecyptSeed>`;
  files['decryptseed.dat'] = xml(seed);
  const seed2 = `${XML_HEAD}<ofd:DecyptSeed xmlns:ofd="http://www.ofdspec.org/2016" ID="2"><ofd:UserInfo UserName="fixture-password-user"><ofd:IVValue>${toBase64(iv2)}</ofd:IVValue><ofd:EncryptedWK>${toBase64(encryptedWk2)}</ofd:EncryptedWK></ofd:UserInfo></ofd:DecyptSeed>`;
  files['decryptseed2.dat'] = xml(seed2);

  const encryptions = `${XML_HEAD}<ofd:Encryptions xmlns:ofd="http://www.ofdspec.org/2016"><ofd:EncryptInfo ID="1"><ofd:DecryptSeedLoc>/decryptseed.dat</ofd:DecryptSeedLoc><ofd:EntriesMapLoc>/entriesmap.dat</ofd:EntriesMapLoc></ofd:EncryptInfo><ofd:EncryptInfo ID="2"><ofd:DecryptSeedLoc>/decryptseed2.dat</ofd:DecryptSeedLoc><ofd:EntriesMapLoc>/entriesmap2.dat</ofd:EntriesMapLoc></ofd:EncryptInfo></ofd:Encryptions>`;
  files['Encryptions.xml'] = xml(encryptions);

  return zipSync(files, { level: 0 });
}


/**
 * 构造根 `Encryptions.xml` 解密后出现下一层 `Nested/Encryptions.xml` 的包。
 *
 * 内层直接复用 `password-encrypted.ofd` 的全部条目；外层把内层条目重新加密，
 * 并把内层清单移动到 `Nested/`，用于验证新清单触发下一层。
 *
 * @returns 嵌套加密包字节。
 */
function buildNestedPackage(): Uint8Array {
  const inner = unzipSync(fixtureBytes('password-encrypted.ofd'));
  const outerFek = Uint8Array.from({ length: 16 }, (_, index) => 0x70 + index);
  const outerIv = Uint8Array.from({ length: 16 }, (_, index) => 0x80 + index);
  const outerKek = derivePasswordKey(PASSWORD);
  const remap = new Map([
    ['Encryptions.xml', 'Nested/Encryptions.xml'],
    ['decryptseed.dat', 'Nested/decryptseed.dat'],
    ['entriesmap.dat', 'Nested/entriesmap.dat'],
  ]);
  const files: Record<string, Uint8Array> = {};
  const mapEntries: string[] = [];
  let index = 0;
  for (const [path, bytes] of Object.entries(inner)) {
    if (path.endsWith('/')) continue;
    let target = remap.get(path) ?? path;
    let data = bytes;
    if (path === 'Encryptions.xml') {
      data = new TextEncoder().encode(
        new TextDecoder()
          .decode(bytes)
          .replaceAll('/decryptseed.dat', '/Nested/decryptseed.dat')
          .replaceAll('/entriesmap.dat', '/Nested/entriesmap.dat'),
      );
    }
    const ePath = `o/${index}.dat`;
    index += 1;
    files[ePath] = sm4EncryptCbc(data, outerFek, outerIv);
    mapEntries.push(`<ofd:EncryptEntry Path="/${target}" EPath="/${ePath}"/>`);
  }
  const outerMap = `${XML_HEAD}<ofd:EncryptEntries xmlns:ofd="http://www.ofdspec.org/2016" ID="1">${mapEntries.join('')}</ofd:EncryptEntries>`;
  files['entriesmap.dat'] = sm4EncryptCbc(xml(outerMap), outerFek, outerIv);
  const outerSeed = `${XML_HEAD}<ofd:DecyptSeed xmlns:ofd="http://www.ofdspec.org/2016" ID="1"><ofd:UserInfo UserName="fixture-password-user"><ofd:IVValue>${toBase64(outerIv)}</ofd:IVValue><ofd:EncryptedWK>${toBase64(sm4EncryptCbc(outerFek, outerKek, outerIv))}</ofd:EncryptedWK></ofd:UserInfo></ofd:DecyptSeed>`;
  files['decryptseed.dat'] = xml(outerSeed);
  files['Encryptions.xml'] = xml(
    `${XML_HEAD}<ofd:Encryptions xmlns:ofd="http://www.ofdspec.org/2016"><ofd:EncryptInfo ID="outer"><ofd:DecryptSeedLoc>/decryptseed.dat</ofd:DecryptSeedLoc><ofd:EntriesMapLoc>/entriesmap.dat</ofd:EntriesMapLoc></ofd:EncryptInfo></ofd:Encryptions>`,
  );
  return zipSync(files, { level: 0 });
}


/**
 * 构造下一层清单再次输出自身、形成循环的包。
 *
 * @returns 循环加密包字节。
 */
function buildCyclePackage(): Uint8Array {
  const outerFek = Uint8Array.from({ length: 16 }, (_, index) => 0x90 + index);
  const outerIv = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index);
  const innerFek = Uint8Array.from({ length: 16 }, (_, index) => 0xb0 + index);
  const innerIv = Uint8Array.from({ length: 16 }, (_, index) => 0xc0 + index);
  const kek = derivePasswordKey(PASSWORD);
  const innerEncryptions = xml(
    `${XML_HEAD}<ofd:Encryptions xmlns:ofd="http://www.ofdspec.org/2016"><ofd:EncryptInfo ID="inner"><ofd:DecryptSeedLoc>/Nested/decryptseed.dat</ofd:DecryptSeedLoc><ofd:EntriesMapLoc>/Nested/entriesmap.dat</ofd:EntriesMapLoc></ofd:EncryptInfo></ofd:Encryptions>`,
  );
  const innerSeed = xml(
    `${XML_HEAD}<ofd:DecyptSeed xmlns:ofd="http://www.ofdspec.org/2016" ID="inner"><ofd:UserInfo UserName="fixture-password-user"><ofd:IVValue>${toBase64(innerIv)}</ofd:IVValue><ofd:EncryptedWK>${toBase64(sm4EncryptCbc(innerFek, kek, innerIv))}</ofd:EncryptedWK></ofd:UserInfo></ofd:DecyptSeed>`,
  );
  const innerMap = xml(
    `${XML_HEAD}<ofd:EncryptEntries xmlns:ofd="http://www.ofdspec.org/2016" ID="inner"><ofd:EncryptEntry Path="/Nested/Encryptions.xml" EPath="/cycle.xml"/><ofd:EncryptEntry Path="/Nested/decryptseed.dat" EPath="/cycle.seed"/><ofd:EncryptEntry Path="/Nested/entriesmap.dat" EPath="/cycle.map"/></ofd:EncryptEntries>`,
  );
  const innerFiles: Record<string, Uint8Array> = {
    'Nested/Encryptions.xml': innerEncryptions,
    'Nested/decryptseed.dat': innerSeed,
    'Nested/entriesmap.dat': sm4EncryptCbc(innerMap, innerFek, innerIv),
    'cycle.xml': sm4EncryptCbc(innerEncryptions, innerFek, innerIv),
    'cycle.seed': sm4EncryptCbc(innerSeed, innerFek, innerIv),
    'cycle.map': sm4EncryptCbc(innerMap, innerFek, innerIv),
  };
  const files: Record<string, Uint8Array> = {};
  const mapEntries: string[] = [];
  let index = 0;
  for (const [path, bytes] of Object.entries(innerFiles)) {
    const ePath = `o/${index}.dat`;
    index += 1;
    files[ePath] = sm4EncryptCbc(bytes, outerFek, outerIv);
    mapEntries.push(`<ofd:EncryptEntry Path="/${path}" EPath="/${ePath}"/>`);
  }
  const outerMap = `${XML_HEAD}<ofd:EncryptEntries xmlns:ofd="http://www.ofdspec.org/2016" ID="outer">${mapEntries.join('')}</ofd:EncryptEntries>`;
  files['entriesmap.dat'] = sm4EncryptCbc(xml(outerMap), outerFek, outerIv);
  const outerSeed = `${XML_HEAD}<ofd:DecyptSeed xmlns:ofd="http://www.ofdspec.org/2016" ID="outer"><ofd:UserInfo UserName="fixture-password-user"><ofd:IVValue>${toBase64(outerIv)}</ofd:IVValue><ofd:EncryptedWK>${toBase64(sm4EncryptCbc(outerFek, kek, outerIv))}</ofd:EncryptedWK></ofd:UserInfo></ofd:DecyptSeed>`;
  files['decryptseed.dat'] = xml(outerSeed);
  files['Encryptions.xml'] = xml(
    `${XML_HEAD}<ofd:Encryptions xmlns:ofd="http://www.ofdspec.org/2016"><ofd:EncryptInfo ID="outer"><ofd:DecryptSeedLoc>/decryptseed.dat</ofd:DecryptSeedLoc><ofd:EntriesMapLoc>/entriesmap.dat</ofd:EntriesMapLoc></ofd:EncryptInfo></ofd:Encryptions>`,
  );
  return zipSync(files, { level: 0 });
}

describe('多加密层', () => {
  it('逐层解密多个 EncryptInfo 并产生多层的 warning', async () => {
    const result = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data: buildTwoLayerPackage() },
      credentials: { kind: 'password', userName: 'fixture-password-user', password: PASSWORD },
    });
    expect(result.layers).toHaveLength(2);
    expect(result.layers.map((layer) => layer.id)).toEqual(['1', '2']);
    expect(result.layers[0].entriesMapMode).toBe('encrypted');
    expect(result.warnings.map((warning) => warning.code)).toContain('W_CRYPTO_MULTI_LAYER');
    expect(result.container.has('OFD.xml')).toBe(true);
    expect(result.container.has('OFD2.xml')).toBe(true);
    expect(result.container.has('Encryptions.xml')).toBe(false);
    await result.container.close();
  });

  it('根清单解密后出现下一层 Nested/Encryptions.xml 时继续解密', async () => {
    const result = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data: buildNestedPackage() },
      credentials: { kind: 'password', userName: 'fixture-password-user', password: PASSWORD },
    });
    expect(result.layers).toHaveLength(2);
    expect(result.warnings.map((warning) => warning.code)).toContain('W_CRYPTO_MULTI_LAYER');
    expect(result.container.has('OFD.xml')).toBe(true);
    expect(result.container.has('Encryptions.xml')).toBe(false);
    expect(result.container.has('Nested/Encryptions.xml')).toBe(false);
    const ofd = new TextDecoder().decode(await result.container.read('OFD.xml'));
    expect(ofd).toContain('<ofd:OFD');
    await result.container.close();
  });

  it('下一层清单循环输出自身时抛 CRYPTO_LAYER_LOOP', async () => {
    await expect(
      openDecryptingContainer({
        source: { kind: 'arraybuffer', data: buildCyclePackage() },
        credentials: { kind: 'password', userName: 'fixture-password-user', password: PASSWORD },
      }),
    ).rejects.toMatchObject({ code: 'CRYPTO_LAYER_LOOP' });
  });

  it('层数超过 maxDecryptLayers 抛 CRYPTO_DECRYPT_LAYER_LIMIT', async () => {
    const data = buildTwoLayerPackage();
    await expect(
      inspect({ kind: 'arraybuffer', data }, { limits: { maxDecryptLayers: 1 } }),
    ).rejects.toMatchObject({ code: 'CRYPTO_DECRYPT_LAYER_LIMIT' });
    await expect(
      openDecryptingContainer({
        source: { kind: 'arraybuffer', data },
        credentials: { kind: 'password', userName: 'fixture-password-user', password: PASSWORD },
        limits: { maxDecryptLayers: 1 },
      }),
    ).rejects.toMatchObject({ code: 'CRYPTO_DECRYPT_LAYER_LIMIT' });
  });

  it('final inspect 前 onWarning 取消后拒绝，不返回明文容器', async () => {
    const controller = new AbortController();
    await expect(
      openDecryptingContainer({
        source: { kind: 'arraybuffer', data: buildTwoLayerPackage() },
        credentials: { kind: 'password', userName: 'fixture-password-user', password: PASSWORD },
        signal: controller.signal,
        onWarning: (warning) => {
          if (warning.code === 'W_CRYPTO_MULTI_LAYER') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });
  });

  it('entriesmap 为明文 XML 时产生 warning 并继续', async () => {
    const result = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data: buildTwoLayerPackage({ plaintextMap: true }) },
      credentials: { kind: 'password', userName: 'fixture-password-user', password: PASSWORD },
    });
    expect(result.layers[0].entriesMapMode).toBe('plaintext');
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_ENTRIES_MAP_PLAINTEXT',
    );
    expect(result.container.has('OFD.xml')).toBe(true);
    await result.container.close();
  });

  it('构造包的摘要与加密元数据不会泄漏到容器', async () => {
    const data = buildTwoLayerPackage();
    const result = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data },
      credentials: { kind: 'password', userName: 'fixture-password-user', password: PASSWORD },
    });
    const paths = result.container.list().map((meta) => meta.path);
    expect(paths.some((path) => path.endsWith('.dat'))).toBe(false);
    await result.container.close();
  });
});
