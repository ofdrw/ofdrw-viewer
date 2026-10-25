import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { ZipReader } from '../../src/container/zip-reader';
import { parseXml } from '../../src/xml/parser';
import { decodeDocument } from '../../src/model/decode';
import { decodeSealImage } from '../../src/model/seal';
import {
  buildSignaturePageIndex,
  decodeSignature,
  decodeSignatureBundle,
  decodeSignaturesIndex,
  signatureIndexCandidates,
  signaturesFilePath,
} from '../../src/model/signature';
import type { OFDWarning } from '../../src/warnings';
import { node } from './xml';

/** 读取仓库根下的真实样例。 */
function samplePath(name: string): string {
  return fileURLToPath(new URL(`../../../../ofd_pdf_match/${name}`, import.meta.url));
}

/** 打开样例 ZIP 并解码签章集合。 */
async function openSampleSignatures(name: string) {
  const zip = await ZipReader.open(new ArrayBufferSource(readFileSync(samplePath(name))));
  const document = decodeDocument(
    parseXml(await zip.readEntry('Doc_0/Document.xml')),
    'Doc_0/Document.xml',
  );
  const warnings: OFDWarning[] = [];
  const documentPath = 'Doc_0/Document.xml';
  const indexFilePath = signatureIndexCandidates(documentPath).find((path) => zip.hasEntry(path));
  if (!indexFilePath) throw new Error(`${name} 缺少 Signatures.xml`);
  const index = parseXml(await zip.readEntry(indexFilePath));
  const bundle = await decodeSignatureBundle(
    {
      index,
      indexFilePath,
      pageIds: document.pages.map((page) => page.id),
      readFile: (path) => zip.readEntry(path),
    },
    { onWarning: (warning) => warnings.push(warning) },
  );
  return { document, bundle, warnings };
}

/** 直接解码一个真实 Signature.xml；不读取 Seal.esl/SignedValue.dat。 */
async function decodeSampleSignature(
  name: string,
  path: string,
  pageIds: readonly string[] = [],
) {
  const zip = await ZipReader.open(new ArrayBufferSource(readFileSync(samplePath(name))));
  try {
    return decodeSignature(parseXml(await zip.readEntry(path)), path, { pageIds });
  } finally {
    zip.close();
  }
}

/** 判断字节是否以指定 PNG 文件头开始。 */
function isPng(data: Uint8Array): boolean {
  return [0x89, 0x50, 0x4e, 0x47].every((byte, index) => data[index] === byte);
}

