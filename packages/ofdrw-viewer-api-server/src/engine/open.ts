/**
 * 文档打开与资源生命周期。
 *
 * 提供两条入口：
 * - `openDocument`：已落盘的 OFD，经 `NodeFileByteSource` 随机访问打开；
 * - `openDocumentFromBytes`：内存字节，经 engine 的 `arraybuffer` 来源打开，
 *   供同步接口在不落盘的情况下完成解析。
 *
 * 打开前先用 crypto `inspect` 判断包内是否存在 `Encryptions.xml`，加密文档一律
 * 拒绝；打开时注入 Node Canvas、图片编码、解码插件、补充字体与 warning 回调。
 * 返回的 `close()` 幂等，按“文档 → 字节源”顺序释放资源。
 */

import { inspect } from '@ofdrw/ofdrw-viewer-crypto';
import type { CryptoWarningHandler, OfdInspection } from '@ofdrw/ofdrw-viewer-crypto';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import type {
  Canvas2DLike,
  FontInput,
  ImageDecoderPlugin,
  OFDWarning,
  PageImageFormat,
} from '@ofdrw/ofdrw-viewer-engine';
import { createCanvasLike, encodeCanvasImage } from './canvas.js';
import { nodeImageDecoders } from './decoder.js';
import type { FontFile } from './fonts.js';
import { loadFontInputs } from './fonts.js';
import { NodeFileByteSource, codedError } from './source.js';

/** 加密文档的固定错误文案（与设计 §5.1 示例一致）。 */
const ENCRYPTED_MESSAGE = '文档已加密，API 服务器不支持加密文档';

/**
 * 构造加密文档错误。
 *
 * @returns 带 `OFD_ENCRYPTED` 码的错误
 */
function encryptedError(): Error {
  return codedError('OFD_ENCRYPTED', ENCRYPTED_MESSAGE);
}

/** 打开文档的公共选项。 */
export interface OpenedDocumentCommonOptions {
  /** 已扫描好的字体文件（用户字体在前、系统字体在后）。 */
  readonly fontFiles: readonly FontFile[];
  /** 取消信号；中止时打开以 `OFD_ABORTED` 拒绝。 */
  readonly signal?: AbortSignal;
  /** engine warning 回调。 */
  readonly onWarning?: (warning: OFDWarning) => void;
  /** crypto 检测阶段 warning 回调。 */
  readonly onCryptoWarning?: CryptoWarningHandler;
}

/** 从已落盘文件打开文档的选项。 */
export interface OpenDocumentOptions extends OpenedDocumentCommonOptions {
  /** 已落盘的 OFD 文件路径。 */
  readonly filePath: string;
}

/** 从内存字节打开文档的选项。 */
export interface OpenDocumentFromBytesOptions extends OpenedDocumentCommonOptions {
  /** OFD 包字节；归调用方所有，engine 不修改。 */
  readonly data: Uint8Array;
}

/** 已打开的文档及其资源句柄。 */
export interface OpenedDocument {
  /** engine 文档实例。 */
  readonly document: OFDDocument;
  /** 页数。 */
  readonly pageCount: number;
  /** 原始包字节数，单位：byte。 */
  readonly packageSize: number;
  /**
   * 打开前的包级检测结果（加密层、用户、签名条目、完整性声明与 crypto warning）。
   *
   * 供 `/api/info` 直接复用，避免二次检测；不可用时为 `undefined`。
   */
  readonly inspection?: OfdInspection;
  /** 关闭文档与文件句柄；幂等，重复调用立即返回。 */
  close(): Promise<void>;
}

/** 注入 engine 的 Node 侧渲染能力。 */
interface EngineOpenOptions {
  /** 离屏画布工厂。 */
  readonly createCanvas: (width: number, height: number) => Canvas2DLike;
  /** 整页图片编码钩子。 */
  readonly encodeImage: (
    canvas: Canvas2DLike,
    format: PageImageFormat,
    quality: number,
  ) => Promise<Uint8Array>;
  /** PNG/JPEG/WebP 解码插件。 */
  readonly imageDecoders: ImageDecoderPlugin[];
  /** 补充字体；无字体时省略。 */
  readonly supplementaryFonts?: FontInput[];
  /** engine warning 回调。 */
  readonly onWarning?: (warning: OFDWarning) => void;
}

/**
 * 组装 engine 打开选项。
 *
 * 字体字节在打开前一次性读好；读取失败的字体被跳过。
 *
 * @param fontFiles 已扫描好的字体
 * @param onWarning engine warning 回调
 * @returns engine 公共打开选项
 */
async function createEngineOpenOptions(
  fontFiles: readonly FontFile[],
  onWarning: ((warning: OFDWarning) => void) | undefined,
): Promise<EngineOpenOptions> {
  const supplementaryFonts = await loadFontInputs(fontFiles);
  return {
    createCanvas: createCanvasLike,
    encodeImage: async (canvas, format, quality) => encodeCanvasImage(canvas, format, quality),
    imageDecoders: [...nodeImageDecoders],
    ...(supplementaryFonts.length === 0 ? {} : { supplementaryFonts }),
    ...(onWarning === undefined ? {} : { onWarning }),
  };
}

