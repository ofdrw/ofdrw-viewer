/**
 * 加密 OFD 解密流水线与明文容器工厂（设计 §4.1/§4.7/§4.8）。
 *
 * 明文包直接返回 source-backed ZIP 容器；加密包只按需读取 encryptseed/
 * entriesmap 与映射条目，逐层恢复 FEK，最后一次性构造只暴露明文的
 * `MemoryVirtualContainer`。任何一层失败都不返回部分明文容器。
 */

import type { VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { CryptoError } from '../errors';
import type { CryptoCredential } from '../types/credentials';
import type { CryptoOptions } from '../types/options';
import type { CryptoSource } from '../types/source';
import type { CryptoWarning } from '../types/warnings';
import type { CryptoLimits } from '../types/limits';
import { MemoryVirtualContainer } from '../container/memory-container';
import { normalizeCredentials, recoverLayerKey } from '../credentials';
import { resolveCryptoOptions } from '../util/options';
import { createWarningCollector, type WarningCollector } from '../util/warning';
import { sha256 } from '../util/hash';
import { toHex, zeroize } from '../util/bytes';
import { throwIfAborted } from '../util/argument';
import { sm4DecryptCbc } from '../sm/sm4';
import {
  parseDecryptSeed,
  parseEncryptions,
  type ParsedEncryptionLayer,
  type ParsedSeedUser,
} from './encryption';
import { parseEntriesMap, type EntryMapping } from './entries-map';
import { decodeUtf8Strict, parseXml } from './xml';
import { readEntry } from '../sign/read';
import {
  containerAccess,
  inspectAccess,
  snapshotAccess,
  type EncryptionUserInfo,
  type OfdInspection,
} from '../inspect';
import { closeQuietly, openCryptoContainer } from '../source';

/** 解密层摘要（设计 §3.3）。 */
export interface DecryptionLayerSummary {
  /** 从 0 开始的层号。 */
  readonly layer: number;
  /** 层 ID。 */
  readonly id: string;
  /** 本层命中的用户。 */
  readonly user?: EncryptionUserInfo;
  /** 本层解密并还原的文件数。 */
  readonly decryptedEntries: number;
  /** 本层删除的加密元数据路径。 */
  readonly removedMetadata: readonly string[];
  /** entriesmap 形态。 */
  readonly entriesMapMode: 'encrypted' | 'plaintext';
}

/** 解密容器结果（设计 §3.3）。 */
export interface DecryptingContainerResult {
  /** 明文容器；所有权转移给调用方，调用方负责 close。 */
  readonly container: VirtualContainer;
  /** 原始包检测结果（签名/完整性来自解密后明文）。 */
  readonly inspection: OfdInspection;
  /** 是否本来就是明文包。 */
  readonly plaintext: boolean;
  /** 逐层解密摘要。 */
  readonly layers: readonly DecryptionLayerSummary[];
  /** 解密过程 warning。 */
  readonly warnings: readonly CryptoWarning[];
}

/** `openDecryptingContainer` 选项。 */
export interface OpenDecryptingContainerOptions extends CryptoOptions {
  /** 输入包。 */
  readonly source: CryptoSource;
  /** 明文包可省略；加密包至少需要一个匹配凭据。 */
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
}

/** 单层应用结果。 */
interface AppliedLayer {
  /** 解密文件数。 */
  readonly decryptedEntries: number;
  /** 删除的元数据路径。 */
  readonly removedMetadata: readonly string[];
}

/**
 * 解密一个条目。
 *
 * @param bytes 密文字节。
 * @param fek 16 byte 文件密钥。
 * @param iv 16 byte IV。
 * @param path 目标路径（用于错误信息）。
 * @returns 明文字节。
 * @throws CryptoError `CRYPTO_ENTRY_MAP_INVALID`。
 */
function decryptEntry(
  bytes: Uint8Array,
  fek: Uint8Array,
  iv: Uint8Array,
  path: string,
): Uint8Array {
  try {
    return sm4DecryptCbc(bytes, fek, iv);
  } catch {
    throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', `条目解密失败：${path}`);
  }
}

/**
 * 按需条目视图。
 *
 * 原始条目只在需要时从 ZIP 容器读取；已解密条目覆盖同名原始条目。
 * `remove()` 仅隐藏路径，不触发读取，因此未映射的大条目不会被预先装入内存。
 */
class LazyEntryStore {
  /** 原始包字节数，单位 byte。 */
  readonly packageSize: number;

  private readonly container: VirtualContainer;
  private readonly limits: CryptoLimits;
  private readonly signal?: AbortSignal;
  private readonly sourcePaths: ReadonlySet<string>;
  private readonly removed = new Set<string>();
  private readonly decrypted = new Map<string, Uint8Array>();

  /**
   * 创建按需条目视图。
   *
   * @param container 原始 ZIP 容器。
   * @param limits 资源限制。
   * @param signal 取消信号。
   */
  constructor(container: VirtualContainer, limits: CryptoLimits, signal?: AbortSignal) {
    this.container = container;
    this.limits = limits;
    this.signal = signal;
    this.packageSize = container.packageSize;
    this.sourcePaths = new Set(container.list().map((meta) => meta.path));
  }

  /**
   * 列出当前可见路径。
   *
   * @returns 路径数组，按 path 升序。
   */
  paths(): string[] {
    const paths: string[] = [];
    for (const path of this.sourcePaths) {
      if (!this.removed.has(path)) paths.push(path);
    }
    for (const path of this.decrypted.keys()) {
      if (!this.removed.has(path) && !this.sourcePaths.has(path)) paths.push(path);
    }
    return paths.sort();
  }

  /**
   * 判断路径当前是否存在。
   *
   * @param path 包内路径。
   * @returns 是否存在。
   */
  has(path: string): boolean {
    if (this.decrypted.has(path)) return true;
    return !this.removed.has(path) && this.sourcePaths.has(path);
  }

  /**
   * 读取条目；不存在时返回 undefined。
   *
   * @param path 包内路径。
   * @returns 字节或 undefined。
   * @throws CryptoError 读取失败/超限/取消时。
   */
  async read(path: string): Promise<Uint8Array | undefined> {
    const decrypted = this.decrypted.get(path);
    if (decrypted) return decrypted;
    if (this.removed.has(path) || !this.sourcePaths.has(path)) return undefined;
    return readEntry(path, {
      container: this.container,
      limits: this.limits,
      signal: this.signal,
    });
  }

  /**
   * 隐藏路径并返回此前是否存在。
   *
   * @param path 包内路径。
   * @returns 此前是否存在。
   */
  remove(path: string): boolean {
    const existed = this.has(path);
    this.decrypted.delete(path);
    this.removed.add(path);
    return existed;
  }

  /**
   * 写入解密后的明文条目。
   *
   * @param path 输出路径。
   * @param bytes 明文字节。
   * @throws CryptoError `CRYPTO_ENTRY_MAP_INVALID`：输出路径已存在（重复）。
   */
  set(path: string, bytes: Uint8Array): void {
    if (this.has(path)) {
      throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', `entriesmap 输出路径重复：${path}`);
    }
    this.removed.delete(path);
    this.decrypted.set(path, bytes);
  }
}

/**
 * 应用一层映射：解密映射条目、删除加密元数据并输出明文路径。
 *
 * @param entries 按需条目视图。
 * @param mappings EPath→Path 映射。
 * @param fek 16 byte 文件密钥。
 * @param iv 16 byte IV。
 * @param metadata 本层必须删除的元数据路径。
 * @param mapPath entriesmap 路径。
 * @param collector warning 收集器。
 * @param futureMetadata 后续层元数据路径。
 * @returns 本层统计。
 * @throws CryptoError `CRYPTO_ENTRY_MAP_INVALID`。
 */
async function applyLayer(
  entries: LazyEntryStore,
  mappings: readonly EntryMapping[],
  fek: Uint8Array,
  iv: Uint8Array,
  metadata: readonly string[],
  mapPath: string,
  collector: WarningCollector,
  futureMetadata: ReadonlySet<string>,
): Promise<AppliedLayer> {
  const removedMetadata: string[] = [];
  for (const path of metadata) {
    if (entries.remove(path)) removedMetadata.push(path);
  }

  const outputPaths = new Set(mappings.map((mapping) => mapping.path));
  const decrypted = new Map<string, Uint8Array>();
  for (const mapping of mappings) {
    const ciphertext = await entries.read(mapping.ePath);
    if (!ciphertext) {
      throw new CryptoError(
        'CRYPTO_ENTRY_MAP_INVALID',
        `entriesmap 指向不存在的条目：${mapping.ePath}`,
      );
    }
    decrypted.set(mapping.path, decryptEntry(ciphertext, fek, iv, mapping.ePath));
  }

  // 先删除全部 EPath，再写入明文 Path，避免同名覆盖。
  for (const mapping of mappings) {
    entries.remove(mapping.ePath);
  }
  for (const [path, bytes] of decrypted) {
    entries.set(path, bytes);
  }

  // 未列入映射的 .dat 可能是未解密的密文，不能让 engine 看到；整层失败。
  for (const path of entries.paths()) {
    if (
      path.toLowerCase().endsWith('.dat') &&
      !outputPaths.has(path) &&
      !futureMetadata.has(path)
    ) {
      throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', `未列入 entriesmap 的 .dat 条目：${path}`);
    }
  }
  for (const path of entries.paths()) {
    if (
      outputPaths.has(path) ||
      futureMetadata.has(path) ||
      path === 'Encryptions.xml' ||
      path === mapPath
    ) {
      continue;
    }
    collector.emit({
      code: 'W_CRYPTO_ENTRY_MAP_INVALID',
      path,
      message: `条目未列入 entriesmap，按原字节复制：${path}`,
    });
  }

  return { decryptedEntries: mappings.length, removedMetadata };
}

/**
 * 解析并应用单个 `EncryptInfo` 层。
 *
 * @param entries 按需条目视图。
 * @param info 层结构。
 * @param credentials 凭据。
 * @param limits 资源限制。
 * @param collector warning 收集器。
 * @param futureMetadata 后续层元数据路径。
 * @param encryptionsPath 当前 Encryptions.xml 路径。
 * @param signal 取消信号。
 * @returns 本层摘要。
 */
async function decryptOneLayer(
  entries: LazyEntryStore,
  info: ParsedEncryptionLayer,
  credentials: readonly CryptoCredential[],
  limits: CryptoLimits,
  collector: WarningCollector,
  futureMetadata: ReadonlySet<string>,
  encryptionsPath: string,
  signal?: AbortSignal,
): Promise<DecryptionLayerSummary> {
  throwIfAborted(signal);
  const seedBytes = await entries.read(info.decryptSeedPath);
  if (!seedBytes) {
    throw new CryptoError(
      'CRYPTO_INVALID_PACKAGE',
      `加密层 ${info.id} 缺少 decryptseed：${info.decryptSeedPath}`,
    );
  }
  let users: ParsedSeedUser[];
  try {
    const root = parseXml(decodeUtf8Strict(seedBytes), {
      maxBytes: limits.maxAsn1Bytes,
      maxDepth: limits.maxAsn1Depth,
    });
    users = parseDecryptSeed(root, limits);
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', `加密层 ${info.id} 的 decryptseed 非法`);
  }
  const recovered = await recoverLayerKey(users, credentials, limits, (warning) =>
    collector.emit(warning),
  );
  const fek = recovered.fek;
  try {
    throwIfAborted(signal);
    const mapBytes = await entries.read(info.entriesMapPath);
    if (!mapBytes) {
      throw new CryptoError(
        'CRYPTO_ENTRY_MAP_INVALID',
        `加密层 ${info.id} 缺少 entriesmap：${info.entriesMapPath}`,
      );
    }
    const parsedMap = parseEntriesMap(mapBytes, fek, recovered.user.iv, limits);
    if (parsedMap.mode === 'plaintext') {
      collector.emit({
        code: 'W_CRYPTO_ENTRIES_MAP_PLAINTEXT',
        path: info.entriesMapPath,
        message: 'entriesmap.dat 为明文 XML，按明文映射继续',
      });
    }
    const applied = await applyLayer(
      entries,
      parsedMap.mappings,
      fek,
      recovered.user.iv,
      [encryptionsPath, info.decryptSeedPath, info.entriesMapPath],
      info.entriesMapPath,
      collector,
      futureMetadata,
    );
    return {
      layer: info.layer,
      id: info.id,
      user: toUserInfo(recovered.user),
      decryptedEntries: applied.decryptedEntries,
      removedMetadata: applied.removedMetadata,
      entriesMapMode: parsedMap.mode,
    };
  } finally {
    zeroize(fek);
  }
}

/**
 * 把原始用户转成公共摘要。
 *
 * @param user 原始用户。
 * @returns 公共用户信息。
 */
function toUserInfo(user: ParsedSeedUser): EncryptionUserInfo {
  if (user.method === 'certificate' && user.certificate) {
    return {
      userName: user.userName,
      method: 'certificate',
      certificate: {
        subject: user.certificate.subject,
        issuer: user.certificate.issuer,
        serialNumber: user.certificate.serialNumber,
        notBefore: user.certificate.notBeforeISO,
        notAfter: user.certificate.notAfterISO,
        fingerprintSha256: user.certificate.fingerprintSha256,
        publicKeyAlgorithm: user.certificate.publicKeyAlgorithmName,
        signatureAlgorithm: user.certificate.signatureAlgorithmName,
        keyUsage: user.certificate.keyUsage,
        isCA: user.certificate.isCA,
      },
    };
  }
  return { userName: user.userName, method: user.method };
}

/**
 * 判断路径是否为加密清单。
 *
 * @param path 包内路径。
 * @returns 是否以 `Encryptions.xml` 结尾。
 */
function isEncryptionsPath(path: string): boolean {
  return path === 'Encryptions.xml' || path.endsWith('/Encryptions.xml');
}

/**
 * 查找下一个加密清单路径。
 *
 * @param paths 当前可见路径。
 * @returns 按路径排序的第一个清单路径；不存在返回 undefined。
 */
function findEncryptionsPath(paths: readonly string[]): string | undefined {
  const candidates = paths.filter(isEncryptionsPath).sort();
  // 根清单优先；根清单删除后才处理嵌套路径。
  return candidates.includes('Encryptions.xml') ? 'Encryptions.xml' : candidates[0];
}

/**
 * 解出明文容器。
 *
 * @param options 源、凭据、限制/取消/warning。
 * @returns 明文容器与解密摘要；明文包原样透传。
 * @throws CryptoError 凭据/包结构/超限错误。
 */
export async function openDecryptingContainer(
  options: OpenDecryptingContainerOptions,
): Promise<DecryptingContainerResult> {
  if (!options || typeof options !== 'object') {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'openDecryptingContainer 选项必须是对象');
  }
  const resolved = resolveCryptoOptions(options);
  const credentials = normalizeCredentials(options.credentials);
  const collector = createWarningCollector(resolved.onWarning);
  const sourceContainer = await openCryptoContainer(
    options.source,
    resolved.limits,
    resolved.signal,
  );
  let handedOff = false;
  try {
    const initialAccess = containerAccess(sourceContainer, resolved.limits);
    const details = await inspectAccess(initialAccess, resolved, collector);

    if (!details.inspection.encrypted) {
      throwIfAborted(resolved.signal);
      if (credentials.length > 0) {
        collector.emit({
          code: 'W_CRYPTO_CREDENTIAL_IGNORED',
          message: '明文包不需要凭据，已忽略调用方凭据',
        });
      }
      throwIfAborted(resolved.signal);
      handedOff = true;
      return {
        container: sourceContainer,
        inspection: { ...details.inspection, warnings: [...collector.warnings] },
        plaintext: true,
        layers: [],
        warnings: [...collector.warnings],
      };
    }

    if (credentials.length === 0) {
      throw new CryptoError('CRYPTO_CREDENTIALS_REQUIRED', '加密包需要至少一个凭据');
    }

    const entries = new LazyEntryStore(sourceContainer, resolved.limits, resolved.signal);
    const layers: DecryptionLayerSummary[] = [];
    const seen = new Set<string>();
    const seenXml = new Set<string>();
    const allMetadata = new Set<string>();
    let currentEncryptionsPath = findEncryptionsPath(entries.paths());
    while (currentEncryptionsPath) {
      throwIfAborted(resolved.signal);
      if (layers.length >= resolved.limits.maxDecryptLayers) {
        throw new CryptoError(
          'CRYPTO_DECRYPT_LAYER_LIMIT',
          `加密层数超过上限 ${resolved.limits.maxDecryptLayers}`,
        );
      }
      const currentEncryptions = await entries.read(currentEncryptionsPath);
      if (!currentEncryptions) {
        throw new CryptoError('CRYPTO_INVALID_PACKAGE', `加密清单不可读：${currentEncryptionsPath}`);
      }
      const xmlKey = `${currentEncryptionsPath}:${toHex(sha256(currentEncryptions))}`;
      if (seenXml.has(xmlKey)) {
        throw new CryptoError('CRYPTO_LAYER_LOOP', '检测到重复加密层');
      }
      seenXml.add(xmlKey);
      allMetadata.add(currentEncryptionsPath);
      let root;
      try {
        root = parseXml(decodeUtf8Strict(currentEncryptions), {
          maxBytes: resolved.limits.maxAsn1Bytes,
          maxDepth: resolved.limits.maxAsn1Depth,
        });
      } catch (error) {
        if (error instanceof CryptoError) throw error;
        throw new CryptoError('CRYPTO_INVALID_PACKAGE', `${currentEncryptionsPath} 非法`);
      }
      const infos = parseEncryptions(root, resolved.limits.maxDecryptLayers);
      if (infos.length === 0) {
        throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'Encryptions.xml 没有 EncryptInfo');
      }
      for (const info of infos) {
        allMetadata.add(info.decryptSeedPath);
        allMetadata.add(info.entriesMapPath);
      }
      for (const info of infos) {
        if (layers.length + 1 > resolved.limits.maxDecryptLayers) {
          throw new CryptoError(
            'CRYPTO_DECRYPT_LAYER_LIMIT',
            `加密层数超过上限 ${resolved.limits.maxDecryptLayers}`,
          );
        }
        const seedBytes = await entries.read(info.decryptSeedPath);
        const mapBytes = await entries.read(info.entriesMapPath);
        const loopKey = [
          currentEncryptionsPath,
          toHex(sha256(currentEncryptions)),
          toHex(sha256(seedBytes ?? new Uint8Array(0))),
          toHex(sha256(mapBytes ?? new Uint8Array(0))),
        ].join(':');
        if (seen.has(loopKey)) {
          throw new CryptoError('CRYPTO_LAYER_LOOP', '检测到重复加密层');
        }
        seen.add(loopKey);
        layers.push(
          await decryptOneLayer(
            entries,
            info,
            credentials,
            resolved.limits,
            collector,
            allMetadata,
            currentEncryptionsPath,
            resolved.signal,
          ),
        );
      }
      // 当前清单必须被删除；若映射又输出了新的清单，则继续下一层。
      const nextEncryptionsPath = findEncryptionsPath(entries.paths());
      if (nextEncryptionsPath === currentEncryptionsPath) {
        throw new CryptoError('CRYPTO_LAYER_LOOP', '加密层未取得进展');
      }
      currentEncryptionsPath = nextEncryptionsPath;
    }

    if (entries.paths().some(isEncryptionsPath)) {
      throw new CryptoError('CRYPTO_LAYER_LOOP', '解密后仍存在 Encryptions.xml');
    }

    for (const path of allMetadata) {
      if (entries.has(path)) {
        throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', `解密后仍残留加密元数据：${path}`);
      }
    }

    if (layers.length > 1) {
      collector.emit({
        code: 'W_CRYPTO_MULTI_LAYER',
        message: `文档包含 ${layers.length} 个加密层，已全部解开`,
      });
    }

    throwIfAborted(resolved.signal);
    const memoryEntries = new Map<
      string,
      { readonly bytes: Uint8Array; readonly origin: 'decrypted' }
    >();
    const finalBytes = new Map<string, Uint8Array>();
    let totalBytes = 0;
    for (const path of entries.paths()) {
      throwIfAborted(resolved.signal);
      const bytes = await entries.read(path);
      if (!bytes) {
        throw new CryptoError('CRYPTO_INVALID_PACKAGE', `待输出条目不存在：${path}`);
      }
      totalBytes += bytes.length;
      if (totalBytes > resolved.limits.maxTotalDecryptedBytes) {
        throw new CryptoError(
          'CRYPTO_LIMIT_EXCEEDED',
          `解压总量 ${totalBytes} byte 超过上限 ${resolved.limits.maxTotalDecryptedBytes} byte`,
        );
      }
      finalBytes.set(path, bytes);
      memoryEntries.set(path, { bytes, origin: 'decrypted' });
    }
    const finalAccess = snapshotAccess(
      { entries: finalBytes, packageSize: sourceContainer.packageSize },
      resolved.signal,
    );
    const finalDetails = await inspectAccess(finalAccess, resolved, collector);
    throwIfAborted(resolved.signal);
    const inspection: OfdInspection = {
      ...finalDetails.inspection,
      encrypted: true,
      packageSize: sourceContainer.packageSize,
      layers: details.inspection.layers,
      users: details.inspection.users,
      warnings: [...collector.warnings],
    };
    const container = new MemoryVirtualContainer(memoryEntries, sourceContainer.packageSize);
    try {
      throwIfAborted(resolved.signal);
      await closeQuietly(sourceContainer);
      handedOff = true;
      return {
        container,
        inspection,
        plaintext: false,
        layers,
        warnings: [...collector.warnings],
      };
    } catch (error) {
      await container.close().catch(() => undefined);
      throw error;
    }
  } finally {
    if (!handedOff) await closeQuietly(sourceContainer);
  }
}
