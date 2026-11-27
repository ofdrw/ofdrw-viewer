/**
 * 包验签：crypto `verifyOfd` 的服务器侧封装。
 *
 * 输入文件经 `NodeFileByteSource` 随机访问读取，验签结束后关闭句柄；
 * `verifyOfd` 只产出报告，不因验证未通过而抛错。
 */

import { verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';
import type { CertificateDer, VerificationReport } from '@ofdrw/ofdrw-viewer-crypto';
import { NodeFileByteSource } from './source.js';

/** 验签选项。 */
export interface VerifyPackageOptions {
  /** 信任根；每项一张证书 DER；省略表示未配置，链状态为 unknown。 */
  readonly roots?: readonly CertificateDer[];
  /** SM2 签名 userId；省略使用 crypto 默认标准值。 */
  readonly sm2UserId?: string;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 对已落盘的 OFD 执行完整性、签名与证书链验证。
 *
 * @param filePath OFD 文件路径
 * @returns 统一验证报告，结论见 `report.overall`
 * @throws 带 `CLI_INPUT_*` 码的错误：文件不存在或不可读
 * @throws CryptoError：包结构非法、根证书非法、取消等
 */
export async function verifyPackage(
  filePath: string,
  options: VerifyPackageOptions = {},
): Promise<VerificationReport> {
  const source = await NodeFileByteSource.open(filePath);
  try {
    return await verifyOfd({
      source: { kind: 'byte-source', source },
      ...(options.roots === undefined ? {} : { roots: options.roots }),
      ...(options.sm2UserId === undefined ? {} : { sm2UserId: options.sm2UserId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    try {
      await source.close();
    } catch {
      // 句柄关闭失败不覆盖验签结论。
    }
  }
}