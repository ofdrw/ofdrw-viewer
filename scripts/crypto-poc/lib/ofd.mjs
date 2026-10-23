/** OFD 容器读取与加密/签章 XML 解析的 PoC 实现。 */
import { unzipSync } from 'fflate';
import {
  base64ToBytes, bytesToHex, bytesToBase64, concatBytes, hexToBytes, parsePem,
  parseCertificate, parseDer, parseSignedData, getAuthenticatedAttributesInfo, TAG,
} from './der.mjs';

/** ZIP 解包：返回 { 容器路径: Uint8Array }，路径不含前导 '/'。 */
export function unzipOfd(bytes) {
  return unzipSync(bytes);
}

/** 取容器内文件，自动兼容前导 '/'。 */
export function entryOf(zip, path) {
  const key = String(path).replace(/^\/+/, '');
  const data = zip[key];
  if (!data) throw new Error(`OFD 容器中不存在: ${path}`);
  return data;
}

export function textOf(zip, path) {
  return new TextDecoder().decode(entryOf(zip, path));
}

/** 读取 XML 标签的指定属性，返回 null 表示不存在。 */
export function attrOf(xml, tag, name) {
  const re = new RegExp(`<[^>]*:?${tag}\\b[^>]*\\b${name}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** 读取第一个同名标签的文本内容。 */
export function textTag(xml, tag) {
  const re = new RegExp(`<[^>]*:?${tag}\\b[^>]*>([\\s\\S]*?)</[^>]*:?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** 读取同名标签的所有文本。 */
export function allTag(xml, tag) {
  const re = new RegExp(`<[^>]*:?${tag}\\b[^>]*>([\\s\\S]*?)</[^>]*:?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

/** 读取所有同名自闭合/普通标签的属性集合。 */
export function allAttrs(xml, tag) {
  const re = new RegExp(`<(?!/)(?:[\\w.-]+:)?${tag}\\b([^>]*?)/?>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = {};
    const attrRe = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    out.push(attrs);
  }
  return out;
}

/**
 * 解析 Encryptions.xml。
 * 返回 [{ id, relative, decryptSeedLoc, entriesMapLoc, encryptScope }]
 */
export function parseEncryptions(xml) {
  return allAttrs(xml, 'EncryptInfo').map((attrs, index) => ({
    index,
    id: attrs.ID,
    relative: attrs.Relative || null,
    encryptScope: textTag(xml, 'EncryptScope'),
    decryptSeedLoc: textTag(xml, 'DecryptSeedLoc'),
    entriesMapLoc: textTag(xml, 'EntriesMapLoc'),
  }));
}

/** 解析 decryptseed.dat。 */
export function parseDecryptSeed(xml) {
  const seedId = attrOf(xml, 'DecyptSeed', 'ID');
  const encryptCaseId = attrOf(xml, 'DecyptSeed', 'EncryptCaseId');
  const blocks = [];
  const re = /<[^>]*:?UserInfo\b([^>]*)>([\s\S]*?)<\/[^>]*:?UserInfo>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = {};
    const attrRe = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const body = m[2];
    blocks.push({
      userName: attrs.UserName || null,
      userType: attrs.UserType || 'User',
      userCert: textTag(body, 'UserCert') ? base64ToBytes(textTag(body, 'UserCert')) : null,
      iv: base64ToBytes(textTag(body, 'IVValue') || ''),
      encryptedWk: base64ToBytes(textTag(body, 'EncryptedWK')),
    });
  }
  return { id: seedId, encryptCaseId, users: blocks };
}

/** 解析 entriesmap.dat（解密后）。 */
export function parseEncryptEntries(xml) {
  const entries = allAttrs(xml, 'EncryptEntry').map((attrs) => ({
    path: attrs.Path,
    ePath: attrs.EPath,
    decryptSeedLoc: attrs.DecryptSeedLoc || null,
  }));
  return { id: attrOf(xml, 'EncryptEntries', 'ID'), entries };
}

/**
 * GM/T 0099 口令 KDF：K = KDF(SM3, 口令, 16)。
 * 实现与 ofdrw KDF.extend(new SM3.Digest(), password, klen) 对齐。
 */
export function kdfSm3(sm3, passwordBytes, klen = 16) {
  const v = 32;
  const out = [];
  let ct = 1;
  while (out.length < klen) {
    const counter = Uint8Array.of((ct >>> 24) & 0xff, (ct >>> 16) & 0xff, (ct >>> 8) & 0xff, ct & 0xff);
    const digestHex = sm3(Array.from(concatBytes(passwordBytes, counter)));
    out.push(...hexToBytes(digestHex));
    ct += 1;
  }
  return Uint8Array.from(out.slice(0, klen));
}

/** SM4-CBC/PKCS#7 解密（sm-crypto 默认 PKCS#7）。 */
export function sm4CbcDecrypt(sm4, cipherBytes, keyBytes, ivBytes) {
  return Uint8Array.from(sm4.decrypt(bytesToHex(cipherBytes), bytesToHex(keyBytes), {
    mode: 'cbc',
    iv: bytesToHex(ivBytes),
    output: 'array',
  }));
}

export function sm4CbcEncrypt(sm4, plainBytes, keyBytes, ivBytes) {
  // 注意：sm-crypto 加密时字符串输入按 UTF-8 处理，必须传字节数组
  const out = sm4.encrypt(Array.from(plainBytes), bytesToHex(keyBytes), {
    mode: 'cbc',
    iv: bytesToHex(ivBytes),
    output: 'array',
  });
  return Uint8Array.from(out);
}

/**
 * 解析 ASN.1 SM2Cipher（GB/T 35276）为 C1C3C2 原始字节。
 * SEQUENCE { X INTEGER, Y INTEGER, HASH OCTET STRING, CipherText OCTET STRING }
 */
export function sm2CipherDerToC1C3C2(derBytes) {
  const seq = parseDer(derBytes);
  const x = seq.child(0).int();
  const y = seq.child(1).int();
  const c3 = seq.child(2).octets();
  const c2 = seq.child(3).octets();
  return concatBytes(Uint8Array.of(4), bigIntTo32(x), bigIntTo32(y), c3, c2);
}

/** C1C3C2（不带 04 前缀或带 04 前缀）转为 ASN.1 SM2Cipher DER。 */
export function c1c3c2ToSm2CipherDer(c1c3c2, hasUncompressedPrefix = false) {
  let bytes = c1c3c2;
  if (hasUncompressedPrefix) {
    if (bytes[0] !== 4) throw new Error('C1C3C2 缺少 04 前缀');
    bytes = bytes.subarray(1);
  }
  if (bytes.length < 96) throw new Error('C1C3C2 长度不足');
  const x = bytes.subarray(0, 32);
  const y = bytes.subarray(32, 64);
  const c3 = bytes.subarray(64, 96);
  const c2 = bytes.subarray(96);
  const intX = bytesToHex(x);
  const intY = bytesToHex(y);
  // 使用 der.mjs 的编码器
  return encodeSmCipher(intX, intY, c3, c2);
}

function bigIntTo32(x) {
  let hex = x.toString(16);
  if (hex.length > 64) throw new Error('SM2 坐标超过 32 字节');
  return hexToBytes(hex.padStart(64, '0'));
}

// 避免循环 import：直接构造最小的 SM2Cipher DER。
import { encodeSequence, encodeInteger, encodeOctetString } from './der.mjs';

function encodeSmCipher(xHex, yHex, c3, c2) {
  return encodeSequence(
    encodeInteger(xHex),
    encodeInteger(yHex),
    encodeOctetString(c3),
    encodeOctetString(c2),
  );
}

/**
 * 解析 SES 电子签章数据（v1/v4/v5 的 v4/v5 结构）。
 * 返回 { version, tbsRaw, tbs, certDer, signatureAlg, signature, timeStamp, seal }
 */
export function parseSesSignature(derBytes) {
  const root = parseDer(derBytes);
  const tbs = root.child(0);
  const version = Number(tbs.child(0).int());
  if (version <= 1) {
    throw new Error('当前 PoC 的 JS 解析器仅覆盖 SES v4/v5；v1 结构差异见报告');
  }
  const sealNode = tbs.child(1);
  const timeInfo = tbs.child(2);
  const dataHash = tbs.child(3).octets();
  const propertyInfo = tbs.child(4).ia5();
  const certDer = root.child(1).octets();
  const signatureAlg = root.child(2).oid();
  const signature = root.child(3).octets();
  let timeStamp = null;
  const tagged = root.findContext(0);
  if (tagged) {
    // [0] EXPLICIT BIT STRING
    const bs = parseDer(tagged.value);
    timeStamp = bs.octets();
  }
  return {
    version,
    tbsRaw: tbs.raw,
    dataHash,
    timeInfo: timeInfo.generalizedTime(),
    propertyInfo,
    certDer,
    signatureAlg,
    signature,
    timeStamp,
    seal: parseSeal(sealNode, version),
  };
}

function parseSeal(node, version) {
  if (version <= 1) return null;
  const sealInfo = node.child(0);
  const header = sealInfo.child(0);
  const esId = sealInfo.child(1).ia5();
  const property = sealInfo.child(2);
  const picture = sealInfo.child(3);
  const certDer = node.child(1).octets();
  const signatureAlg = node.child(2).oid();
  const signature = node.child(3).octets();
  // v4/v5 的 SES_ESPropertyInfo 布局一致：
  // type, name, certListType, certList, createDate, validStart, validEnd
  const certListType = Number(property.child(2).int());
  const name = property.child(1).utf8();
  const created = property.child(4).generalizedOrUtc();
  const validStart = property.child(5).generalizedOrUtc();
  const validEnd = property.child(6).generalizedOrUtc();
  return {
    version: Number(header.child(1).int()),
    headerId: header.child(0).ia5(),
    vid: header.child(2).ia5(),
    esId,
    name,
    certListType,
    created,
    validStart,
    validEnd,
    pictureType: picture.child(0).ia5(),
    pictureWidth: Number(picture.child(2).int()),
    pictureHeight: Number(picture.child(3).int()),
    sealInfoRaw: sealInfo.raw,
    certDer,
    signatureAlg,
    signature,
  };
}

/**
 * 解析 GM/T 0033 时间戳令牌：ContentInfo(SignedData) -> TSTInfo。
 * 仅解析，不验证 TSA 签名。
 */
export function parseTimestampToken(tokenDer) {
  const sd = parseSignedData(tokenDer);
  if (!sd.eContent) throw new Error('时间戳令牌缺少 eContent');
  const tst = parseDer(sd.eContent);
  const messageImprint = tst.child(2);
  const result = {
    version: Number(tst.child(0).int()),
    policy: tst.child(1).oid(),
    hashAlgorithm: messageImprint.child(0).child(0).oid(),
    hashedMessage: messageImprint.child(1).octets(),
    serialNumber: tst.child(3).intHex(),
    genTime: tst.child(4).generalizedTime(),
    signingTime: tst.child(4).generalizedOrUtc(),
    tsa: null,
    certCount: sd.certs.length,
    eContentType: sd.encapType,
    signerCount: sd.signerInfos.length,
  };
  if (sd.signerInfos.length > 0) {
    const signer = sd.signerInfos[0];
    const cert = sd.certs.find((c) => bytesEqual(c.issuerRaw, signer.issuerSerial.issuerRaw)
      && c.serial === signer.issuerSerial.serial);
    result.tsa = cert ? cert.subject : null;
    result.tsaCert = cert || null;
    result.signature = signer.signature;
  }
  return result;
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 解析 GB/T 35275 ContentInfo(SignedData) 签名值（防夹带完整性）。
 * ofdrw GMProtectSigner 未使用 authenticatedAttributes，这里兼容两种。
 */
export function parseGbt35275(signedValueDer) {
  const sd = parseSignedData(signedValueDer);
  return {
    contentType: sd.contentType,
    encapType: sd.encapType,
    content: sd.eContent,
    certificates: sd.certs,
    signerInfos: sd.signerInfos,
    raw: sd.raw,
  };
}

/** 读取 PEM 文件中的第一个证书。 */
export function readCertPem(text) {
  const blocks = parsePem(text);
  if (blocks.length === 0) throw new Error('PEM 中没有证书');
  return parseCertificate(blocks[0].der);
}

/** 生成 SM2 签名 DER 的 hex（供 sm-crypto 使用）。 */
export function sm2Sign(sm2, messageBytes, privateKeyHex) {
  return sm2.doSignature(Array.from(messageBytes), privateKeyHex, {
    der: true,
  });
}

/** 验证 SM2 DER 签名；默认用户 ID 1234567812345678。 */
export function sm2Verify(sm2, messageBytes, signatureHex, publicKeyHex, userId) {
  const options = { der: true };
  if (userId !== undefined) options.userId = userId;
  return sm2.doVerifySignature(Array.from(messageBytes), signatureHex, publicKeyHex, options);
}

export { base64ToBytes, bytesToHex, bytesToBase64 };
/**
 * 解析 SM2 私钥 PEM（PKCS#8 `PRIVATE KEY` 或 SEC1 `EC PRIVATE KEY`）。
 * 返回私钥标量、派生的公钥，以及 PKCS#8 内嵌公钥（若有）。
 *
 * @param {string} pemText PEM 文本
 * @param {object} sm2 sm-crypto 的 sm2 对象（用于由私钥推导公钥）
 */
export function parseSm2PrivateKeyPem(pemText, sm2) {
  const blocks = parsePem(pemText);
  const block = blocks.find((b) => b.type === 'PRIVATE KEY')
    || blocks.find((b) => b.type === 'EC PRIVATE KEY');
  if (!block) throw new Error('PEM 中没有 PKCS#8 或 SEC1 私钥');
  let ec;
  let format;
  if (block.type === 'PRIVATE KEY') {
    const pki = parseDer(block.der);
    const alg = pki.child(1).child(0).oid();
    if (alg !== '1.2.840.10045.2.1') {
      throw new Error(`不是 EC 私钥，算法 OID=${alg}`);
    }
    ec = parseDer(pki.child(2).octets());
    format = 'PKCS#8';
  } else {
    ec = parseDer(block.der);
    format = 'SEC1';
  }
  const d = ec.child(1).octets();
  const privateKeyHex = bytesToHex(d).padStart(64, '0');
  let embeddedPublicKeyHex = null;
  for (const child of ec.children) {
    if (child.cls === 2 && child.tag === 1) {
      embeddedPublicKeyHex = bytesToHex(parseDer(child.value).octets());
    }
  }
  const publicKeyHex = sm2.getPublicKeyFromPrivateKey(privateKeyHex);
  return {
    format,
    privateKeyHex,
    publicKeyHex,
    embeddedPublicKeyHex,
    embeddedMatchesDerived: embeddedPublicKeyHex ? embeddedPublicKeyHex === publicKeyHex : null,
  };
}
