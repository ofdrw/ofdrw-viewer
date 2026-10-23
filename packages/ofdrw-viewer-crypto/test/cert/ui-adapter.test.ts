/**
 * 类型边界测试：UI 的四态 `CertificateSource` 必须先由 UI 层读取成字节，
 * 再以设计 §3.1 的 `data`/`pem`/`der` 三态传给 crypto。
 *
 * 这里不 import UI 包，避免 crypto 反向依赖 UI；`UiCertificateSource`
 * 与 UI `options.ts` 的四态定义保持一致。
 */

import { describe, expect, it } from 'vitest';
import {
  loadCertificates,
  type CertificateInput,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes, fixtureText } from '../core/fixtures';

/** UI 层证书来源（四态）。 */
type UiCertificateSource =
  | { readonly data: ArrayBuffer | Uint8Array; readonly name?: string }
  | { readonly url: string; readonly headers?: Record<string, string>; readonly name?: string }
  | { readonly path: string; readonly name?: string }
  | { readonly filePath: string; readonly name?: string };

/** UI 层宿主加载器。 */
type UiCertificateLoader = (
  source: UiCertificateSource,
) => Uint8Array | ArrayBuffer | null | Promise<Uint8Array | ArrayBuffer | null>;

/**
 * 模拟 UI 侧适配：四态 → 字节 → crypto 三态。
 *
 * @param source UI 来源。
 * @param loader 宿主加载器。
 * @returns crypto 三态输入。
 */
async function adapt(
  source: UiCertificateSource,
  loader: UiCertificateLoader,
): Promise<CertificateInput> {
  if ('data' in source) return { data: source.data };
  const data = await loader(source);
  if (data === null) throw new Error('证书来源不可读');
  return { data };
}

const SIGNER_DER = fixtureBytes('certs', 'signer.crt.der');
const SIGNER_PEM = fixtureText('certs', 'signer.crt.pem');

describe('UI 四态到 crypto 三态适配', () => {
  it('data/url/path/filePath 均先转成 data 再进入 crypto', async () => {
    const loader: UiCertificateLoader = (source) => {
      if ('url' in source) return SIGNER_DER;
      if ('path' in source) return new TextEncoder().encode(SIGNER_PEM);
      if ('filePath' in source) return SIGNER_DER;
      return null;
    };
    const sources: readonly UiCertificateSource[] = [
      { data: SIGNER_DER, name: 'data' },
      { url: 'https://example.test/signer.cer', name: 'url' },
      { path: 'signer.crt', name: 'path' },
      { filePath: 'signer.crt', name: 'filePath' },
    ];

    for (const source of sources) {
      const input = await adapt(source, loader);
      expect(input).not.toHaveProperty('url');
      expect(input).not.toHaveProperty('path');
      expect(input).not.toHaveProperty('filePath');
      const [certificate] = await loadCertificates([input]);
      expect(certificate?.serialNumber).toBe('3e9');
    }
  });

  it('UI 不提供加载器时由 UI 明确失败，不把四态下沉给 crypto', async () => {
    const source: UiCertificateSource = { path: 'missing.crt' };
    await expect(adapt(source, () => null)).rejects.toThrowError(/不可读/);
    await expect(
      loadCertificates([source as unknown as CertificateInput]),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
  });
});
