/**
 * 加密 OFD 只读检测（设计 §3.2）。
 *
 * 只解析 `Encryptions.xml`/`decryptseed.dat`/`Signatures.xml` 等结构，不解密
 * 条目、不解析 `SignedValue.dat`/`Seal.esl`、不产出明文。损坏或超限输入
 * 抛 `CryptoError`，不返回半真半假的数据。
 */

import type { VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { CryptoError } from './errors';
import type { CertificateSummary } from './types/certificate';
import { toCertificateSummary } from './cert/summary';
import type { CryptoOptions } from './types/options';
import type { CryptoSource } from './types/source';
import type { CryptoWarning } from './types/warnings';
import { createWarningCollector, type WarningCollector } from './util/warning';
import { resolveCryptoOptions, type ResolvedCryptoOptions } from './util/options';
import { throwIfAborted } from './util/argument';
import {
  closeQuietly,
  mapEngineError,
  openCryptoContainer,
  type EntrySnapshot,
} from './source';
import { dirnameVirtualPath, resolveVirtualPath } from './container/paths';
import {
  parseDecryptSeed,
  parseEncryptions,
  readXmlElement,
  type ParsedEncryptionLayer,
  type ParsedSeedUser,
} from './decrypt/encryption';
import {
  decodeUtf8Strict,
  parseXml,
  xmlAttr,
  xmlChildren,
  xmlFind,
} from './decrypt/xml';

/** 加密用户信息。 */
export interface EncryptionUserInfo {
  /** `UserInfo@UserName`。 */
  readonly userName: string;
  /** 由是否存在 `UserCert` 判定，不依赖 `EncryptCaseId`。 */
  readonly method: 'password' | 'certificate' | 'unknown';
  /** 证书摘要；仅 certificate 时存在。 */
  readonly certificate?: CertificateSummary;
}

/** 单个加密层摘要。 */
export interface EncryptionLayerInfo {
  /** 从 0 开始的层号。 */
  readonly layer: number;
  /** `EncryptInfo@ID`，缺失时 `layer-<n>`。 */
  readonly id: string;
  /** 加密时间。 */
  readonly encryptDate?: string;
  /** 加密范围（诊断字段）。 */
  readonly encryptScope?: string;
  /** decryptseed 路径（无前导 `/`）。 */
  readonly decryptSeedPath: string;
  /** entriesmap 路径（无前导 `/`）。 */
  readonly entriesMapPath: string;
  /** 本层用户。 */
  readonly users: readonly EncryptionUserInfo[];
}

/** `Signatures.xml` 中的签名条目摘要；不解析 SignedValue。 */
export interface SignatureEntrySummary {
  /** `Signature@ID`。 */
  readonly id: string;
  /** `Signature@Type`。 */
  readonly type: string;
  /** `Signature@BaseLoc`。 */
  readonly baseLoc: string;
  /** 约定的 SignedValue 路径；文件不存在时省略。 */
  readonly signedValuePath?: string;
}

/** `inspect` 结果。 */
export interface OfdInspection {
  /** 是否存在 `Encryptions.xml`。 */
  readonly encrypted: boolean;
  /** 原始包字节数，单位 byte。 */
  readonly packageSize: number;
  /** 包内文件条目数（不含目录）。 */
  readonly entryCount: number;
  /** `OFD.xml@Version`；不可读时省略。 */
  readonly ofdVersion?: string;
  /** 从外到内的加密层；明文为空数组。 */
  readonly layers: readonly EncryptionLayerInfo[];
  /** 全部层用户去重视图。 */
  readonly users: readonly EncryptionUserInfo[];
  /** 签名条目摘要；不含 SignedValue 内容。 */
  readonly signatures: readonly SignatureEntrySummary[];
  /** 是否同时存在 `OFDEntries.xml` 与 `signedvalue.dat`。 */
  readonly integrityPresent: boolean;
  /** 检测过程中的 warning。 */
  readonly warnings: readonly CryptoWarning[];
}

/** 包内只读访问抽象。 */
export interface InspectionAccess {
  /** 原始包字节数，单位 byte。 */
  readonly packageSize: number;
  /** 全部规范化路径。 */
  readonly paths: readonly string[];
  /**
   * 判断路径是否存在。
   *
   * @param path 包内路径。
   * @returns 是否存在。
   */
  has(path: string): boolean;
  /**
   * 读取条目字节。
   *
   * @param path 包内路径。
   * @param maxBytes 最大字节数，单位 byte。
   * @param signal 取消信号。
   * @returns 字节。
   */
  read(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** 内部检测结果：公共 inspection + 解密所需的原始层/用户。 */
export interface InspectionDetails {
  /** 公共检测结果。 */
  readonly inspection: OfdInspection;
  /** 加密层原始结构；明文为空数组。 */
  readonly layers: readonly ParsedInspectionLayer[];
}

/** 原始层结构与用户。 */
export interface ParsedInspectionLayer {
  /** `Encryptions.xml` 解析结果。 */
  readonly info: ParsedEncryptionLayer;
  /** 本层用户。 */
  readonly users: readonly ParsedSeedUser[];
}

/**
 * 由 engine 容器构造访问器。
 *
 * @param container 容器。
 * @param limits 资源限制。
 * @returns 访问器。
 */
export function containerAccess(
  container: VirtualContainer,
  limits: ResolvedCryptoOptions['limits'],
): InspectionAccess {
  return {
    packageSize: container.packageSize,
    paths: container.list().map((meta) => meta.path),
    has(path) {
      return container.has(path);
    },
    async read(path, maxBytes, signal) {
      throwIfAborted(signal);
      try {
        const bytes = await container.read(path, { maxBytes, signal });
        throwIfAborted(signal);
        return bytes;
      } catch (error) {
        if (error instanceof CryptoError && error.code === 'CRYPTO_ABORTED') throw error;
        throw mapEngineError(error);
      }
    },
  };
}

/**
 * 由条目快照构造访问器。
 *
 * @param snapshot 条目快照。
 * @returns 访问器。
 */
export function snapshotAccess(
  snapshot: EntrySnapshot,
  fallbackSignal?: AbortSignal,
): InspectionAccess {
  return {
    packageSize: snapshot.packageSize,
    paths: [...snapshot.entries.keys()].sort(),
    has(path) {
      return snapshot.entries.has(path);
    },
    async read(path, maxBytes, signal) {
      throwIfAborted(signal ?? fallbackSignal);
      const bytes = snapshot.entries.get(path);
      if (!bytes) throw new CryptoError('CRYPTO_INVALID_PACKAGE', `包内条目不存在：${path}`);
      if (bytes.length > maxBytes) {
        throw new CryptoError('CRYPTO_LIMIT_EXCEEDED', `条目 ${path} 超过大小上限`);
      }
      throwIfAborted(signal ?? fallbackSignal);
      return bytes;
    },
  };
}

/**
 * 对访问器执行只读检测。
 *
 * @param access 访问器。
 * @param options 已解析选项。
 * @param collector warning 收集器。
 * @returns 检测详情。
 * @throws CryptoError 结构非法/超限时。
 */
export async function inspectAccess(
  access: InspectionAccess,
  options: ResolvedCryptoOptions,
  collector: WarningCollector,
): Promise<InspectionDetails> {
  throwIfAborted(options.signal);
  const limits = options.limits;
  const encrypted = access.has('Encryptions.xml');
  const layers: ParsedInspectionLayer[] = [];
  if (encrypted) {
    const encryptionsRoot = await readXmlElement(
      (path, maxBytes, signal) => access.read(path, maxBytes, signal),
      'Encryptions.xml',
      limits,
      options.signal,
    );
    if (!encryptionsRoot) {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'Encryptions.xml 不可读');
    }
    const infos = parseEncryptions(encryptionsRoot, limits.maxDecryptLayers);
    if (infos.length === 0) {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'Encryptions.xml 没有 EncryptInfo');
    }
    for (const info of infos) {
      if (!access.has(info.decryptSeedPath)) {
        throw new CryptoError(
          'CRYPTO_INVALID_PACKAGE',
          `加密层 ${info.id} 缺少 decryptseed：${info.decryptSeedPath}`,
        );
      }
      const seedRoot = await readXmlElement(
        (path, maxBytes, signal) => access.read(path, maxBytes, signal),
        info.decryptSeedPath,
        limits,
        options.signal,
      );
      if (!seedRoot) {
        throw new CryptoError('CRYPTO_INVALID_PACKAGE', `decryptseed 不可读：${info.decryptSeedPath}`);
      }
      const users = parseDecryptSeed(seedRoot, limits);
      layers.push({ info, users });
    }
  }

  const layerInfos: EncryptionLayerInfo[] = layers.map(({ info, users }) => ({
    layer: info.layer,
    id: info.id,
    encryptDate: info.encryptDate,
    encryptScope: info.encryptScope,
    decryptSeedPath: info.decryptSeedPath,
    entriesMapPath: info.entriesMapPath,
    users: users.map(toUserInfo),
  }));

  const users: EncryptionUserInfo[] = [];
  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();
  for (const layer of layers) {
    for (const user of layer.users) {
      const info = toUserInfo(user);
      // 重复用户名即使证书/方式相同也必须告警，然后再按键去重。
      if (seenNames.has(info.userName)) {
        collector.emit({
          code: 'W_CRYPTO_DUPLICATE_USER',
          message: `加密层存在重复用户名：${info.userName}`,
        });
      }
      seenNames.add(info.userName);
      const key = `${info.userName}\u0000${info.method}\u0000${info.certificate?.fingerprintSha256 ?? ''}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      users.push(info);
    }
  }

  // onWarning 可能在取消回调中触发 signal；继续读取前再次检查。
  throwIfAborted(options.signal);
  // 签名清单不因 Encryptions.xml 存在而整体丢弃；只有路径不可读时才视为空。
  const signatures = await readSignatures(access, limits, options.signal);
  const ofdVersion = await readOfdVersion(access, limits, options.signal);

  const inspection: OfdInspection = {
    encrypted,
    packageSize: access.packageSize,
    entryCount: access.paths.length,
    ofdVersion,
    layers: layerInfos,
    users,
    signatures,
    integrityPresent: access.has('OFDEntries.xml') && access.has('signedvalue.dat'),
    warnings: [...collector.warnings],
  };
  throwIfAborted(options.signal);
  return { inspection, layers };
}

/**
 * 把原始用户转换为公共摘要。
 *
 * @param user 原始用户。
 * @returns 公共用户信息。
 */
function toUserInfo(user: ParsedSeedUser): EncryptionUserInfo {
  if (user.method === 'certificate' && user.certificate) {
    return {
      userName: user.userName,
      method: 'certificate',
      certificate: toCertificateSummary(user.certificate),
    };
  }
  return { userName: user.userName, method: user.method };
}

/**
 * 读取 `Signatures.xml` 摘要。
 *
 * @param access 访问器。
 * @param limits 资源限制。
 * @param signal 取消信号。
 * @returns 签名摘要。
 */
async function readSignatures(
  access: InspectionAccess,
  limits: ResolvedCryptoOptions['limits'],
  signal?: AbortSignal,
): Promise<SignatureEntrySummary[]> {
  const result: SignatureEntrySummary[] = [];
  const paths = access.paths.filter(
    (path) => path === 'Signatures.xml' || path.endsWith('/Signatures.xml'),
  );
  for (const path of paths) {
    throwIfAborted(signal);
    let root;
    try {
      root = await readXmlElement(
        (entry, maxBytes, entrySignal) => access.read(entry, maxBytes, entrySignal),
        path,
        limits,
        signal,
      );
    } catch (error) {
      // 加密包中的签名清单可能只是可见路径但内容不可读；取消/资源上限仍向上抛。
      if (
        error instanceof CryptoError &&
        (error.code === 'CRYPTO_ABORTED' || error.code === 'CRYPTO_LIMIT_EXCEEDED')
      ) {
        throw error;
      }
      continue;
    }
    if (!root) continue;
    const container = root.localName === 'Signatures' ? root : xmlFind(root, 'Signatures');
    if (!container) throw new CryptoError('CRYPTO_INVALID_PACKAGE', `签名清单根元素非法：${path}`);
    xmlChildren(container, 'Signature').forEach((signature, index) => {
      const id = xmlAttr(signature, 'ID')?.trim();
      const type = xmlAttr(signature, 'Type')?.trim();
      const baseLoc = xmlAttr(signature, 'BaseLoc')?.trim();
      if (!id || !type || !baseLoc) {
        throw new CryptoError(
          'CRYPTO_INVALID_PACKAGE',
          `签名条目缺少 ID/Type/BaseLoc：${path}#${index + 1}`,
        );
      }
      let signedValuePath: string | undefined;
      try {
        const signaturePath = resolveVirtualPath(dirnameVirtualPath(path), baseLoc);
        const dir = dirnameVirtualPath(signaturePath);
        const candidate = dir.length > 0 ? `${dir}/SignedValue.dat` : 'SignedValue.dat';
        if (access.has(candidate)) signedValuePath = candidate;
      } catch {
        throw new CryptoError('CRYPTO_INVALID_PACKAGE', `签名 BaseLoc 非法：${baseLoc}`);
      }
      result.push({ id, type, baseLoc, signedValuePath });
    });
  }
  throwIfAborted(signal);
  return result;
}