/**
 * 判断字节内容是否为加密包。
 *
 * 以 `inspect` 的 `encrypted` 字段为准；检测失败（包损坏等）时回退为扫描 ZIP
 * 中央目录文件名，只用于拒绝加密文档，不替代 engine 的包结构校验。
 *
 * @param data 包字节
 * @param signal 取消信号
 * @param onWarning crypto warning 回调
 * @returns 检测结果与是否加密；检测失败时结果省略
 * @throws 取消时抛出原取消错误
 */
async function inspectBytes(
  data: Uint8Array,
  signal: AbortSignal | undefined,
  onWarning: CryptoWarningHandler | undefined,
): Promise<{ encrypted: boolean; inspection?: OfdInspection }> {
  try {
    const inspection = await inspect(
      { kind: 'arraybuffer', data },
      { ...(signal === undefined ? {} : { signal }), ...(onWarning === undefined ? {} : { onWarning }) },
    );
    return { encrypted: inspection.encrypted, inspection };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { encrypted: bufferContainsEncryptionsXml(data) };
  }
}

/**
 * 在 ZIP 字节中查找 `Encryptions.xml` 文件名。
 *
 * 只按字节比较，不做解压；命中即视为加密包。
 *
 * @param data 包字节
 * @returns 命中时为 true
 */
function bufferContainsEncryptionsXml(data: Uint8Array): boolean {
  const needle = new TextEncoder().encode('Encryptions.xml');
  const last = data.length - needle.length;
  outer: for (let index = 0; index <= last; index += 1) {
    if (data[index] !== needle[0]) continue;
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (data[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * 构造幂等的关闭函数。
 *
 * 首次调用关闭文档并兜底关闭字节源，后续调用复用同一个 promise。
 *
 * @param document engine 文档
 * @param source 需要随文档释放的字节源；内存来源为 undefined
 * @returns 关闭函数
 */
function createCloseHandler(
  document: OFDDocument,
  source: NodeFileByteSource | undefined,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      try {
        await document.close();
      } finally {
        // engine 已关闭 custom source；这里幂等兜底，覆盖关闭提前抛错等路径。
        await closeSourceQuietly(source);
      }
    })();
    return closing;
  };
}

/**
 * 关闭字节源；未提供或关闭失败时静默，不覆盖调用方结论。
 *
 * @param source 字节源
 */
async function closeSourceQuietly(source: NodeFileByteSource | undefined): Promise<void> {
  if (source === undefined) return;
  try {
    await source.close();
  } catch {
    // 关闭失败不影响文档关闭结果。
  }
}

/**
 * 从已落盘文件打开 OFD。
 *
 * 加密文档在打开前拒绝；打开失败时自动释放文件句柄。
 *
 * @param options 文件路径、字体、取消信号与 warning 回调
 * @returns 已打开文档；调用方须在结束后调用 `close()`
 * @throws 带 `OFD_ENCRYPTED` 码的错误：加密文档
 * @throws 带 `CLI_INPUT_*` 码的错误：文件不存在、非文件或不可读
 * @throws OFDError：包结构非法、取消等
 */
export async function openDocument(options: OpenDocumentOptions): Promise<OpenedDocument> {
  const { filePath, fontFiles, signal, onWarning, onCryptoWarning } = options;
  const source = await NodeFileByteSource.open(filePath);
  try {
    const inspection = await inspect(
      { kind: 'byte-source', source },
      {
        ...(signal === undefined ? {} : { signal }),
        ...(onCryptoWarning === undefined ? {} : { onWarning: onCryptoWarning }),
      },
    );
    if (inspection.encrypted) throw encryptedError();

    const engineOptions = await createEngineOpenOptions(fontFiles, onWarning);
    const document = await OFDDocument.open({
      ...engineOptions,
      source: { kind: 'custom', source },
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      document,
      pageCount: document.pageCount,
      packageSize: inspection.packageSize,
      inspection,
      close: createCloseHandler(document, source),
    };
  } catch (error) {
    await closeSourceQuietly(source);
    throw error;
  }
}

/**
 * 从内存字节打开 OFD（同步接口用，不落盘）。
 *
 * 使用 engine 的 `arraybuffer` 来源；加密文档在打开前拒绝。
 *
 * @param options 包字节、字体、取消信号与 warning 回调
 * @returns 已打开文档；`packageSize` 为字节长度
 * @throws 带 `OFD_ENCRYPTED` 码的错误：加密文档
 * @throws OFDError：包结构非法、取消等
 */
export async function openDocumentFromBytes(
  options: OpenDocumentFromBytesOptions,
): Promise<OpenedDocument> {
  const { data, fontFiles, signal, onWarning, onCryptoWarning } = options;
  const inspection = await inspectBytes(data, signal, onCryptoWarning);
  if (inspection.encrypted) throw encryptedError();

  const engineOptions = await createEngineOpenOptions(fontFiles, onWarning);
  const document = await OFDDocument.open({
    ...engineOptions,
    source: { kind: 'arraybuffer', data },
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    document,
    pageCount: document.pageCount,
    packageSize: data.byteLength,
    ...(inspection.inspection === undefined ? {} : { inspection: inspection.inspection }),
    close: createCloseHandler(document, undefined),
  };
}
