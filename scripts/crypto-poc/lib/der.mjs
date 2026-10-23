/**
 * 最小 ASN.1 DER 解析/编码工具（PoC 用）。
 *
 * 仅覆盖密码学 PoC 需要的类型：SEQUENCE、SET、INTEGER、BIT STRING、
 * OCTET STRING、OBJECT IDENTIFIER、UTF8String、IA5String、GeneralizedTime
 * 以及上下文标签（[0] 等）。
 *
 * 说明：正式实现建议使用 asn1js / @peculiar/asn1-schema 等成熟库；
 * 本文件用于验证“仅依赖 sm-crypto + 少量 DER 解析即可完成校验”的可行性。
 */

const TAG = {
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x10,
  SET: 0x11,
  IA5_STRING: 0x16,
  PRINTABLE_STRING: 0x13,
  GENERALIZED_TIME: 0x18,
  UTC_TIME: 0x17,
};

export { TAG };

/** 将 Uint8Array 转为小写十六进制字符串。 */
export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 将十六进制字符串转为 Uint8Array。 */
export function hexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 拼接多个 Uint8Array。 */
export function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** 将 Uint8Array 转为 base64。 */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 将 base64 转为 Uint8Array（浏览器与 Node 通用）。 */
export function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * DER 节点。
 * raw 为包含 tag/length/value 的完整字节；value 仅为 value 部分。
 */
export class DerNode {
  constructor(bytes, tag, cls, constructed, offset, headerLen, length) {
    this.bytes = bytes;
    this.tag = tag;
    this.cls = cls; // 0=universal, 2=context-specific
    this.constructed = constructed;
    this.offset = offset;
    this.headerLen = headerLen;
    this.length = length;
    this._children = null;
  }

  /** 完整 TLV 字节（用于签名原文、证书 tbs 等）。 */
  get raw() {
    return this.bytes.subarray(this.offset, this.offset + this.headerLen + this.length);
  }

  /** value 字节。 */
  get value() {
    return this.bytes.subarray(this.offset + this.headerLen,
      this.offset + this.headerLen + this.length);
  }

  /** 解析 constructed 节点的子节点。 */
  get children() {
    if (!this.constructed) return [];
    if (this._children) return this._children;
    const out = [];
    let off = this.offset + this.headerLen;
    const end = this.offset + this.headerLen + this.length;
    while (off < end) {
      const node = parseDer(this.bytes, off, end);
      out.push(node);
      off = off + node.headerLen + node.length;
    }
    this._children = out;
    return out;
  }

  child(index) {
    return this.children[index] || null;
  }

  /** 查找第一个 universal tag 匹配的子节点。 */
  find(tag) {
    return this.children.find((c) => c.cls === 0 && c.tag === tag) || null;
  }

  /** 查找第一个 context-specific tag 匹配的子节点。 */
  findContext(tag) {
    return this.children.find((c) => c.cls === 2 && c.tag === tag) || null;
  }

  /** OCTET STRING / BIT STRING 内容字节（BIT STRING 去掉 unused-bits 字节）。 */
  octets() {
    if (this.tag === TAG.BIT_STRING) {
      return this.value.subarray(1);
    }
    return this.value;
  }

  bitStringUnusedBits() {
    return this.tag === TAG.BIT_STRING ? this.value[0] : 0;
  }

  /** INTEGER 转为 BigInt（不处理负数的场景，本 PoC 全部为非负）。 */
  int() {
    let x = 0n;
    for (const b of this.value) x = (x << 8n) | BigInt(b);
    return x;
  }

  /** INTEGER 的无前导零十六进制。 */
  intHex() {
    return this.int().toString(16);
  }

  oid() {
    return decodeOid(this.value);
  }

  utf8() {
    return new TextDecoder().decode(this.value);
  }

  ia5() {
    return new TextDecoder('ascii').decode(this.value);
  }

  generalizedTime() {
    return new TextDecoder('ascii').decode(this.value);
  }

  info() {
    return {
      tag: this.tag,
      cls: this.cls,
      constructed: this.constructed,
      length: this.length,
      rawLen: this.headerLen + this.length,
    };
  }
}

/**
 * 解析一个 DER TLV。
 * @param {Uint8Array} bytes 输入
 * @param {number} offset 起始偏移
 * @param {number} limit 结束边界
 * @returns {DerNode}
 */
export function parseDer(bytes, offset = 0, limit = bytes.length) {
  if (offset >= limit) throw new Error(`DER 越界: offset=${offset}`);
  const first = bytes[offset];
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  let pos = offset + 1;
  if (tag === 0x1f) {
    // 高 tag number（本 PoC 不使用，保留兼容）
    tag = 0;
    while (pos < limit) {
      const b = bytes[pos++];
      tag = (tag << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }
  if (pos >= limit) throw new Error('DER 缺少长度字段');
  let lenByte = bytes[pos++];
  let length;
  if (lenByte < 0x80) {
    length = lenByte;
  } else {
    const n = lenByte & 0x7f;
    if (n === 0 || n > 4) throw new Error(`不支持的 DER 长度编码: ${n}`);
    length = 0;
    for (let i = 0; i < n; i += 1) length = length * 256 + bytes[pos++];
  }
  if (pos + length > limit) throw new Error('DER 长度超出输入范围');
  const headerLen = pos - offset;
  return new DerNode(bytes, tag, cls, constructed, offset, headerLen, length);
}

/** 解析 PEM 文本块，返回 [{type, der}]。 */
export function parsePem(text) {
  const out = [];
  const re = /-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ type: m[1].trim(), der: base64ToBytes(m[2].replace(/\s+/g, '')) });
  }
  return out;
}