/**
 * 读取 `OFD.xml@Version`。
 *
 * @param access 访问器。
 * @param limits 资源限制。
 * @param signal 取消信号。
 * @returns 版本号；不可读返回 undefined。
 */
async function readOfdVersion(
  access: InspectionAccess,
  limits: ResolvedCryptoOptions['limits'],
  signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfAborted(signal);
  if (!access.has('OFD.xml')) return undefined;
  try {
    const bytes = await access.read('OFD.xml', limits.maxAsn1Bytes, signal);
    throwIfAborted(signal);
    const root = parseXml(decodeUtf8Strict(bytes), {
      maxBytes: limits.maxAsn1Bytes,
      maxDepth: limits.maxAsn1Depth,
    });
    return xmlAttr(root, 'Version')?.trim() || undefined;
  } catch (error) {
    if (error instanceof CryptoError && error.code === 'CRYPTO_ABORTED') throw error;
    return undefined;
  }
}

/**
 * 只读检测加密文档。
 *
 * @param source 输入包。
 * @param options 限制/取消/warning。
 * @returns 加密层、用户、签名摘要与完整性存在性。
 * @throws CryptoError 输入损坏、超限或取消时。
 */
export async function inspect(source: CryptoSource, options?: CryptoOptions): Promise<OfdInspection> {
  const resolved = resolveCryptoOptions(options);
  const collector = createWarningCollector(resolved.onWarning);
  const container = await openCryptoContainer(source, resolved.limits, resolved.signal);
  try {
    const access = containerAccess(container, resolved.limits);
    const details = await inspectAccess(access, resolved, collector);
    throwIfAborted(resolved.signal);
    return details.inspection;
  } finally {
    await closeQuietly(container);
  }
}
