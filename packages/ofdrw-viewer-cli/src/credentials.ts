/**
 * 加密凭据、输入源与信任根的 CLI 侧装载。
 *
 * 输入 OFD 以 `NodeFileByteSource` 随机访问源交给 crypto，不整包读取；
 * 密钥与证书仍按小文件一次读取。口令/私钥的解析、匹配与解密全部在
 * `@ofdrw/ofdrw-viewer-crypto` 内完成，CLI 不重复实现任何密码学逻辑。
 * 口令、私钥与 PEM 不会进入日志或错误消息。
 */

import { readFile, stat } from 'node:fs/promises';
import { looksLikePem } from '@ofdrw/ofdrw-viewer-crypto';
import type {
  CertificateInput,
  CryptoCredential,
  CryptoSource,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  CliError,
  EXIT_CODES,
  errorMessage,
  isErrnoError,
} from './errors.js';
import type { Logger } from './log.js';
import { NodeFileByteSource } from './node-file-source.js';

/**
 * 命令行解析后的凭据原始参数；路径已归一化为绝对路径。
 *
 * 各字段均为可选：是否组合合法由 `parseCliArgs` 校验，文件读取由
 * `buildCryptoCredential` 完成。
 */
export interface CliCredentialOptions {
  /** `--user` 指定的 OFD UserInfo 用户名。 */
  readonly user?: string;
  /** `--password` 口令（仅 password 用户）。 */
  readonly password?: string;
  /** `--key` SM2 私钥文件绝对路径（PEM/DER/PKCS#8）。 */
  readonly keyPath?: string;
  /** `--key-passphrase` 加密 PKCS#8 口令。 */
  readonly keyPassphrase?: string;
}

/**
 * 把文件读成 Uint8Array。
 *
 * @param filePath 文件绝对路径
 * @param options 错误码与面向用户的中文名称，如“私钥文件”
 * @returns 文件全部字节（独立副本，不共享 Buffer 池）
 * @throws {CliError} 文件不存在/不是文件/不可读时抛出（退出码 1）
 */
async function readFileBytes(
  filePath: string,
  options: {
    readonly label: string;
    readonly notFoundCode:
      | 'CLI_CREDENTIAL_FILE_NOT_FOUND'
      | 'CLI_ROOT_FILE_NOT_FOUND';
    readonly unreadableCode:
      | 'CLI_CREDENTIAL_FILE_UNREADABLE'
      | 'CLI_ROOT_FILE_UNREADABLE';
  },
): Promise<Uint8Array> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new CliError(
        options.notFoundCode,
        `${options.label}不是文件：${filePath}`,
        EXIT_CODES.USAGE,
      );
    }
    return new Uint8Array(await readFile(filePath));
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (isErrnoError(error, 'ENOENT')) {
      throw new CliError(
        options.notFoundCode,
        `${options.label}不存在：${filePath}`,
        EXIT_CODES.USAGE,
      );
    }
    throw new CliError(
      options.unreadableCode,
      `无法读取${options.label}：${filePath}（${errorMessage(error)}）`,
      EXIT_CODES.USAGE,
    );
  }
}

/** 已打开的 CLI 输入源；`byteSource` 归调用方所有，必须在用完后关闭。 */
export interface OpenedCryptoSource {
  /** 随机访问文件源；仍可被 engine 或 crypto 借用读取。 */
  readonly byteSource: NodeFileByteSource;
  /** 传给 crypto 的 `byte-source` 输入。 */
  readonly source: CryptoSource;
}

/**
 * 打开输入 OFD 并组装 crypto 随机访问源。
 *
 * 不读取整包：文件句柄交给 crypto/engine 按需读取。调用方拥有返回的
 * `byteSource`，必须在 crypto/engine 使用完毕（含异常与取消）后关闭。
 *
 * @param inputPath 输入文件绝对路径
 * @returns 文件字节源与 crypto 源
 * @throws {CliError} 文件不存在/不是文件/不可读时抛出（退出码 2，保持既有输入错误契约）
 */
export async function openCryptoSource(inputPath: string): Promise<OpenedCryptoSource> {
  try {
    const byteSource = await NodeFileByteSource.open(inputPath);
    return {
      byteSource,
      source: { kind: 'byte-source', source: byteSource },
    };
  } catch (error) {
    throw new CliError(
      'CLI_INPUT_UNREADABLE',
      `无法读取输入文件：${inputPath}（${errorMessage(error)}）`,
      EXIT_CODES.DOCUMENT,
    );
  }
}

/**
 * 关闭 CLI 输入源；失败只记 warning，不覆盖主流程结果。
 *
 * @param byteSource 已打开的输入源
 * @param logger 日志器
 */
export async function closeCryptoByteSource(
  byteSource: NodeFileByteSource,
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  try {
    await byteSource.close();
  } catch (error) {
    logger.warn('W_SOURCE_CLOSE_FAILED', `关闭输入文件失败：${errorMessage(error)}`);
  }
}

/**
 * 构造 crypto 凭据；未提供 `--password`/`--key` 时返回 `undefined`。
 *
 * 私钥文件按 UTF-8 解码判断是否为 PEM：是 PEM 时传 `pem`，否则传 `der`。
 * 口令只放在返回对象中，不写日志。
 *
 * @param options CLI 凭据参数
 * @returns 单条 crypto 凭据；无凭据时为 `undefined`
 * @throws {CliError} 私钥文件读取失败时抛出（退出码 1）
 */
export async function buildCryptoCredential(
  options: CliCredentialOptions | undefined,
): Promise<CryptoCredential | undefined> {
  if (options === undefined) return undefined;
  if (options.password !== undefined) {
    return {
      kind: 'password',
      ...(options.user === undefined ? {} : { userName: options.user }),
      password: options.password,
    };
  }
  if (options.keyPath === undefined) return undefined;

  const bytes = await readFileBytes(options.keyPath, {
    label: '私钥文件',
    notFoundCode: 'CLI_CREDENTIAL_FILE_NOT_FOUND',
    unreadableCode: 'CLI_CREDENTIAL_FILE_UNREADABLE',
  });
  const passphrase = options.keyPassphrase;
  const text = new TextDecoder().decode(bytes);
  const privateKey = looksLikePem(text)
    ? {
        pem: text,
        ...(passphrase === undefined ? {} : { passphrase }),
      }
    : {
        der: bytes,
        ...(passphrase === undefined ? {} : { passphrase }),
      };
  return {
    kind: 'private-key',
    ...(options.user === undefined ? {} : { userName: options.user }),
    privateKey,
  };
}

/**
 * 读取全部信任根证书。
 *
 * PEM 文件传 `pem` 文本，其余（DER/CER）传 `der` 字节；多证书 PEM 由
 * crypto 的证书加载器拆分。
 *
 * @param paths 根证书文件绝对路径列表
 * @returns crypto 证书输入数组；无根时为空数组
 * @throws {CliError} 任一文件不存在或不可读时抛出（退出码 1）
 */
export async function readTrustRoots(
  paths: readonly string[],
): Promise<readonly CertificateInput[]> {
  const roots: CertificateInput[] = [];
  for (const path of paths) {
    const bytes = await readFileBytes(path, {
      label: '根证书文件',
      notFoundCode: 'CLI_ROOT_FILE_NOT_FOUND',
      unreadableCode: 'CLI_ROOT_FILE_UNREADABLE',
    });
    const text = new TextDecoder().decode(bytes);
    roots.push(looksLikePem(text) ? { pem: text } : { der: bytes });
  }
  return roots;
}