/** 解码 OID 的 value 部分。 */
export function decodeOid(value) {
  if (value.length === 0) return '';
  const first = value[0];
  const parts = [Math.floor(first / 40), first % 40];
  let acc = 0;
  for (let i = 1; i < value.length; i += 1) {
    acc = (acc << 7) | (value[i] & 0x7f);
    if ((value[i] & 0x80) === 0) {
      parts.push(acc);
      acc = 0;
    }
  }
  return parts.join('.');
}

// ---------------------------------------------------------------- 编码

export function encodeLength(n) {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** 编码任意 TLV。 */
export function encodeTlv(tag, content) {
  return concatBytes(Uint8Array.of(tag), encodeLength(content.length), content);
}

/** 编码 SEQUENCE。 */
export function encodeSequence(...items) {
  return encodeTlv(0x30, concatBytes(...items));
}

/** 编码 SET（DER 要求按字节序排序，调用方保证顺序时可直接使用）。 */
export function encodeSet(...items) {
  return encodeTlv(0x31, concatBytes(...items));
}

/** 编码 INTEGER：接受 BigInt 或十六进制字符串（无前导 0x）。 */
export function encodeInteger(value) {
  let x = typeof value === 'bigint' ? value : BigInt(`0x${value}`);
  if (x === 0n) return encodeTlv(TAG.INTEGER, Uint8Array.of(0));
  const bytes = [];
  while (x > 0n) {
    bytes.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return encodeTlv(TAG.INTEGER, Uint8Array.from(bytes));
}

/** 编码 OCTET STRING。 */
export function encodeOctetString(content) {
  return encodeTlv(TAG.OCTET_STRING, content);
}

/** 编码 BIT STRING（unused bits 固定为 0）。 */
export function encodeBitString(content) {
  return encodeTlv(TAG.BIT_STRING, concatBytes(Uint8Array.of(0), content));
}

/** 编码 OID。 */
export function encodeOid(oid) {
  const parts = oid.split('.').map((s) => BigInt(s));
  const out = [Number(parts[0] * 40n + parts[1])];
  for (let i = 2; i < parts.length; i += 1) {
    let x = parts[i];
    const stack = [Number(x & 0x7fn)];
    x >>= 7n;
    while (x > 0n) {
      stack.unshift(Number((x & 0x7fn) | 0x80n));
      x >>= 7n;
    }
    out.push(...stack);
  }
  return encodeTlv(TAG.OID, Uint8Array.from(out));
}

/** 编码上下文标签（显式构造，如 [0] EXPLICIT）。 */
export function encodeContext(tag, content, constructed = true) {
  return encodeTlv(0x80 | (constructed ? 0x20 : 0) | tag, content);
}

// ---------------------------------------------------------------- X.509

/**
 * 解析 X.509 证书。
 * @param {Uint8Array} der 证书 DER
 */
export function parseCertificate(der) {
  const root = parseDer(der);
  const tbs = root.child(0);
  const sigAlg = root.child(1);
  const sigValue = root.child(2);
  const fields = tbs.children;
  let idx = 0;
  let version = 1;
  if (fields[0].cls === 2 && fields[0].tag === 0) {
    // [0] EXPLICIT version
    version = Number(parseDer(fields[0].value).int()) + 1;
    idx = 1;
  }
  const serial = fields[idx++];
  const tbsSigAlg = fields[idx++];
  const issuer = fields[idx++];
  const validity = fields[idx++];
  const subject = fields[idx++];
  const spki = fields[idx++];
  const spkiAlg = spki.child(0);
  const spkiBits = spki.child(1);
  const publicKey = spkiBits.octets();
  const notBefore = validity.child(0).generalizedOrUtc();
  const notAfter = validity.child(1).generalizedOrUtc();
  const extensions = [];
  for (let i = idx; i < fields.length; i += 1) {
    const f = fields[i];
    if (f.cls === 2 && f.tag === 3) {
      const seq = parseDer(f.value);
      for (const ext of seq.children) {
        if (ext.cls !== 0 || ext.tag !== TAG.SEQUENCE) continue;
        const oid = ext.child(0).oid();
        const critical = ext.children.length === 3 ? ext.child(1).value[0] !== 0 : false;
        const valueNode = ext.children.length === 3 ? ext.child(2) : ext.child(1);
        extensions.push({ oid, critical, value: valueNode.octets(), raw: ext.raw });
      }
    }
  }
  return {
    raw: der,
    tbsRaw: tbs.raw,
    version,
    serial: serial.intHex(),
    signatureAlgorithm: tbsSigAlg.child(0).oid(),
    signatureValue: sigValue.octets(),
    issuerRaw: issuer.raw,
    issuer: issuerNameString(issuer),
    subjectRaw: subject.raw,
    subject: issuerNameString(subject),
    notBefore,
    notAfter,
    publicKey,
    publicKeyAlgorithm: spkiAlg.child(0).oid(),
    extensions,
  };
}

/** 读取 GeneralizedTime/UTCTime 为 Date。 */
DerNode.prototype.generalizedOrUtc = function generalizedOrUtc() {
  const s = new TextDecoder('ascii').decode(this.value);
  if (this.tag === TAG.UTC_TIME) {
    // YYMMDDHHMMSSZ
    const yy = Number(s.slice(0, 2));
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return new Date(Date.UTC(year, Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)),
      Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12))));
  }
  // YYYYMMDDHHMMSSZ（可能带小数秒）
  return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12)),
    Number(s.slice(12, 14))));
};

