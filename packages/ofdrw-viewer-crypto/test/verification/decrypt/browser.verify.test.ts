// @vitest-environment jsdom
/**
 * V-DEC 独立验收：jsdom 浏览器环境的基本解密/检测/engine 打开路径。
 *
 * 不依赖 Canvas/字体解码；验证浏览器可用的 Blob、ArrayBuffer、TextEncoder
 * 和 crypto 包无 node:* 运行时依赖的基本链路。
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import { inspect, openDecryptingContainer } from '@ofdrw/ofdrw-viewer-crypto';
import {
  PASSWORD_CREDENTIAL,
  certCredential,
  fixtureBytes,
  source,
} from './support';

/**
 * jsdom 的 TextEncoder/DecompressionStream 来自 Node 主 realm，输出
 * 的 Uint8Array 与 jsdom 模块 realm 不同，会让 `instanceof Uint8Array`
 * 这类跨 realm 检查失败。浏览器只有一个 realm，不需要这层适配；此处
 * 用同 realm 的 TextEncoder 并关闭 DecompressionStream（走 engine 的
 * fflate 回退）来模拟单 realm 浏览器。
 */
class SameRealmTextEncoder {
  /**
   * UTF-8 编码。
   *
   * @param text 文本。
   * @returns 同 realm 字节。
   */
  encode(text = ''): Uint8Array {
    return new Uint8Array(Buffer.from(text, 'utf8'));
  }
}

(globalThis as unknown as { TextEncoder: unknown }).TextEncoder = SameRealmTextEncoder;
(globalThis as unknown as { DecompressionStream: unknown }).DecompressionStream = undefined;

describe('jsdom 浏览器环境', () => {
  it('提供 DOM/Blob/TextEncoder 环境', () => {
    expect(typeof document).toBe('object');
    expect(typeof Blob).toBe('function');
    expect(typeof TextEncoder).toBe('function');
    expect(typeof AbortController).toBe('function');
  });

  it('口令加密检测与解密在 jsdom 可完成', async () => {
    const inspection = await inspect(source('password-encrypted.ofd'));
    expect(inspection.encrypted).toBe(true);
    expect(inspection.users[0]).toMatchObject({
      userName: 'fixture-password-user',
      method: 'password',
    });

    const result = await openDecryptingContainer({
      source: source('password-encrypted.ofd'),
      credentials: PASSWORD_CREDENTIAL,
    });
    try {
      expect(result.container.has('OFD.xml')).toBe(true);
      expect(result.container.encrypted).toBe(false);
      const ofd = new TextDecoder().decode(await result.container.read('OFD.xml'));
      expect(ofd).toContain('<ofd:OFD');
    } finally {
      await result.container.close();
    }
  });

  it('Blob 输入与证书私钥解密在 jsdom 可完成', async () => {
    const blob = new Blob([fixtureBytes('cert-encrypted.ofd').buffer as ArrayBuffer]);
    const result = await openDecryptingContainer({
      source: { kind: 'blob', blob },
      credentials: certCredential(),
    });
    try {
      expect(result.layers[0].user?.method).toBe('certificate');
      expect(result.container.has('OFD.xml')).toBe(true);
    } finally {
      await result.container.close();
    }
  });

  it('解密容器在 jsdom 交给 engine 打开并完成页面 prepare', async () => {
    const result = await openDecryptingContainer({
      source: source('password-encrypted.ofd'),
      credentials: PASSWORD_CREDENTIAL,
    });
    const doc = await OFDDocument.open({ container: result.container });
    try {
      expect(doc.pageCount).toBe(2);
      const metadata = await doc.getMetadata();
      expect(metadata.version).toBe('1.0');
      expect(metadata.pageCount).toBe(2);
      const infos = await doc.getPageInfos();
      expect(infos).toHaveLength(2);
      for (let index = 0; index < doc.pageCount; index += 1) {
        const page = await doc.getPage(index);
        expect(page.getSize()).toEqual({ width: 210, height: 297 });
        await expect(page.prepare()).resolves.toBeUndefined();
        await expect(page.getTextContent()).resolves.toMatchObject({ pageIndex: index });
      }
    } finally {
      await doc.close();
      await result.container.close();
    }
  });
});
