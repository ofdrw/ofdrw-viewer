/** 真实 crypto inspect 的 UI 打开失败回归；不使用全局明文替身。 */
import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

vi.unmock('@ofdrw/ofdrw-viewer-crypto');

import { isCryptoError } from '@ofdrw/ofdrw-viewer-crypto';
import { OFDViewer } from '../../src/index';
import { installDomEnvironment } from '../helpers/environment';

/** 读取打开错误。 */
async function openError(source: ArrayBuffer | Uint8Array): Promise<unknown> {
  document.body.innerHTML = '';
  installDomEnvironment();
  const viewer = new OFDViewer({ container: document.body, source });
  return viewer.ready.catch((error: unknown) => error);
}

describe('真实 inspect 失败', () => {
  it('非 ZIP 输入映射 OFD_CRYPTO_FAILED 并保留 crypto cause', async () => {
    const error = (await openError(new Uint8Array([1, 2, 3, 4]))) as {
      code?: string;
      cause?: unknown;
    };
    expect(error.code).toBe('OFD_CRYPTO_FAILED');
    expect(isCryptoError(error.cause)).toBe(true);
  });

  it('缺失 OFD.xml 且加密元数据损坏的 ZIP 映射 OFD_CRYPTO_FAILED 并保留 cause', async () => {
    const zip = zipSync({ 'Encryptions.xml': strToU8('<Encryptions><EncryptInfo') });
    const error = (await openError(zip)) as { code?: string; cause?: unknown };
    expect(error.code).toBe('OFD_CRYPTO_FAILED');
    expect(isCryptoError(error.cause)).toBe(true);
  });
});