/** 将 X.500 Name 的 DER 粗略转为可读字符串。 */
export function issuerNameString(nameSeq) {
  const parts = [];
  for (const rdn of nameSeq.children) {
    for (const atv of rdn.children) {
      const oid = atv.child(0).oid();
      const val = atv.child(1);
      const text = val.tag === TAG.UTF8_STRING ? val.utf8()
        : val.tag === TAG.IA5_STRING ? val.ia5()
          : val.tag === TAG.PRINTABLE_STRING ? new TextDecoder('ascii').decode(val.value)
            : bytesToHex(val.value);
      const label = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.6': 'C', '2.5.4.8': 'ST', '2.5.4.7': 'L' }[oid] || oid;
      parts.push(`${label}=${text}`);
    }
  }
  return parts.join(',');
}

/**
 * 解析 ContentInfo(SignedData) 为通用结构。
 * 用于 GB/T 35275 签名值与 GM/T 0033 时间戳令牌。
 */
export function parseSignedData(contentInfoDer) {
  const ci = parseDer(contentInfoDer);
  const contentType = ci.child(0).oid();
  const explicit = ci.child(1);
  const signedData = parseDer(explicit.value);
  const version = signedData.child(0).int();
  const digestAlgorithms = signedData.child(1).children.map((x) => x.child(0).oid());
  const encap = signedData.child(2);
  const encapType = encap.child(0).oid();
  const eContentNode = encap.child(1);
  let eContent = null;
  if (eContentNode) {
    // [0] EXPLICIT OCTET STRING
    const inner = parseDer(eContentNode.value);
    eContent = inner.octets();
  }
  const certs = [];
  let signerInfosNode = null;
  for (let i = 3; i < signedData.children.length; i += 1) {
    const node = signedData.children[i];
    if (node.cls === 2 && node.tag === 0) {
      // certificates [0] IMPLICIT SET OF Certificate
      for (const c of node.children) {
        if (c.cls === 0 && c.tag === TAG.SEQUENCE) {
          try {
            certs.push(parseCertificate(c.raw));
          } catch {
            // 忽略无法解析的证书（例如属性证书）
          }
        }
      }
    } else if (node.cls === 0 && node.tag === TAG.SET) {
      signerInfosNode = node;
    }
  }
  const signerInfos = (signerInfosNode ? signerInfosNode.children : []).map(parseSignerInfo);
  return { contentType, encapType, eContent, certs, signerInfos, raw: ci.raw, signedDataRaw: signedData.raw };
}

function parseSignerInfo(node) {
  const children = node.children;
  let idx = 0;
  const version = children[idx++].int();
  const sid = children[idx++];
  let issuerSerial = null;
  if (sid.cls === 0 && sid.tag === TAG.SEQUENCE) {
    const issuer = sid.child(0);
    const serial = sid.child(1);
    issuerSerial = { issuerRaw: issuer.raw, serial: serial.intHex() };
  } else {
    issuerSerial = { subjectKeyIdentifier: sid.octets() };
  }
  const digestAlgorithm = children[idx++].child(0).oid();
  let authenticatedAttributes = null;
  if (children[idx] && children[idx].cls === 2 && children[idx].tag === 0) {
    authenticatedAttributes = children[idx++];
  }
  const signatureAlgorithm = children[idx++].child(0).oid();
  const signature = children[idx++].octets();
  return {
    version,
    issuerSerial,
    digestAlgorithm,
    authenticatedAttributes,
    signatureAlgorithm,
    signature,
  };
}

/**
 * 在 CMS AuthenticatedAttributes 中取 messageDigest。
 * DER 签名原文是 SET OF 标签（0x31）后的完整编码。
 */
export function getAuthenticatedAttributesInfo(node) {
  const attrs = node.children;
  let messageDigest = null;
  for (const attr of attrs) {
    const oid = attr.child(0).oid();
    if (oid === '1.2.840.113549.1.9.4') {
      const set = attr.child(1);
      messageDigest = set.child(0).octets();
    }
  }
  const content = node.value;
  return {
    messageDigest,
    signedContent: concatBytes(Uint8Array.of(0x31), encodeLength(content.length), content),
  };
}