describe('签章模型（T14a）', () => {
  it('h.ofd：索引、StampAnnot、PageRef 映射与两枚 PNG 印章', async () => {
    const { document, bundle, warnings } = await openSampleSignatures('h.ofd');
    expect(document.pages.map((page) => page.id)).toEqual(['1', '21', '43', '63', '83']);
    expect(bundle.entries).toEqual([
      { id: 's001', type: 'Seal', baseLoc: 'Doc_0/Signs/Sign_0/Signature.xml' },
      { id: 's007', type: 'Seal', baseLoc: 'Doc_0/Signs/Sign_1/Signature.xml' },
    ]);
    expect(bundle.signatures).toHaveLength(2);

    const first = bundle.signatures[0]!;
    expect(first.sealFile).toBe('Doc_0/Signs/Sign_0/Seal.esl');
    expect(first.stamps).toHaveLength(5);
    expect(first.stamps.map((stamp) => stamp.pageId)).toEqual(['1', '21', '43', '63', '83']);
    expect(first.stamps.map((stamp) => stamp.pageIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(first.stamps[0]?.boundary).toEqual({ x: 202, y: 128.5, w: 40, h: 40 });
    expect(first.stamps[0]?.clip).toEqual({ x: 0, y: 0, w: 8, h: 40 });
    expect(first.stamps[4]?.clip).toEqual({ x: 32, y: 0, w: 8, h: 40 });
    expect(first.seal?.version).toBe('v4');
    expect(first.seal?.source).toBe('seal-esl');
    expect(first.seal?.cacheKey).toBeTruthy();
    expect(first.seal?.type).toBe('PNG');
    expect(first.seal?.width).toBe(40);
    expect(first.seal?.height).toBe(40);
    expect(first.seal && isPng(first.seal.data)).toBe(true);

    const second = bundle.signatures[1]!;
    expect(second.stamps).toEqual([
      expect.objectContaining({ pageId: '1', pageIndex: 0, boundary: { x: 50, y: 50, w: 40, h: 40 } }),
    ]);
    expect(second.seal?.version).toBe('v4');
    expect(second.seal?.type).toBe('PNG');
    expect(bundle.pageIndex[0]).toHaveLength(2);
    expect(Object.keys(bundle.pageIndex)).toEqual(['0', '1', '2', '3', '4']);
    expect(warnings).toEqual([]);
  });

  it('V4RideRight.ofd：一签章五戳记，印章尺寸 40×40 mm', async () => {
    const { bundle } = await openSampleSignatures('V4RideRight.ofd');
    expect(bundle.entries).toHaveLength(1);
    expect(bundle.signatures).toHaveLength(1);
    const signature = bundle.signatures[0]!;
    expect(signature.stamps).toHaveLength(5);
    expect(signature.stamps[0]?.boundary).toEqual({ x: 202, y: 40, w: 40, h: 40 });
    expect(signature.seal?.version).toBe('v4');
    expect(signature.seal?.type).toBe('PNG');
    expect(signature.seal?.width).toBe(40);
    expect(signature.seal?.height).toBe(40);
    expect(bundle.pageIndex[4]).toHaveLength(1);
  });

  it('keyword.ofd：StampAnnot 在 Signature 直下，Type=Sign 无 Seal 也能解析', async () => {
    const { bundle } = await openSampleSignatures('keyword.ofd');
    expect(bundle.entries).toEqual([
      { id: '2', type: 'Seal', baseLoc: 'Doc_0/Signs/Sign_1/Signature.xml' },
      { id: '4', type: 'Sign', baseLoc: 'Doc_0/Signs/Sign_3/Signature.xml' },
    ]);
    expect(bundle.signatures).toHaveLength(2);
    const sealSignature = bundle.signatures[0]!;
    expect(sealSignature.stamps).toHaveLength(1);
    expect(sealSignature.stamps[0]).toEqual(
      expect.objectContaining({
        id: '3',
        pageId: '1',
        pageIndex: 0,
        boundary: { x: 90, y: 110, w: 42, h: 42 },
      }),
    );
    expect(sealSignature.seal?.version).toBe('v4');
    expect(sealSignature.seal?.source).toBe('seal-esl');
    expect(sealSignature.seal?.type).toBe('PNG');
    expect(sealSignature.seal?.width).toBe(42);
    expect(sealSignature.seal?.height).toBe(42);
    expect(bundle.signatures[1]?.seal).toBeUndefined();
    expect(bundle.signatures[1]?.stamps).toEqual([]);
    expect(bundle.pageIndex[0]).toHaveLength(1);
  });

  it('n.ofd：索引在 Document.xml 同级 Signatures.xml，Seal 仍可解码', async () => {
    const { document, bundle } = await openSampleSignatures('n.ofd');
    expect(document.pages.map((page) => page.id)).toEqual(['1001', '1021']);
    expect(bundle.entries).toEqual([
      { id: '0', type: '', baseLoc: 'Doc_0/Signs/Sign_0/Signature.xml' },
    ]);
    const signature = bundle.signatures[0]!;
    expect(signature.stamps).toHaveLength(1);
    expect(signature.stamps[0]).toEqual(
      expect.objectContaining({ pageId: '1021', pageIndex: 1, boundary: { x: 122.94, y: 37, w: 33, h: 33 } }),
    );
    expect(signature.seal?.version).toBe('v1');
    expect(signature.seal?.source).toBe('seal-esl');
    expect(signature.seal?.type).toBe('PNG');
    expect(signature.seal?.width).toBe(33);
    expect(signature.seal?.height).toBe(33);
    expect(bundle.pageIndex[1]).toHaveLength(1);
  });

  it('不规范资源路径.ofd：无 Seal，从 SignValue.dat 的 SES_Signature 提取 PNG', async () => {
    const { bundle, warnings } = await openSampleSignatures('不规范资源路径.ofd');
    const signature = bundle.signatures[0]!;
    expect(signature.sealFile).toBeUndefined();
    expect(signature.signedValueFile).toBe('Doc_0/Signs/Sign_0/SignValue.dat');
    expect(signature.seal?.version).toBe('v4');
    expect(signature.seal?.source).toBe('signed-value');
    expect(signature.seal?.type).toBe('PNG');
    expect(signature.seal?.width).toBe(40);
    expect(signature.seal?.height).toBe(40);
    expect(signature.seal && isPng(signature.seal.data)).toBe(true);
    expect(signature.stamps[0]?.pageIndex).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('SignScaleError.ofd：SignedValue.dat 的 picture.type=ofd 提取内嵌 ZIP 并保留字节', async () => {
    const { bundle, warnings } = await openSampleSignatures('SignScaleError.ofd');
    const signature = bundle.signatures[0]!;
    expect(signature.seal?.version).toBe('v4');
    expect(signature.seal?.source).toBe('signed-value');
    expect(signature.seal?.type).toBe('OFD');
    expect(signature.seal?.width).toBe(34);
    expect(signature.seal?.height).toBe(26);
    const data = signature.seal?.data ?? new Uint8Array();
    expect(data.length).toBeGreaterThan(100);
    expect([0x50, 0x4b].every((byte, index) => data[index] === byte)).toBe(true);
    expect(signature.stamps[0]?.pageIndex).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('BUG-V2-03：发票示例 Sign_1 声明 gif 实为 PNG，按魔术字节纠正而非整枚丢失', async () => {
    const { bundle, warnings } = await openSampleSignatures('发票示例.ofd');
    const signature = bundle.signatures.find((item) => item.id === '3');
    expect(signature).toBeDefined();
    expect(signature?.sealFile).toBeUndefined();
    expect(signature?.signedValueFile).toBe('Doc_0/Signs/Sign_1/SignedValue.dat');
    expect(signature?.seal?.source).toBe('signed-value');
    // SES_ESPictrueInfo 声明 gif，实际字节是 PNG；必须按魔术字节纠正。
    expect(signature?.seal?.type).toBe('PNG');
    const data = signature?.seal?.data ?? new Uint8Array();
    expect([0x89, 0x50, 0x4e, 0x47].every((byte, index) => data[index] === byte)).toBe(true);
    expect(signature?.seal?.width).toBe(18);
    expect(signature?.seal?.height).toBe(18);
    expect(warnings.some((warning) => warning.message.includes('声明为 GIF'))).toBe(true);
  });

  it('BUG-V2-03：声明类型与魔术字节不一致时以魔术字节为准并 warning', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const sealInfo = (declared: string, bytes: Uint8Array) =>
      seq(
        seq(ia5('ES'), int(4), ia5('V')),
        ia5('id'),
        seq(),
        seq(ia5(declared), octet(bytes), int(18), int(18)),
      );
    const warnings: OFDWarning[] = [];
    const image = decodeSealImage(seq(sealInfo('gif', png), seq()), {
      source: 'signed-value',
      onWarning: (warning) => warnings.push(warning),
    });
    expect(image?.type).toBe('PNG');
    expect(warnings.some((warning) => warning.message.includes('声明为 GIF，实际字节为 PNG'))).toBe(
      true,
    );

    // 声明与字节一致时不产生纠偏 warning。
    const consistent: OFDWarning[] = [];
    expect(
      decodeSealImage(seq(sealInfo('PNG', png), seq()), {
        onWarning: (warning) => consistent.push(warning),
      })?.type,
    ).toBe('PNG');
    expect(consistent.filter((warning) => warning.message.includes('按魔术字节'))).toEqual([]);

    // 声明为 OFD 但字节是位图时不改动声明，只保留原始字节（既有语义）。
    expect(decodeSealImage(seq(sealInfo('OFD', gif), seq()))?.type).toBe('OFD');
  });

  it('坏 Seal.esl/签名 XML warning 降级，不抛出', async () => {
    const warnings: OFDWarning[] = [];
    const options = { onWarning: (warning: OFDWarning) => warnings.push(warning) };
    expect(decodeSealImage(new Uint8Array([0x01, 0x02, 0x03]), options)).toBeUndefined();
    expect(decodeSealImage(new Uint8Array(0), options)).toBeUndefined();
    expect(warnings.some((warning) => warning.code === 'W_BAD_NUMBER')).toBe(true);
    expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(true);

    const rawPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const fallback = decodeSealImage(rawPng, options);
    expect(fallback?.version).toBe('unknown');
    expect(fallback?.type).toBe('PNG');
    expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(true);

    const bundle = await decodeSignatureBundle(
      {
        index: node('Signatures', {}, [
          node('Signature', { ID: 'bad', Type: 'Seal', BaseLoc: '/Doc_0/Signs/Bad/Signature.xml' }),
        ]),
        indexFilePath: 'Doc_0/Signs/Signatures.xml',
        pageIds: ['1'],
        readFile: () => new Uint8Array([0x00]),
      },
      options,
    );
    expect(bundle.signatures).toEqual([]);
    expect(warnings.some((warning) => warning.code === 'W_BAD_NUMBER')).toBe(true);
  });

  it('索引/戳记容错：重复 ID、缺 BaseLoc、未知 PageRef', async () => {
    const warnings: OFDWarning[] = [];
    const options = { onWarning: (warning: OFDWarning) => warnings.push(warning) };
    const entries = decodeSignaturesIndex(
      node('Signatures', {}, [
        node('Signature', { ID: 's1', Type: 'Seal', BaseLoc: '/Doc_0/Signs/Sign_0/Signature.xml' }),
        node('Signature', { ID: 's1', Type: 'Seal', BaseLoc: '/Doc_0/Signs/Sign_1/Signature.xml' }),
        node('Signature', { ID: 's2', Type: 'Seal' }),
      ]),
      'Doc_0/Signs/Signatures.xml',
      options,
    );
    expect(entries.map((entry) => entry.id)).toEqual(['s1']);
    expect(warnings.some((warning) => warning.code === 'W_DUPLICATE_RESOURCE')).toBe(true);
    expect(warnings.some((warning) => warning.code === 'W_BAD_NUMBER')).toBe(true);

    const signature = decodeSignature(
      node('Signature', {}, [
        node('StampAnnot', { ID: 'a1', PageRef: '99', Boundary: '1 2 3 4' }),
        node('StampAnnot', { ID: 'a2', PageRef: '1', Boundary: 'bad' }),
      ]),
      'Doc_0/Signs/Sign_0/Signature.xml',
      { id: 's1', pageIds: ['1'] },
    );
    expect(signature.stamps).toHaveLength(1);
    const pageIndex = buildSignaturePageIndex([signature], ['1'], options);
    expect(pageIndex[0]).toBeUndefined();
    expect(warnings.some((warning) => warning.code === 'W_BAD_PATH')).toBe(true);
  });

  it('合成 v1/v4/v5 与 SES_Signature 结构均可按 Header 版本识别', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const info = (version: number) =>
      seq(
        seq(ia5('ES'), int(version), ia5('V')),
        ia5('id'),
        seq(),
        seq(ia5('PNG'), octet(png), int(30), int(40)),
      );
    const expectImage = (
      data: Uint8Array,
      version: 'v1' | 'v4' | 'v5',
      source: 'seal-esl' | 'signed-value' = 'seal-esl',
    ) => {
      const image = decodeSealImage(data, { source });
      expect(image?.version).toBe(version);
      expect(image?.source).toBe(source);
      expect(image?.cacheKey).toBeTruthy();
      expect(image?.type).toBe('PNG');
      expect(image?.width).toBe(30);
      expect(image?.height).toBe(40);
      return image!;
    };
    expectImage(seq(info(1), seq()), 'v1');
    expectImage(seq(info(4), octet(new Uint8Array([1])), octet(new Uint8Array([2])), octet(new Uint8Array([3]))), 'v4');
    expectImage(
      seq(info(5), octet(new Uint8Array([1])), octet(new Uint8Array([2])), octet(new Uint8Array([3])), octet(new Uint8Array([4]))),
      'v5',
    );
    // SES_Signature（SignedValue.dat）：顶层 2/4/5 字段，版本看 TBS_Sign[0]→eseal[1] 的 Header。
    expectImage(seq(seq(int(1), seq(info(1), seq())), octet(new Uint8Array([1]))), 'v1', 'signed-value');
    expectImage(
      seq(seq(int(4), seq(info(4), seq())), octet(new Uint8Array([1])), octet(new Uint8Array([2])), octet(new Uint8Array([3]))),
      'v4',
      'signed-value',
    );
    expectImage(
      seq(seq(int(5), seq(info(5), seq())), octet(new Uint8Array([1])), octet(new Uint8Array([2])), octet(new Uint8Array([3])), octet(new Uint8Array([4]))),
      'v5',
      'signed-value',
    );
  });

  it('picture.type=ofd 保留 ZIP 字节，来源与缓存 key 稳定', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const sealInfo = seq(
      seq(ia5('ES'), int(4), ia5('V')),
      ia5('id'),
      seq(),
      seq(ia5('ofd'), octet(zip), int(34), int(26)),
    );
    const data = seq(
      seq(int(4), seq(sealInfo, seq())),
      octet(new Uint8Array([9])),
      octet(new Uint8Array([8])),
      octet(new Uint8Array([7])),
    );
    const first = decodeSealImage(data, { source: 'signed-value' });
    const second = decodeSealImage(data, { source: 'signed-value' });
    expect(first?.version).toBe('v4');
    expect(first?.source).toBe('signed-value');
    expect(first?.type).toBe('OFD');
    expect(first?.width).toBe(34);
    expect(first?.height).toBe(26);
    expect(Array.from(first?.data ?? [])).toEqual(Array.from(zip));
    expect(first?.cacheKey).toBe(second?.cacheKey);
    expect(first?.cacheKey).not.toBe(decodeSealImage(data)?.cacheKey);

    const jpegInfo = seq(
      seq(ia5('ES'), int(4), ia5('V')),
      ia5('id'),
      seq(),
      seq(ia5('jpeg'), octet(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), int(10), int(20)),
    );
    const jpeg = decodeSealImage(
      seq(
        seq(int(4), seq(jpegInfo, seq())),
        octet(new Uint8Array([1])),
        octet(new Uint8Array([2])),
        octet(new Uint8Array([3])),
      ),
      { source: 'signed-value' },
    );
    expect(jpeg?.type).toBe('JPEG');
    expect(jpeg?.width).toBe(10);
    expect(jpeg?.height).toBe(20);
  });

  it('未知顶层结构 warning 并返回 undefined', () => {
    const warnings: OFDWarning[] = [];
    expect(decodeSealImage(seq(seq(), seq(), seq()), { onWarning: (warning) => warnings.push(warning) })).toBeUndefined();
    expect(warnings.some((warning) => warning.code === 'W_BAD_NUMBER')).toBe(true);
  });

  it('Signature.xml 元数据：Provider/时间/References/SignedValue 路径与多戳记顺序', async () => {
    const n = await decodeSampleSignature(
      'n.ofd',
      'Doc_0/Signs/Sign_0/Signature.xml',
      ['1001', '1021'],
    );
    expect(n.provider).toEqual({
      name: 'iOFD® 2.1.1 ©2019-2020 dms360.cn',
      company: 'dms360.cn',
      version: '2.1.1',
    });
    expect(n.signatureDateTime).toBe('2020-01-25 15:31:56');
    expect(n.references).toHaveLength(6);
    expect(n.references[0]).toEqual({ fileRef: '/Doc_0/Document.xml' });
    expect(n.references[5]).toEqual({ fileRef: '/Doc_0/Signs/Sign_0/Seal.esl' });
    expect(n.signedValuePath).toBe('Doc_0/Signs/Sign_0/SignedValue.dat');
    expect(n.signedValueFile).toBe(n.signedValuePath);
    expect(n.hasSignedValue).toBe(true);
    expect(n.stamps).toEqual([
      expect.objectContaining({ pageId: '1021', pageIndex: 1 }),
    ]);

    const v4 = await decodeSampleSignature('v4signed.ofd', 'Doc_0/Signs/Sign_0/Signature.xml');
    expect(v4.provider).toEqual({ name: 'gomain_eseal', company: 'BW', version: '2.0' });
    expect(v4.signatureDateTime).toBe('20201010151120');
    expect(v4.references).toHaveLength(13);
    expect(v4.references[0]).toEqual({ fileRef: '/Doc_0/Attachs/Attachments.xml' });
    expect(v4.signedValuePath).toBe('Doc_0/Signs/Sign_0/SignedValue.dat');
    expect(v4.hasSignedValue).toBe(true);

    const h = await decodeSampleSignature(
      'h.ofd',
      'Doc_0/Signs/Sign_0/Signature.xml',
      ['1', '21', '43', '63', '83'],
    );
    expect(h.provider).toEqual({ name: 'ofdrw-sign', company: 'ofdrw', version: '1.5.2' });
    expect(h.stamps.map((stamp) => stamp.id)).toEqual(['s002', 's003', 's004', 's005', 's006']);
    expect(h.stamps.map((stamp) => stamp.pageIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('Provider 子元素、SignedValue 的 BaseLoc 文本与包内规范化', () => {
    const signature = decodeSignature(
      node('Signature', { ID: 's1' }, [
        node('SignedInfo', {}, [
          node('Provider', {}, [
            node('ProviderName', {}, [], 'provider-child'),
            node('Company', {}, [], 'company-child'),
            node('Version', {}, [], '3.0'),
          ]),
          node('SignatureDateTime', {}, [], '2026-01-02 03:04:05'),
          node('References', {}, [
            node('Reference', { FileRef: '/Doc_0/b.xml' }),
            node('Reference', { FileRef: '/OFD.xml' }),
          ]),
          node('SignedValue', {}, [node('BaseLoc', {}, [], '/Doc_0/Signs/../Signs/Sign_0/SignedValue.dat')]),
        ]),
      ]),
      'Doc_0/Signs/Sign_0/Signature.xml',
    );
    expect(signature.provider).toEqual({
      name: 'provider-child',
      company: 'company-child',
      version: '3.0',
    });
    expect(signature.signatureDateTime).toBe('2026-01-02 03:04:05');
    expect(signature.references).toEqual([{ fileRef: '/Doc_0/b.xml' }, { fileRef: '/OFD.xml' }]);
    expect(signature.signedValuePath).toBe('Doc_0/Signs/Sign_0/SignedValue.dat');
    expect(signature.hasSignedValue).toBe(true);
  });

  it('缺 SignedValue 时 hasSignedValue=false，路径省略', () => {
    const signature = decodeSignature(
      node('Signature', { ID: 's1' }, [node('SignedInfo', {}, [node('Provider', { ProviderName: 'p' })])]),
      'Doc_0/Signs/Sign_0/Signature.xml',
    );
    expect(signature.provider).toEqual({ name: 'p' });
    expect(signature.references).toEqual([]);
    expect(signature.hasSignedValue).toBe(false);
    expect(signature.signedValuePath).toBeUndefined();
    expect(signature.signedValueFile).toBeUndefined();
    expect(signature.signatureDateTime).toBeUndefined();
  });

  it('StampAnnot 未匹配 PageRef 省略 pageIndex 并 warning；坏 Boundary 跳过', () => {
    const warnings: OFDWarning[] = [];
    const signature = decodeSignature(
      node('Signature', { ID: 's1' }, [
        node('StampAnnot', { ID: 'a1', PageRef: '99', Boundary: '1 2 3 4' }),
        node('StampAnnot', { ID: 'a2', PageRef: '1', Boundary: 'bad' }),
        node('StampAnnot', { ID: 'a3', PageRef: '1', Boundary: '5 6 7 8' }),
      ]),
      'Doc_0/Signs/Sign_0/Signature.xml',
      { id: 's1', pageIds: ['1'], onWarning: (warning) => warnings.push(warning) },
    );
    expect(signature.stamps).toHaveLength(2);
    expect(signature.stamps[0]?.pageIndex).toBeUndefined();
    expect(signature.stamps[1]).toEqual(expect.objectContaining({ id: 'a3', pageIndex: 0 }));
    expect(warnings.some((warning) => warning.code === 'W_BAD_PATH')).toBe(true);
    expect(warnings.some((warning) => warning.code === 'W_BAD_NUMBER')).toBe(true);
  });

  it('v5 Signature.xml 元数据与既有 Seal 解码共存', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const header = seq(ia5('ES'), int(5), ia5('V'));
    const sealInfo = seq(header, ia5('v5-id'), seq(), seq(ia5('PNG'), octet(png), int(30), int(40)));
    const sealBytes = seq(
      sealInfo,
      octet(new Uint8Array([1])),
      octet(new Uint8Array([2])),
      octet(new Uint8Array([3])),
      octet(new Uint8Array([4])),
    );
    const signatureXml = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signature xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:SignedInfo>
    <ofd:Provider ProviderName="v5-provider" Company="v5-company" Version="5.0"/>
    <ofd:SignatureDateTime>2026-08-04 10:08:09</ofd:SignatureDateTime>
    <ofd:References><ofd:Reference FileRef="/OFD.xml"/></ofd:References>
    <ofd:StampAnnot ID="v5-stamp" PageRef="1" Boundary="1 2 3 4"/>
    <ofd:Seal><ofd:BaseLoc>/Doc_0/Signs/Sign_0/Seal.esl</ofd:BaseLoc></ofd:Seal>
  </ofd:SignedInfo>
  <ofd:SignedValue>/Doc_0/Signs/Sign_0/SignedValue.dat</ofd:SignedValue>
</ofd:Signature>`;
    const bundle = await decodeSignatureBundle({
      index: node('Signatures', {}, [
        node('Signature', { ID: 's5', Type: 'Seal', BaseLoc: '/Doc_0/Signs/Sign_0/Signature.xml' }),
      ]),
      indexFilePath: 'Doc_0/Signs/Signatures.xml',
      pageIds: ['1'],
      readFile: (path) => {
        if (path.endsWith('Seal.esl')) return sealBytes;
        if (path.endsWith('Signature.xml')) return new TextEncoder().encode(signatureXml);
        throw new Error(`unexpected ${path}`);
      },
    });
    const signature = bundle.signatures[0]!;
    expect(signature.provider).toEqual({
      name: 'v5-provider',
      company: 'v5-company',
      version: '5.0',
    });
    expect(signature.signatureDateTime).toBe('2026-08-04 10:08:09');
    expect(signature.references).toEqual([{ fileRef: '/OFD.xml' }]);
    expect(signature.signedValuePath).toBe('Doc_0/Signs/Sign_0/SignedValue.dat');
    expect(signature.hasSignedValue).toBe(true);
    expect(signature.stamps[0]?.pageIndex).toBe(0);
    expect(signature.seal?.version).toBe('v5');
  });

  it('signaturesFilePath 支持 Document.xml 路径与目录；候选索引优先同级 Signatures.xml', () => {
    expect(signaturesFilePath('Doc_0/Document.xml')).toBe('Doc_0/Signs/Signatures.xml');
    expect(signaturesFilePath('Doc_0')).toBe('Doc_0/Signs/Signatures.xml');
    expect(signatureIndexCandidates('Doc_0/Document.xml')).toEqual([
      'Doc_0/Signatures.xml',
      'Doc_0/Signs/Signatures.xml',
    ]);
    expect(signatureIndexCandidates('Doc_0')).toEqual([
      'Doc_0/Signatures.xml',
      'Doc_0/Signs/Signatures.xml',
    ]);
  });
});
/** DER TLV 编码（测试用）。 */
function tlv(tag: number, content: Uint8Array): Uint8Array {
  const length = content.length;
  const prefix: number[] = [tag];
  if (length < 0x80) prefix.push(length);
  else {
    const bytes: number[] = [];
    let value = length;
    while (value > 0) {
      bytes.unshift(value & 0xff);
      value >>= 8;
    }
    prefix.push(0x80 | bytes.length, ...bytes);
  }
  const result = new Uint8Array(prefix.length + content.length);
  result.set(prefix);
  result.set(content, prefix.length);
  return result;
}

/** 拼接字节。 */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** DER SEQUENCE。 */
function seq(...parts: Uint8Array[]): Uint8Array {
  return tlv(0x30, concat(parts));
}

/** DER INTEGER。 */
function int(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value;
  do {
    bytes.unshift(current & 0xff);
    current >>= 8;
  } while (current > 0);
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0);
  return tlv(0x02, new Uint8Array(bytes));
}

/** DER IA5String。 */
function ia5(value: string): Uint8Array {
  return tlv(0x16, new Uint8Array([...value].map((char) => char.charCodeAt(0))));
}

/** DER OCTET STRING。 */
function octet(value: Uint8Array): Uint8Array {
  return tlv(0x04, value);
}
