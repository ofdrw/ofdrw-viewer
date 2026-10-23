/**
 * 类型边界测试：UI 的四态 `CertificateSource` 必须先由 UI 层读取成原始字节，
 * 再经 `certificatesToDer` 转换为逐张 DER 后传给 crypto。
 *
 * 这里不 import UI 包，避免 crypto 反向依赖 UI；`UiCertificateSource`
 * 与 UI `options.ts` 的四态定义保持一致。
 */

import { describe, expect, it } from 'vitest';
import {
  certificatesToDer,
  loadCertificates,
  type CertificateDer,
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
 * 模拟 UI 侧适配：四态 → 原始字节 → 逐张 DER。
 *
 * @param source UI 来源。
 * @param loader 宿主加载器。
 * @returns crypto 证书 DER 数组。
 */
async function adapt(
  source: UiCertificateSource,
  loader: UiCertificateLoader,
): Promise<readonly CertificateDer[]> {
  const raw =
    'data' in source
      ? source.data
      : await (async (): Promise<Uint8Array | ArrayBuffer> => {
          const loaded = await loader(source);
          if (loaded === null) throw new Error('证书来源不可读');
          return loaded;
        })();
  return certificatesToDer(raw);
}

const SIGNER_DER = fixtureBytes('certs', 'signer.crt.der');
const SIGNER_PEM = fixtureText('certs', 'signer.crt.pem');
const ROOT_PEM = fixtureText('certs', 'root-ca.crt.pem');

describe('UI 四态到 DER 适配', () => {
  it('data/url/path/filePath 均先转成 DER 再进入 crypto', async () => {
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
      const ders = await adapt(source, loader);
      expect(ders).toHaveLength(1);
      const [certificate] = await loadCertificates(ders);
      expect(certificate?.serialNumber).toBe('3e9');
    }
  });

  it('单个来源可返回 PEM 多证书并展开为多个根', async () => {
    const source: UiCertificateSource = { path: 'bundle.pem' };
    const ders = await adapt(source, () => new TextEncoder().encode(`${ROOT_PEM}\n${SIGNER_PEM}`));
    const certificates = await loadCertificates(ders);
    expect(certificates.map((certificate) => certificate.serialNumber)).toEqual(['3e8', '3e9']);
  });

  it('UI 不提供加载器时由 UI 明确失败，不把四态下沉给 crypto', async () => {
    const source: UiCertificateSource = { path: 'missing.crt' };
    await expect(adapt(source, () => null)).rejects.toThrowError(/不可读/);
    await expect(
      loadCertificates([source as unknown as CertificateDer]),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
  });
});