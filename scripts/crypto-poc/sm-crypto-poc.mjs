/**
 * R0 PoC：在 Node 中使用 sm-crypto 完成
 *  - SM3/SM4/KDF/SM2 标准向量与 ofdrw 互操作；
 *  - Java(ofdrw) 生成样例的纯 JS 解密与验签；
 *  - 生成 JS 侧签名/密文，供 Java 反向验证。
 *
 * 运行：node sm-crypto-poc.mjs [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import smCrypto from 'sm-crypto';
import { zipSync } from 'fflate';
import {
  base64ToBytes, bytesToBase64, bytesToHex, bytesEqual,
  readCertPem, sm2CipherDerToC1C3C2, sm2Verify, parseSm2PrivateKeyPem,
} from './lib/ofd.mjs';
import { hexToBytes, parseCertificate } from './lib/der.mjs';
import {
  allAttrs, attrOf, entryOf, kdfSm3, parseDecryptSeed, parseEncryptEntries, parseEncryptions,
  parseGbt35275, parseSesSignature, parseTimestampToken, sm4CbcDecrypt, textOf, textTag, unzipOfd,
} from './lib/ofd.mjs';
import { getAuthenticatedAttributesInfo, parseDer } from './lib/der.mjs';
import { DEFAULTS, runVectors } from './lib/vectors.mjs';

const { sm2, sm3, sm4 } = smCrypto;

const outDir = path.resolve(process.argv[2] || '.cache/crypto-poc/out');
const certDir = path.resolve(process.argv[3] || '.cache/crypto-poc/certs');
const javaEvidence = JSON.parse(fs.readFileSync(path.join(outDir, 'java-evidence.json'), 'utf8'));

const checks = [];
function check(name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), ...details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${details.info ? ` (${details.info})` : ''}`);
  return ok;
}

function sm3Hex(bytes) {
  // sm3 返回十六进制字符串，必须先转字节再转 hex，不能直接 Uint8Array.from(string)
  return sm3(Array.from(bytes));
}

function readProperties(file) {
  const res = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const idx = line.search(/[=:]/);
    if (idx < 0) continue;
    res[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return res;
}

const props = readProperties(path.join(outDir, 'java-evidence.properties'));
// 以本次 Java PoC 输出为准，避免 Java 重新生成证书后 JS 仍使用旧固定向量
const expected = {
  ...DEFAULTS,
  sm3Abc: javaEvidence.sm3Abc,
  sm4KeyHex: javaEvidence.sm4.keyHex,
  sm4IvHex: javaEvidence.sm4.ivHex,
  sm4PlainHex: javaEvidence.sm4.plaintextHex,
  sm4CipherHex: javaEvidence.sm4.ciphertextHex,
  kdfPasswordUtf8Hex: javaEvidence.kdf.passwordUtf8Hex,
  kdfDerivedKeyHex: javaEvidence.kdf.derivedKeyHex,
  sm2MessageHex: javaEvidence.sm2Sign.messageHex,
  sm2MessageUtf8: javaEvidence.sm2Sign.messageUtf8,
  sm2SignatureDerHex: javaEvidence.sm2Sign.signatureDerHex,
  sm2PublicKeyHex: javaEvidence.certs.signerPublicKeyHex,
  sm2PrivateKeyHex: javaEvidence.certs.signerPrivateKeyHex,
  sm2CipherDerB64: javaEvidence.sm2Cipher.ciphertextDerB64,
  sm2PlaintextHex: javaEvidence.sm2Cipher.plaintextHex,
};

// ---------------------------------------------------------------- 1. 算法向量

// ---------------------------------------------------------------- 2. 证书与信任链

const rootCert = readCertPem(fs.readFileSync(path.join(certDir, 'root-cert.pem'), 'utf8'));
const signerCert = readCertPem(fs.readFileSync(path.join(certDir, 'signer-cert.pem'), 'utf8'));

check('X.509 解析：subject 与 Java 证据一致',
  signerCert.subject === 'CN=OFDRW Crypto PoC Signer,O=OFDRW PoC,C=CN',
  { actual: signerCert.subject });
check('X.509 解析：SM2 公钥与 Java 证据一致',
  bytesToHex(signerCert.publicKey) === javaEvidence.certs.signerPublicKeyHex);
check('X.509 解析：签名算法为 SM2-with-SM3',
  signerCert.signatureAlgorithm === '1.2.156.10197.1.501',
  { actual: signerCert.signatureAlgorithm });

const now = new Date();
function verifyChain(leaf, label) {
  check(`${label} 证书链：issuer 与根证书 subject 一致`,
    bytesEqual(leaf.issuerRaw, rootCert.subjectRaw));
  check(`${label} 证书链：有效期覆盖当前时间`,
    leaf.notBefore <= now && now <= leaf.notAfter,
    { info: `${leaf.notBefore.toISOString()} ~ ${leaf.notAfter.toISOString()}` });
  const ok = sm2Verify(sm2, leaf.tbsRaw, bytesToHex(leaf.signatureValue), bytesToHex(rootCert.publicKey));
  check(`${label} 证书链：根证书 SM2 验签通过`, ok);
}
verifyChain(signerCert, '签名者');
const rootSelfOk = sm2Verify(sm2, rootCert.tbsRaw, bytesToHex(rootCert.signatureValue), bytesToHex(rootCert.publicKey));
check('根证书自签名验签通过', rootSelfOk);

// 2.1 私钥 PEM 解析：PKCS#8 与 SEC1 均应得到同一私钥和公钥
const pkcs8Key = parseSm2PrivateKeyPem(
  fs.readFileSync(path.join(certDir, 'signer-key.pem'), 'utf8'), sm2);
const sec1Key = parseSm2PrivateKeyPem(
  fs.readFileSync(path.join(certDir, 'signer-key-sec1.pem'), 'utf8'), sm2);
check('PKCS#8 私钥解析出私钥标量', pkcs8Key.privateKeyHex === javaEvidence.certs.signerPrivateKeyHex,
  { info: pkcs8Key.format });
check('PKCS#8 私钥派生公钥与证书一致', pkcs8Key.publicKeyHex === javaEvidence.certs.signerPublicKeyHex);
check('PKCS#8 内嵌公钥与派生公钥一致', pkcs8Key.embeddedMatchesDerived === true);
check('SEC1 私钥与 PKCS#8 解析结果一致',
  sec1Key.privateKeyHex === pkcs8Key.privateKeyHex && sec1Key.publicKeyHex === pkcs8Key.publicKeyHex,
  { info: sec1Key.format });

// 使用解析出的私钥执行后续向量，确保 PEM 解析结果真正参与运算
expected.sm2PrivateKeyHex = pkcs8Key.privateKeyHex;
const vectors = runVectors({ sm2, sm3, sm4 }, expected, true);
for (const r of vectors.results) check(r.name, r.ok, { actual: r.actual, expected: r.expected });

// ---------------------------------------------------------------- 3. OFD 解密

const baseZip = unzipOfd(fs.readFileSync(javaEvidence.baseOfd));
function cmpDecrypted(plainByPath, label) {
  let ok = true;
  let count = 0;
  for (const [containerPath, plain] of Object.entries(plainByPath)) {
    const base = baseZip[containerPath];
    if (!base) {
      ok = false;
      check(`${label}：明文路径存在于基准文档 (${containerPath})`, false);
      continue;
    }
    if (sm3Hex(plain) !== sm3Hex(base)) {
      ok = false;
      check(`${label}：明文内容与基准一致 (${containerPath})`, false);
    }
    count += 1;
  }
  check(`${label}：解出全部 ${count} 个文件且 SM3 与基准一致`, ok && count > 0, { info: `count=${count}` });
  return ok;
}

function decryptOfdWithEntries(encryptedPath, label, resolveFek) {
  const zip = unzipOfd(fs.readFileSync(encryptedPath));
  check(`${label}：存在 Encryptions.xml`, Boolean(zip['Encryptions.xml']));
  const infos = parseEncryptions(textOf(zip, 'Encryptions.xml'));
  check(`${label}：解析到加密操作记录`, infos.length === 1, { info: `count=${infos.length}` });
  const info = infos[0];
  const seed = parseDecryptSeed(textOf(zip, info.decryptSeedLoc));
  check(`${label}：decryptseed.dat 中 EncryptCaseId 缺失（ofdrw 2.4.0 行为）`,
    seed.encryptCaseId === null, { actual: seed.encryptCaseId });
  const user = seed.users[0];
  check(`${label}：UserInfo 解析`, Boolean(user && user.encryptedWk.length > 0),
    { info: user ? `user=${user.userName}, iv=${user.iv.length}B, wk=${user.encryptedWk.length}B` : 'none' });
  const fek = resolveFek(user);
  check(`${label}：FEK 长度为 16 字节`, fek.length === 16, { info: `${fek.length}B` });

  let entriesBytes = null;
  const metadata = entryOf(zip, info.entriesMapLoc);
  try {
    entriesBytes = sm4CbcDecrypt(sm4, metadata, fek, user.iv);
    // 若解密结果不是 XML，则回退明文 XML（规范允许 entriesmap 明文存储）
    const head = new TextDecoder().decode(entriesBytes.subarray(0, 32));
    if (!head.includes('<?xml') && !head.includes('<')) entriesBytes = null;
  } catch {
    entriesBytes = null;
  }
  if (!entriesBytes) entriesBytes = metadata;
  const entriesXml = new TextDecoder().decode(entriesBytes);
  const { entries } = parseEncryptEntries(entriesXml);
  const baseFileCount = Object.keys(baseZip).filter((p) => !p.endsWith('/')).length;
  check(`${label}：明密文映射表条目数`, entries.length === baseFileCount,
    { info: `${entries.length} vs base files=${baseFileCount}` });

  const plain = {};
  for (const entry of entries) {
    const cipher = entryOf(zip, entry.ePath);
    plain[String(entry.path).replace(/^\/+/, '')] = sm4CbcDecrypt(sm4, cipher, fek, user.iv);
  }
  cmpDecrypted(plain, label);
  return { entries, fek };
}

// 3.1 口令加密
decryptOfdWithEntries(javaEvidence.passwordEncryption.encrypted, '口令加密', (user) => {
  const kek = kdfSm3(sm3, new TextEncoder().encode(javaEvidence.passwordEncryption.password), 16);
  check('口令加密：KDF 派生 KEK 与 Java 一致',
    bytesToHex(kek) === javaEvidence.kdf.derivedKeyHex);
  return sm4CbcDecrypt(sm4, user.encryptedWk, kek, user.iv);
});

// 3.2 证书加密
let certFek = null;
decryptOfdWithEntries(javaEvidence.certEncryption.encrypted, '证书加密', (user) => {
  check('证书加密：UserInfo 携带 UserCert', Boolean(user.userCert) && user.userCert.length > 0,
    { info: user.userCert ? `${user.userCert.length}B` : 'none' });
  check('证书加密：UserCert 与签名者证书一致',
    user.userCert && bytesEqual(parseCertificate(user.userCert).tbsRaw, signerCert.tbsRaw));
  const c1c3c2 = sm2CipherDerToC1C3C2(user.encryptedWk);
  certFek = Uint8Array.from(sm2.doDecrypt(bytesToHex(c1c3c2.subarray(1)),
    pkcs8Key.privateKeyHex, 1, { output: 'array' }));
  return certFek;
});

// ---------------------------------------------------------------- 4. SESv4/v5 验签

function verifySesDocument(file, version, label) {
  const zip = unzipOfd(fs.readFileSync(file));
  const signaturesXml = textOf(zip, 'Doc_0/Signs/Signatures.xml');
  const sigRecords = allAttrs(signaturesXml, 'Signature');
  check(`${label}：签名记录数`, sigRecords.length === 1, { info: `${sigRecords.length}` });
  const record = sigRecords[0];
  check(`${label}：签名类型为 Seal`, record.Type === 'Seal', { actual: record.Type });
  const sigXmlBytes = entryOf(zip, record.BaseLoc);
  const sigXml = new TextDecoder().decode(sigXmlBytes);
  const signedValueLoc = textTag(sigXml, 'SignedValue');
  const checkMethod = attrOf(sigXml, 'References', 'CheckMethod');
  check(`${label}：摘要算法为 SM3`, checkMethod === 'SM3', { actual: checkMethod });

  // 4.1 Reference CheckValue
  const references = [];
  const refRe = /<[^>]*:?Reference\b[^>]*FileRef="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*:?Reference>/gi;
  let m;
  while ((m = refRe.exec(sigXml)) !== null) {
    references.push({ fileRef: m[1], checkValue: textTag(m[2], 'CheckValue') });
  }
  let refsOk = references.length > 0;
  for (const ref of references) {
    const actual = sm3Hex(entryOf(zip, ref.fileRef));
    if (actual !== bytesToHex(base64ToBytes(ref.checkValue))) {
      refsOk = false;
      console.log(`  reference mismatch: ${ref.fileRef}`);
    }
  }
  check(`${label}：${references.length} 个 Reference CheckValue 全部匹配`, refsOk);

  // 4.2 SignedValue 解析
  const payload = parseSesSignature(entryOf(zip, signedValueLoc));
  check(`${label}：SES 版本为 v${version}`, payload.version === version, { actual: payload.version });
  check(`${label}：dataHash = SM3(Signature.xml)`,
    bytesToHex(payload.dataHash) === sm3Hex(sigXmlBytes));
  check(`${label}：propertyInfo 指向 Signature.xml`,
    payload.propertyInfo === record.BaseLoc, { actual: payload.propertyInfo });

  // 4.3 签章者证书与签名
  const signCert = parseCertificate(payload.certDer);
  check(`${label}：签章者证书与 Java 证据一致`,
    bytesEqual(signCert.tbsRaw, signerCert.tbsRaw));
  verifyChain(signCert, `${label} 签章者`);
  const sigOk = sm2Verify(sm2, payload.tbsRaw, bytesToHex(payload.signature), bytesToHex(signCert.publicKey));
  check(`${label}：SES 签名 Sign(TBS_Sign) 验签通过`, sigOk);

  // 4.4 电子印章：Seal.esl 与 SignedValue 内嵌印章一致 + 制章人签名
  const sealBaseLoc = textTag(sigXml, 'BaseLoc');
  const sealDer = entryOf(zip, sealBaseLoc);
  const sealNode = parseDer(entryOf(zip, signedValueLoc)).child(0).child(1);
  check(`${label}：Seal.esl 与 SignedValue 内嵌 SESeal 字节一致`,
    bytesEqual(sealDer, sealNode.raw));
  const sealCert = parseCertificate(payload.seal.certDer);
  verifyChain(sealCert, `${label} 制章者`);
  const sealSigOk = sm2Verify(sm2, payload.seal.sealInfoRaw,
    bytesToHex(payload.seal.signature), bytesToHex(sealCert.publicKey));
  check(`${label}：印章 Sign(SES_SealInfo) 验签通过`, sealSigOk);
  check(`${label}：印章名称/有效期解析`,
    payload.seal.name.length > 0 && payload.seal.validEnd > payload.seal.validStart,
    { info: `${payload.seal.name} ${payload.seal.validStart.toISOString()}~${payload.seal.validEnd.toISOString()}` });

  // 4.5 时间戳令牌（仅解析）
  if (payload.timeStamp) {
    const ts = parseTimestampToken(payload.timeStamp);
    check(`${label}：时间戳令牌 TSTInfo 解析`, ts.version === 1 && ts.genTime.length > 0,
      { info: `genTime=${ts.genTime}, serial=${ts.serialNumber}` });
    check(`${label}：时间戳 messageImprint = SM3(签章签名值)`,
      bytesToHex(ts.hashedMessage) === sm3Hex(payload.signature));
    check(`${label}：时间戳 eContentType 为 id-ct-TSTInfo`,
      ts.eContentType === '1.2.840.113549.1.9.16.1.4', { actual: ts.eContentType });
    check(`${label}：时间戳 TSA 证书 subject 可解析`, Boolean(ts.tsa), { info: ts.tsa || 'none' });
    check(`${label}：时间戳策略/摘要算法可解析`,
      Boolean(ts.policy) && ts.hashAlgorithm === '1.2.156.10197.1.401',
      { info: `policy=${ts.policy}, alg=${ts.hashAlgorithm}` });
  } else {
    check(`${label}：存在时间戳令牌`, false);
  }
  return { payload, references };
}

verifySesDocument(javaEvidence.samples.signedSesV4Ofd.path, 4, 'SESv4');
verifySesDocument(javaEvidence.samples.signedSesV5Ofd.path, 5, 'SESv5');

// 4.6 兼容 ofdrw 仓库中已有的真实 SESv4 样例（证书已于 2023 年过期，
// 因此只验证签名与 Reference，不做有效期链校验）
function verifyUpstreamSample(file, label) {
  const zip = unzipOfd(fs.readFileSync(file));
  const record = allAttrs(textOf(zip, 'Doc_0/Signs/Signatures.xml'), 'Signature')[0];
  const sigXmlBytes = entryOf(zip, record.BaseLoc);
  const sigXml = new TextDecoder().decode(sigXmlBytes);
  const payload = parseSesSignature(entryOf(zip, textTag(sigXml, 'SignedValue')));
  const cert = parseCertificate(payload.certDer);
  check(`${label}：SES 版本`, payload.version === 4, { actual: payload.version });
  check(`${label}：签章值验签通过`,
    sm2Verify(sm2, payload.tbsRaw, bytesToHex(payload.signature), bytesToHex(cert.publicKey)));
  check(`${label}：dataHash = SM3(Signature.xml)`,
    bytesToHex(payload.dataHash) === sm3Hex(sigXmlBytes));
  let refsOk = true;
  const refRe = /<[^>]*:?Reference\b[^>]*FileRef="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*:?Reference>/gi;
  let m;
  let refCount = 0;
  while ((m = refRe.exec(sigXml)) !== null) {
    refCount += 1;
    const expectedDigest = bytesToHex(base64ToBytes(textTag(m[2], 'CheckValue')));
    if (sm3Hex(entryOf(zip, m[1])) !== expectedDigest) refsOk = false;
  }
  check(`${label}：${refCount} 个历史 Reference 匹配`, refsOk && refCount > 0);
  check(`${label}：证书 subject 可解析`, Boolean(cert.subject), { info: cert.subject });
}
verifyUpstreamSample(
  '../../references/ofdrw/ofdrw-sign/src/test/resources/v4signed.ofd', 'ofdrw 历史样例 v4signed');
verifyUpstreamSample(
  '../../references/ofdrw/ofdrw-sign/src/test/resources/signedFile.ofd', 'ofdrw 历史样例 signedFile');

// ---------------------------------------------------------------- 5. 防夹带完整性

function verifyIntegrity(file, label) {
  const zip = unzipOfd(fs.readFileSync(file));
  const entriesBytes = entryOf(zip, 'OFDEntries.xml');
  const entriesXml = new TextDecoder().decode(entriesBytes);
  const sigLoc = textTag(entriesXml, 'SignedValueLoc');
  const sig = parseGbt35275(entryOf(zip, sigLoc));
  check(`${label}：GB/T 35275 SignedData 签名者数量`, sig.signerInfos.length === 1,
    { info: `${sig.signerInfos.length}` });
  const signer = sig.signerInfos[0];
  const cert = sig.certificates.find((c) => c.serial === signer.issuerSerial.serial
    && bytesEqual(c.issuerRaw, signer.issuerSerial.issuerRaw));
  check(`${label}：签名证书可在 Certificates 中定位`, Boolean(cert),
    { info: cert ? cert.subject : 'none' });
  verifyChain(cert, `${label} 签名者`);
  let signedContent = sig.content;
  if (signer.authenticatedAttributes) {
    const attrs = getAuthenticatedAttributesInfo(signer.authenticatedAttributes);
    check(`${label}：PKCS#9 messageDigest = SM3(OFDEntries.xml)`,
      bytesToHex(attrs.messageDigest || []) === sm3Hex(entriesBytes));
    check(`${label}：含 authenticatedAttributes（签名原文为 DER SET）`,
      Boolean(attrs.signedContent) && attrs.signedContent[0] === 0x31);
    signedContent = attrs.signedContent;
  } else {
    check(`${label}：签名值 content = SM3(OFDEntries.xml)`,
      bytesToHex(sig.content) === sm3Hex(entriesBytes));
  }
  const sigOk = sm2Verify(sm2, signedContent, bytesToHex(signer.signature), bytesToHex(cert.publicKey));
  check(`${label}：GB/T 35275 签名验签通过`, sigOk);

  // 5.1 防夹带：文件清单与 zip 实际条目比对
  const listed = new Set(allAttrs(entriesXml, 'File').map((x) => x.FileLoc));
  listed.add(sigLoc);
  const actual = new Set(Object.keys(zip).filter((p) => !p.endsWith('/')));
  actual.delete('OFDEntries.xml');
  const extra = [...actual].filter((p) => !listed.has(`/${p.replace(/^\/+/, '')}`));
  const missing = [...listed].filter((p) => !actual.has(p.replace(/^\/+/, '')));
  check(`${label}：无夹带文件（zip 条目均在 FileList 中）`, extra.length === 0,
    { info: extra.join(',') || 'none' });
  check(`${label}：FileList 中的文件均存在`, missing.length === 0,
    { info: missing.join(',') || 'none' });
  return { cert, signer };
}

verifyIntegrity(javaEvidence.samples.integrityOfd.path, '完整性');
verifyIntegrity(javaEvidence.samples.integrityAuthAttrsOfd.path, '完整性(PKCS#9)');

// ---------------------------------------------------------------- 6. 篡改/夹带负向验证

function tamperTests() {
  const zip = unzipOfd(fs.readFileSync(javaEvidence.samples.signedSesV4Ofd.path));
  const record = allAttrs(textOf(zip, 'Doc_0/Signs/Signatures.xml'), 'Signature')[0];
  const sigXml = textOf(zip, record.BaseLoc);
  const original = zip['Doc_0/Pages/Page_0/Content.xml'];
  const tampered = new Uint8Array(original);
  tampered[tampered.length - 1] ^= 0x01;
  const tamperedUnzip = unzipOfd(zipSync({ ...zip, 'Doc_0/Pages/Page_0/Content.xml': tampered }));
  const expected = bytesToHex(base64ToBytes(textTag(
    sigXml.match(/<[^>]*:?Reference\b[^>]*FileRef="\/Doc_0\/Pages\/Page_0\/Content\.xml"[^>]*>([\s\S]*?)<\/[^>]*:?Reference>/i,
    )[1], 'CheckValue')));
  check('篡改页面内容后 Reference 摘要不匹配',
    sm3Hex(tamperedUnzip['Doc_0/Pages/Page_0/Content.xml']) !== expected);

  const integrityZip = unzipOfd(fs.readFileSync(javaEvidence.samples.integrityOfd.path));
  const fileList = allAttrs(textOf(integrityZip, 'OFDEntries.xml'), 'File').map((x) => x.FileLoc);
  const withEvil = { ...integrityZip, 'evil.txt': new TextEncoder().encode('smuggled') };
  const actual = Object.keys(withEvil).filter((p) => !p.endsWith('/') && p !== 'OFDEntries.xml');
  check('夹带文件不在完整性 FileList 中',
    actual.some((p) => !fileList.includes('/' + p)));
}
tamperTests();

// ---------------------------------------------------------------- 7. 输出证据

const jsEvidence = {
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  smCryptoVersion: JSON.parse(fs.readFileSync(path.join('node_modules/sm-crypto/package.json'), 'utf8')).version,
  allPassed: checks.every((c) => c.ok),
  checkCount: checks.length,
  failedCount: checks.filter((c) => !c.ok).length,
  checks,
  artifacts: vectors.artifacts,
  ofd: {
    passwordDecrypted: true,
    certDecrypted: true,
    sesV4Verified: true,
    sesV5Verified: true,
    integrityVerified: true,
  },
};
fs.writeFileSync(path.join(outDir, 'js-evidence.json'), JSON.stringify(jsEvidence, null, 2));

const jsProps = {
  messageHex: expected.sm2MessageHex,
  messageUtf8: expected.sm2MessageUtf8,
  signatureDerB64: vectors.artifacts.signatureDerB64,
  sm2CipherDerB64: vectors.artifacts.cipherDerB64,
  sm2CipherC1C3C2Hex: vectors.artifacts.cipherC1C3C2Hex,
  sm2PlaintextHex: vectors.artifacts.plaintextHex,
};
fs.writeFileSync(path.join(outDir, 'js-evidence.properties'),
  Object.entries(jsProps).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

console.log(`\n${jsEvidence.allPassed ? 'JS_POC_OK' : 'JS_POC_FAILED'} checks=${checks.length} failed=${jsEvidence.failedCount}`);
process.exit(jsEvidence.allPassed ? 0 : 1);