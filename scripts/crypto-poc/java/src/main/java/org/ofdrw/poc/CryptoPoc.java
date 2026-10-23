package org.ofdrw.poc;

import org.bouncycastle.asn1.ASN1EncodableVector;
import org.bouncycastle.asn1.ASN1GeneralizedTime;
import org.bouncycastle.asn1.ASN1Integer;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.DERBitString;
import org.bouncycastle.asn1.DERIA5String;
import org.bouncycastle.asn1.DEROctetString;
import org.bouncycastle.asn1.DERSequence;
import org.bouncycastle.asn1.DERUTF8String;
import org.bouncycastle.asn1.gm.GMObjectIdentifiers;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.ExtendedKeyUsage;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyPurposeId;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.X509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509ExtensionUtils;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.cms.jcajce.JcaSimpleSignerInfoGeneratorBuilder;
import org.bouncycastle.crypto.engines.SM2Engine;
import org.bouncycastle.crypto.engines.SM4Engine;
import org.bouncycastle.crypto.modes.CBCBlockCipher;
import org.bouncycastle.crypto.paddings.PKCS7Padding;
import org.bouncycastle.crypto.paddings.PaddedBufferedBlockCipher;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;
import org.bouncycastle.crypto.params.ECPublicKeyParameters;
import org.bouncycastle.crypto.params.KeyParameter;
import org.bouncycastle.crypto.params.ParametersWithIV;
import org.bouncycastle.crypto.params.ParametersWithRandom;
import org.bouncycastle.jcajce.provider.digest.SM3;
import org.bouncycastle.jcajce.provider.asymmetric.util.ECUtil;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.openssl.PEMKeyPair;
import org.bouncycastle.openssl.PEMParser;
import org.bouncycastle.openssl.jcajce.JcaPEMKeyConverter;
import org.bouncycastle.openssl.jcajce.JcaPEMWriter;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.bouncycastle.cert.jcajce.JcaCertStore;
import org.bouncycastle.operator.jcajce.JcaDigestCalculatorProviderBuilder;
import org.bouncycastle.tsp.TimeStampRequest;
import org.bouncycastle.tsp.TimeStampRequestGenerator;
import org.bouncycastle.tsp.TimeStampToken;
import org.bouncycastle.tsp.TimeStampTokenGenerator;
import org.bouncycastle.util.io.pem.PemObject;
import org.bouncycastle.util.io.pem.PemWriter;
import org.bouncycastle.cms.SignerInfoGenerator;
import org.ofdrw.core.integrity.OFDEntries;
import org.ofdrw.gm.ses.v1.SES_ESPictrueInfo;
import org.ofdrw.gm.ses.v4.CertInfoList;
import org.ofdrw.gm.ses.v4.SES_CertList;
import org.ofdrw.gm.sm2strut.SM2Cipher;
import org.ofdrw.crypto.OFDDecryptor;
import org.ofdrw.crypto.OFDEncryptor;
import org.ofdrw.crypto.decryptor.UserCertDecryptor;
import org.ofdrw.crypto.decryptor.UserPasswordDecryptor;
import org.ofdrw.crypto.enryptor.UserCertEncryptor;
import org.ofdrw.crypto.enryptor.UserPasswordEncryptor;
import org.ofdrw.crypto.integrity.GMProtectSigner;
import org.ofdrw.crypto.integrity.ProtectSigner;
import org.ofdrw.gm.sm2strut.ContentInfo;
import org.ofdrw.gm.sm2strut.OIDs;
import org.ofdrw.gm.sm2strut.builder.PKCS9SignedDataBuilder;
import org.ofdrw.crypto.integrity.GMProtectVerifier;
import org.ofdrw.crypto.integrity.OFDIntegrity;
import org.ofdrw.crypto.integrity.OFDIntegrityVerifier;
import org.ofdrw.gm.support.KDF;
import org.ofdrw.reader.OFDReader;
import org.ofdrw.sign.OFDSigner;
import org.ofdrw.sign.SignMode;
import org.ofdrw.sign.signContainer.SESV4Container;
import org.ofdrw.sign.signContainer.SESV5Container;
import org.ofdrw.sign.stamppos.NormalStampPos;
import org.ofdrw.sign.verify.OFDValidator;
import org.ofdrw.sign.verify.container.SESV4ValidateContainer;
import org.ofdrw.sign.verify.container.SESV5ValidateContainer;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Security;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeMap;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/**
 * R0 密码学 PoC：
 * <ol>
 *   <li>生成 SM2 根证书、签名者证书、制章者证书、TSA 证书；</li>
 *   <li>生成口令加密、证书加密、SESv4/SESv5 签章、防夹带完整性样例；</li>
 *   <li>使用 ofdrw Java 侧解密/验签交叉验证；</li>
 *   <li>导出 JS 侧互操作所需的 SM2/SM3/SM4/KDF 证据；</li>
 *   <li>verify-js 模式校验 JS 生成的 SM2 签名与 SM2Cipher。</li>
 * </ol>
 * 所有产物写入 .cache/crypto-poc，不提交二进制样例。
 */
public final class CryptoPoc {

    static {
        Security.addProvider(new BouncyCastleProvider());
    }

    private static final String PASSWORD = "PocPass123";
    private static final String PASSWORD_USER = "poc-password-user";
    private static final String CERT_USER = "poc-cert-user";
    private static final String SM2_MESSAGE = "OFDRW-CRYPTO-POC-MESSAGE-中文";
    private static final String USER_ID = "1234567812345678";

    private final Path outDir;
    private final Path certDir;
    private final Path baseOfd;

    private CryptoPoc(Path outDir, Path certDir, Path baseOfd) {
        this.outDir = outDir;
        this.certDir = certDir;
        this.baseOfd = baseOfd;
    }

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "verify-js".equals(args[0])) {
            Path jsProps = Paths.get(args.length > 1 ? args[1]
                    : ".cache/crypto-poc/out/js-evidence.properties");
            Path certDir = Paths.get(args.length > 2 ? args[2] : ".cache/crypto-poc/certs");
            verifyJs(jsProps, certDir);
            return;
        }
        Path outDir = Paths.get(args.length > 0 ? args[0] : ".cache/crypto-poc/out");
        Path certDir = Paths.get(args.length > 1 ? args[1] : ".cache/crypto-poc/certs");
        Path baseOfd = Paths.get(args.length > 2 ? args[2]
                : "references/ofdrw/ofdrw-crypto/src/test/resources/hello.ofd");
        Files.createDirectories(outDir);
        Files.createDirectories(certDir);
        if (Files.notExists(baseOfd)) {
            throw new IllegalArgumentException("基准 OFD 不存在: " + baseOfd.toAbsolutePath());
        }
        new CryptoPoc(outDir, certDir, baseOfd).run();
    }

    private void run() throws Exception {
        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("generatedAt", LocalDateTime.now().toString());
        evidence.put("javaVersion", System.getProperty("java.version"));
        evidence.put("javaVendor", System.getProperty("java.vendor"));
        evidence.put("ofdrwVersion", "2.4.0");
        evidence.put("baseOfd", baseOfd.toAbsolutePath().toString());
        evidence.put("baseOfdSha256", sha256Hex(Files.readAllBytes(baseOfd)));

        // 1. 证书体系：root -> signer / seal / tsa
        Path rootCertPem = certDir.resolve("root-cert.pem");
        Path signerCertPem = certDir.resolve("signer-cert.pem");
        Path signerKeyPem = certDir.resolve("signer-key.pem");
        Path signerKeySec1Pem = certDir.resolve("signer-key-sec1.pem");
        Path sealCertPem = certDir.resolve("seal-cert.pem");
        Path sealKeyPem = certDir.resolve("seal-key.pem");
        Path tsaCertPem = certDir.resolve("tsa-cert.pem");
        Path tsaKeyPem = certDir.resolve("tsa-key.pem");

        KeyPair rootKp = generateKeyPair();
        X509Certificate rootCert = selfSignedRoot(rootKp, "CN=OFDRW Crypto PoC Root,O=OFDRW PoC,C=CN");
        KeyPair signerKp = generateKeyPair();
        X509Certificate signerCert = issueCert(signerKp,
                "CN=OFDRW Crypto PoC Signer,O=OFDRW PoC,C=CN", rootCert, rootKp.getPrivate(), false);
        KeyPair sealKp = generateKeyPair();
        X509Certificate sealCert = issueCert(sealKp,
                "CN=OFDRW Crypto PoC Seal Maker,O=OFDRW PoC,C=CN", rootCert, rootKp.getPrivate(), false);
        KeyPair tsaKp = generateKeyPair();
        X509Certificate tsaCert = issueCert(tsaKp,
                "CN=OFDRW Crypto PoC TSA,O=OFDRW PoC,C=CN", rootCert, rootKp.getPrivate(), false,
                KeyPurposeId.id_kp_timeStamping, true);

        writePem(rootCertPem, rootCert);
        writePem(signerCertPem, signerCert);
        writePkcs8Pem(signerKeyPem, signerKp.getPrivate());
        writePem(signerKeySec1Pem, signerKp.getPrivate());
        writePem(sealCertPem, sealCert);
        writePkcs8Pem(sealKeyPem, sealKp.getPrivate());
        writePem(tsaCertPem, tsaCert);
        writePkcs8Pem(tsaKeyPem, tsaKp.getPrivate());

        String signerPubHex = publicKeyHex(signerKp.getPublic());
        String signerPrivHex = privateKeyHex(signerKp.getPrivate());
        evidence.put("certs", mapOf(
                "rootCertPem", rootCertPem.toAbsolutePath().toString(),
                "signerCertPem", signerCertPem.toAbsolutePath().toString(),
                "signerKeyPem", signerKeyPem.toAbsolutePath().toString(),
                "signerKeySec1Pem", signerKeySec1Pem.toAbsolutePath().toString(),
                "sealCertPem", sealCertPem.toAbsolutePath().toString(),
                "sealKeyPem", sealKeyPem.toAbsolutePath().toString(),
                "tsaCertPem", tsaCertPem.toAbsolutePath().toString(),
                "tsaKeyPem", tsaKeyPem.toAbsolutePath().toString(),
                "rootSubject", rootCert.getSubjectX500Principal().getName(),
                "rootNotBefore", rootCert.getNotBefore().toInstant().toString(),
                "rootNotAfter", rootCert.getNotAfter().toInstant().toString(),
                "signerSubject", signerCert.getSubjectX500Principal().getName(),
                "signerIssuer", signerCert.getIssuerX500Principal().getName(),
                "signerNotBefore", signerCert.getNotBefore().toInstant().toString(),
                "signerNotAfter", signerCert.getNotAfter().toInstant().toString(),
                "signerCertSha256", sha256Hex(signerCert.getEncoded()),
                "rootCertSha256", sha256Hex(rootCert.getEncoded()),
                "signerPublicKeyHex", signerPubHex,
                "signerPrivateKeyHex", signerPrivHex));

        // 2. 基础算法证据
        byte[] abc = "abc".getBytes(StandardCharsets.UTF_8);
        String sm3Abc = hex(sm3(abc));
        evidence.put("sm3Abc", sm3Abc);

        byte[] kdfKey = KDF.extend(new SM3.Digest(), PASSWORD.getBytes(StandardCharsets.UTF_8), 16);
        evidence.put("kdf", mapOf(
                "password", PASSWORD,
                "passwordUtf8Hex", hex(PASSWORD.getBytes(StandardCharsets.UTF_8)),
                "klen", 16,
                "derivedKeyHex", hex(kdfKey)));

        byte[] sm4Key = hexToBytes("0123456789abcdeffedcba9876543210");
        byte[] sm4Iv = hexToBytes("000102030405060708090a0b0c0d0e0f");
        byte[] sm4Plain = "OFD crypto PoC SM4-CBC PKCS#7 中文".getBytes(StandardCharsets.UTF_8);
        byte[] sm4Cipher = sm4CbcEncrypt(sm4Plain, sm4Key, sm4Iv);
        evidence.put("sm4", mapOf(
                "keyHex", hex(sm4Key),
                "ivHex", hex(sm4Iv),
                "plaintextUtf8", new String(sm4Plain, StandardCharsets.UTF_8),
                "plaintextHex", hex(sm4Plain),
                "ciphertextHex", hex(sm4Cipher)));

        // 3. SM2 签名（Java BC，默认用户 ID 1234567812345678）
        byte[] msg = SM2_MESSAGE.getBytes(StandardCharsets.UTF_8);
        byte[] sm2Sig = sm2Sign(msg, signerKp.getPrivate());
        boolean sm2SelfVerified = sm2Verify(msg, sm2Sig, signerKp.getPublic());
        evidence.put("sm2Sign", mapOf(
                "messageUtf8", SM2_MESSAGE,
                "messageHex", hex(msg),
                "userId", USER_ID,
                "signatureDerB64", Base64.getEncoder().encodeToString(sm2Sig),
                "signatureDerHex", hex(sm2Sig),
                "verifiedByJava", sm2SelfVerified));

        // 4. SM2 加密：16 字节 FEK 样例，输出 C1C3C2 与 ASN.1 SM2Cipher DER
        byte[] fekSample = hexToBytes("00112233445566778899aabbccddeeff");
        SM2Engine engine = new SM2Engine(SM2Engine.Mode.C1C3C2);
        engine.init(true, new ParametersWithRandom(
                (ECPublicKeyParameters) ECUtil.generatePublicKeyParameter(signerKp.getPublic()), new SecureRandom()));
        byte[] c1c3c2 = engine.processBlock(fekSample, 0, fekSample.length);
        SM2Cipher cipher = SM2Cipher.fromC1C3C2(c1c3c2);
        byte[] cipherDer = cipher.getEncoded();
        evidence.put("sm2Cipher", mapOf(
                "plaintextHex", hex(fekSample),
                "ciphertextC1C3C2Hex", hex(c1c3c2),
                "ciphertextDerB64", Base64.getEncoder().encodeToString(cipherDer),
                "ciphertextDerHex", hex(cipherDer)));

        // 5. 受保护样例生成 + Java 侧交叉验证
        String baseName = "hello";
        Map<String, Object> samples = new LinkedHashMap<>();

        Path pwdEnc = outDir.resolve("password-encrypted.ofd");
        Path pwdDec = outDir.resolve("password-decrypted.ofd");
        try (OFDEncryptor enc = new OFDEncryptor(baseOfd, pwdEnc)) {
            // ofdrw 2.4.0 的 OFDEncryptor 未写入 EncryptCaseId，解密器按缺省方案匹配
            enc.addUser(new UserPasswordEncryptor(PASSWORD_USER, PASSWORD));
            enc.encrypt();
        }
        try (OFDDecryptor dec = new OFDDecryptor(pwdEnc, pwdDec)) {
            dec.addUser(new UserPasswordDecryptor(PASSWORD_USER, PASSWORD));
            dec.decrypt();
        }
        boolean pwdContentEqual = zipContentsEqual(baseOfd, pwdDec);
        samples.put("passwordEncryptedOfd", sampleInfo(pwdEnc));
        samples.put("passwordDecryptedOfd", sampleInfo(pwdDec));
        samples.put("passwordRoundTripEqual", pwdContentEqual);
        evidence.put("passwordEncryption", mapOf(
                "username", PASSWORD_USER,
                "password", PASSWORD,
                "encrypted", pwdEnc.toAbsolutePath().toString(),
                "decrypted", pwdDec.toAbsolutePath().toString(),
                "roundTripContentEqual", pwdContentEqual));

        Path certEnc = outDir.resolve("cert-encrypted.ofd");
        Path certDec = outDir.resolve("cert-decrypted.ofd");
        try (OFDEncryptor enc = new OFDEncryptor(baseOfd, certEnc)) {
            enc.addUser(new UserCertEncryptor(CERT_USER, signerCert));
            enc.encrypt();
        }
        ECPrivateKeyParameters signerPrivParams =
                (ECPrivateKeyParameters) ECUtil.generatePrivateKeyParameter(signerKp.getPrivate());
        try (OFDDecryptor dec = new OFDDecryptor(certEnc, certDec)) {
            dec.addUser(new UserCertDecryptor(CERT_USER, signerPrivParams));
            dec.decrypt();
        }
        boolean certContentEqual = zipContentsEqual(baseOfd, certDec);
        samples.put("certEncryptedOfd", sampleInfo(certEnc));
        samples.put("certDecryptedOfd", sampleInfo(certDec));
        samples.put("certRoundTripEqual", certContentEqual);
        evidence.put("certEncryption", mapOf(
                "username", CERT_USER,
                "certificate", "signer-cert.pem",
                "encrypted", certEnc.toAbsolutePath().toString(),
                "decrypted", certDec.toAbsolutePath().toString(),
                "roundTripContentEqual", certContentEqual));

        // SESv4 签章（含时间戳令牌）
        org.ofdrw.gm.ses.v4.SESeal sealV4 = buildSealV4(sealKp, sealCert, signerCert);
        Path signedV4 = outDir.resolve("signed-sesv4.ofd");
        try (OFDReader reader = new OFDReader(baseOfd);
             OFDSigner signer = new OFDSigner(reader, signedV4)) {
            SESV4Container container = new SESV4Container(
                    signerKp.getPrivate(), sealV4, signerCert,
                    signatureValue -> timestampTokenSafe(signatureValue, tsaKp.getPrivate(), tsaCert, rootCert));
            signer.setSignMode(SignMode.ContinueSign);
            signer.setSignContainer(container);
            signer.addApPos(new NormalStampPos(1, 50, 50, 40, 40));
            signer.exeSign();
        }
        boolean signedV4Valid;
        try (OFDReader reader = new OFDReader(signedV4);
             OFDValidator validator = new OFDValidator(reader)) {
            validator.setValidator(new SESV4ValidateContainer());
            validator.exeValidate();
            signedV4Valid = true;
        }
        samples.put("signedSesV4Ofd", sampleInfo(signedV4));
        samples.put("signedSesV4Valid", signedV4Valid);

        // SESv5 签章
        org.ofdrw.gm.ses.v5.SESeal sealV5 = buildSealV5(sealKp, sealCert, signerCert);
        Path signedV5 = outDir.resolve("signed-sesv5.ofd");
        try (OFDReader reader = new OFDReader(baseOfd);
             OFDSigner signer = new OFDSigner(reader, signedV5)) {
            SESV5Container container = new SESV5Container(
                    signerKp.getPrivate(), sealV5, signerCert,
                    signatureValue -> timestampTokenSafe(signatureValue, tsaKp.getPrivate(), tsaCert, rootCert));
            signer.setSignMode(SignMode.ContinueSign);
            signer.setSignContainer(container);
            signer.addApPos(new NormalStampPos(1, 50, 50, 40, 40));
            signer.exeSign();
        }
        boolean signedV5Valid;
        try (OFDReader reader = new OFDReader(signedV5);
             OFDValidator validator = new OFDValidator(reader)) {
            validator.setValidator(new SESV5ValidateContainer());
            validator.exeValidate();
            signedV5Valid = true;
        }
        samples.put("signedSesV5Ofd", sampleInfo(signedV5));
        samples.put("signedSesV5Valid", signedV5Valid);

        // 防夹带完整性
        Path integrity = outDir.resolve("integrity.ofd");
        try (OFDIntegrity protector = new OFDIntegrity(baseOfd, integrity)) {
            protector.protect(new GMProtectSigner(signerKp.getPrivate(), signerCert));
        }
        boolean integrityValid = new OFDIntegrityVerifier()
                .integrity(integrity, new GMProtectVerifier());
        samples.put("integrityOfd", sampleInfo(integrity));
        samples.put("integrityValid", integrityValid);

        // 带 PKCS#9 authenticatedAttributes 的完整性签名（验证 JS 解析分支）
        Path integrityAuth = outDir.resolve("integrity-authattrs.ofd");
        ProtectSigner authSigner = tbs -> {
            byte[] raw = Files.readAllBytes(tbs);
            Signature sg = Signature.getInstance("SM3WithSM2", "BC");
            sg.initSign(signerKp.getPrivate());
            // 注意：PKCS9SignedDataBuilder 在传入扩展证书时存在证书数组下标 bug，
            // 因此这里不附加根证书；信任链由外部根证书完成。
            org.ofdrw.gm.sm2strut.SignedData sd = PKCS9SignedDataBuilder.signedData(
                    raw, sg, signerCert, null);
            return new ContentInfo(OIDs.signedData, sd).getEncoded();
        };
        try (OFDIntegrity protector = new OFDIntegrity(baseOfd, integrityAuth)) {
            protector.protect(authSigner);
        }
        boolean integrityAuthValid = new OFDIntegrityVerifier()
                .integrity(integrityAuth, new GMProtectVerifier());
        samples.put("integrityAuthAttrsOfd", sampleInfo(integrityAuth));
        samples.put("integrityAuthAttrsValid", integrityAuthValid);

        evidence.put("samples", samples);
        evidence.put("javaVerification", mapOf(
                "passwordDecryptOk", pwdContentEqual,
                "certDecryptOk", certContentEqual,
                "sesV4SignatureOk", signedV4Valid,
                "sesV5SignatureOk", signedV5Valid,
                "integrityOk", integrityValid,
                "integrityAuthAttrsOk", integrityAuthValid));

        // 6. 输出 JSON 证据与 JS 互操作输入
        String json = toJson(evidence);
        Files.writeString(outDir.resolve("java-evidence.json"), json, StandardCharsets.UTF_8);
        Properties props = new Properties();
        props.setProperty("messageHex", hex(msg));
        props.setProperty("messageUtf8", SM2_MESSAGE);
        props.setProperty("userId", USER_ID);
        props.setProperty("signatureDerB64", Base64.getEncoder().encodeToString(sm2Sig));
        props.setProperty("publicKeyHex", signerPubHex);
        props.setProperty("privateKeyHex", signerPrivHex);
        props.setProperty("sm2CipherDerB64", Base64.getEncoder().encodeToString(cipherDer));
        props.setProperty("sm2CipherC1C3C2Hex", hex(c1c3c2));
        props.setProperty("sm2PlaintextHex", hex(fekSample));
        props.setProperty("signerCertPem", signerCertPem.toAbsolutePath().toString());
        props.setProperty("rootCertPem", rootCertPem.toAbsolutePath().toString());
        props.setProperty("baseOfd", baseOfd.toAbsolutePath().toString());
        props.setProperty("password", PASSWORD);
        props.setProperty("passwordUsername", PASSWORD_USER);
        props.setProperty("certUsername", CERT_USER);
        props.setProperty("passwordEncryptedOfd", pwdEnc.toAbsolutePath().toString());
        props.setProperty("certEncryptedOfd", certEnc.toAbsolutePath().toString());
        props.setProperty("signedSesV4Ofd", signedV4.toAbsolutePath().toString());
        props.setProperty("signedSesV5Ofd", signedV5.toAbsolutePath().toString());
        props.setProperty("integrityOfd", integrity.toAbsolutePath().toString());
        props.setProperty("integrityAuthAttrsOfd", integrityAuth.toAbsolutePath().toString());
        try (OutputStream out = Files.newOutputStream(outDir.resolve("java-evidence.properties"))) {
            props.store(out, "ofdrw-viewer crypto R0 Java evidence");
        }
        System.out.println("JAVA_POC_OK " + outDir.toAbsolutePath());
        System.out.println("passwordRoundTrip=" + pwdContentEqual
                + " certRoundTrip=" + certContentEqual
                + " sesV4=" + signedV4Valid + " sesV5=" + signedV5Valid
                + " integrity=" + integrityValid);
    }

    // ---------------------------------------------------------------- 证书

    private static KeyPair generateKeyPair() throws GeneralSecurityException {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC", "BC");
        kpg.initialize(new ECGenParameterSpec("sm2p256v1"), new SecureRandom());
        return kpg.generateKeyPair();
    }

    private static X509Certificate selfSignedRoot(KeyPair kp, String dn) throws Exception {
        X500Name name = new X500Name(dn);
        Date now = new Date();
        Date from = new Date(now.getTime() - 24L * 3600 * 1000);
        Date to = new Date(now.getTime() + 3650L * 24 * 3600 * 1000);
        JcaX509ExtensionUtils ext = new JcaX509ExtensionUtils();
        X509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                name, BigInteger.valueOf(System.currentTimeMillis()), from, to, name, kp.getPublic());
        builder.addExtension(Extension.basicConstraints, true, new BasicConstraints(true));
        builder.addExtension(Extension.keyUsage, true,
                new KeyUsage(KeyUsage.keyCertSign | KeyUsage.cRLSign | KeyUsage.digitalSignature));
        builder.addExtension(Extension.subjectKeyIdentifier, false, ext.createSubjectKeyIdentifier(kp.getPublic()));
        ContentSigner signer = new JcaContentSignerBuilder("SM3withSM2").setProvider("BC").build(kp.getPrivate());
        return new JcaX509CertificateConverter().setProvider("BC").getCertificate(builder.build(signer));
    }

    private static X509Certificate issueCert(KeyPair subjectKp, String dn,
                                             X509Certificate caCert, PrivateKey caKey, boolean ca)
            throws Exception {
        return issueCert(subjectKp, dn, caCert, caKey, ca, KeyPurposeId.id_kp_clientAuth, false);
    }

    private static X509Certificate issueCert(KeyPair subjectKp, String dn,
                                             X509Certificate caCert, PrivateKey caKey, boolean ca,
                                             KeyPurposeId eku, boolean ekuCritical)
            throws Exception {
        X500Name subject = new X500Name(dn);
        X500Name issuer = X500Name.getInstance(caCert.getSubjectX500Principal().getEncoded());
        Date now = new Date();
        Date from = new Date(now.getTime() - 24L * 3600 * 1000);
        Date to = new Date(now.getTime() + 1825L * 24 * 3600 * 1000);
        JcaX509ExtensionUtils ext = new JcaX509ExtensionUtils();
        X509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                issuer, BigInteger.valueOf(System.nanoTime()), from, to, subject, subjectKp.getPublic());
        builder.addExtension(Extension.basicConstraints, true, new BasicConstraints(ca));
        int usage = KeyUsage.digitalSignature | KeyUsage.nonRepudiation;
        if (ca) {
            usage |= KeyUsage.keyCertSign | KeyUsage.cRLSign;
        }
        builder.addExtension(Extension.keyUsage, true, new KeyUsage(usage));
        if (!ca) {
            builder.addExtension(Extension.extendedKeyUsage, ekuCritical,
                    new ExtendedKeyUsage(eku));
        }
        builder.addExtension(Extension.subjectKeyIdentifier, false, ext.createSubjectKeyIdentifier(subjectKp.getPublic()));
        builder.addExtension(Extension.authorityKeyIdentifier, false, ext.createAuthorityKeyIdentifier(caCert));
        ContentSigner signer = new JcaContentSignerBuilder("SM3withSM2").setProvider("BC").build(caKey);
        return new JcaX509CertificateConverter().setProvider("BC").getCertificate(builder.build(signer));
    }

    private static void writePem(Path path, Object obj) throws IOException {
        try (OutputStream out = Files.newOutputStream(path);
             JcaPEMWriter writer = new JcaPEMWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8))) {
            writer.writeObject(obj);
        }
    }

    /** 写出 PKCS#8 PrivateKeyInfo（PEM 头为 PRIVATE KEY）。 */
    private static void writePkcs8Pem(Path path, PrivateKey key) throws IOException {
        try (OutputStream out = Files.newOutputStream(path);
             PemWriter writer = new PemWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8))) {
            writer.writeObject(new PemObject("PRIVATE KEY", key.getEncoded()));
        }
    }

    // ---------------------------------------------------------------- 印章与时间戳

    private static final byte[] ONE_PX_PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    private static org.ofdrw.gm.ses.v4.SESeal buildSealV4(KeyPair sealKp, X509Certificate sealCert,
                                                          X509Certificate signerCert) throws Exception {
        ASN1EncodableVector certArr = new ASN1EncodableVector();
        certArr.add(new DEROctetString(signerCert.getEncoded()));
        org.ofdrw.gm.ses.v4.SES_ESPropertyInfo property = new org.ofdrw.gm.ses.v4.SES_ESPropertyInfo()
                .setType(new ASN1Integer(2))
                .setName(new DERUTF8String("OFDRW Crypto PoC 测试印章"))
                .setCertListType(org.ofdrw.gm.ses.v4.SES_ESPropertyInfo.CertListType)
                .setCertList(SES_CertList.getInstance(
                        org.ofdrw.gm.ses.v4.SES_ESPropertyInfo.CertListType, new DERSequence(certArr)))
                .setCreateDate(new ASN1GeneralizedTime(new Date()))
                .setValidStart(new ASN1GeneralizedTime(new Date()))
                .setValidEnd(new ASN1GeneralizedTime(new Date(System.currentTimeMillis() + 1825L * 24 * 3600 * 1000)));
        org.ofdrw.gm.ses.v4.SES_SealInfo sealInfo = new org.ofdrw.gm.ses.v4.SES_SealInfo()
                .setHeader(new org.ofdrw.gm.ses.v1.SES_Header(
                        org.ofdrw.gm.ses.v1.SES_Header.V4, new DERIA5String("OFDRWPOC")))
                .setEsID(new DERIA5String(UUID.randomUUID().toString().replace("-", "")))
                .setProperty(property)
                .setPicture(new SES_ESPictrueInfo().setType("PNG").setData(ONE_PX_PNG).setWidth(40).setHeight(40));
        byte[] sealSig = sm2Sign(sealInfo.getEncoded("DER"), sealKp.getPrivate());
        return new org.ofdrw.gm.ses.v4.SESeal()
                .seteSealInfo(sealInfo)
                .setCert(sealCert)
                .setSignAlgID(GMObjectIdentifiers.sm2sign_with_sm3)
                .setSignedValue(sealSig);
    }

    private static org.ofdrw.gm.ses.v5.SESeal buildSealV5(KeyPair sealKp, X509Certificate sealCert,
                                                          X509Certificate signerCert) throws Exception {
        ASN1EncodableVector certArr = new ASN1EncodableVector();
        certArr.add(new DEROctetString(signerCert.getEncoded()));
        org.ofdrw.gm.ses.v5.SES_ESPropertyInfo property = new org.ofdrw.gm.ses.v5.SES_ESPropertyInfo()
                .setType(new ASN1Integer(2))
                .setName(new DERUTF8String("OFDRW Crypto PoC 测试印章"))
                .setCertListType(org.ofdrw.gm.ses.v5.SES_ESPropertyInfo.CertListType)
                .setCertList(org.ofdrw.gm.ses.v5.SES_CertList.getInstance(
                        org.ofdrw.gm.ses.v5.SES_ESPropertyInfo.CertListType, new DERSequence(certArr)))
                .setCreateDate(new ASN1GeneralizedTime(new Date()))
                .setValidStart(new ASN1GeneralizedTime(new Date()))
                .setValidEnd(new ASN1GeneralizedTime(new Date(System.currentTimeMillis() + 1825L * 24 * 3600 * 1000)));
        org.ofdrw.gm.ses.v5.SES_SealInfo sealInfo = new org.ofdrw.gm.ses.v5.SES_SealInfo()
                .setHeader(new org.ofdrw.gm.ses.v5.SES_Header(
                        org.ofdrw.gm.ses.v5.SES_Header.V5, new DERIA5String("OFDRWPOC")))
                .setEsID(new DERIA5String(UUID.randomUUID().toString().replace("-", "")))
                .setProperty(property)
                .setPicture(new org.ofdrw.gm.ses.v5.SES_ESPictrueInfo()
                        .setType("PNG").setData(ONE_PX_PNG).setWidth(40).setHeight(40));
        byte[] sealSig = sm2Sign(sealInfo.getEncoded("DER"), sealKp.getPrivate());
        return new org.ofdrw.gm.ses.v5.SESeal()
                .seteSealInfo(sealInfo)
                .setCert(sealCert)
                .setSignatureAlgID(GMObjectIdentifiers.sm2sign_with_sm3)
                .setSignatureValue(sealSig);
    }

    private static byte[] timestampTokenSafe(byte[] signatureValue, PrivateKey tsaKey,
                                             X509Certificate tsaCert, X509Certificate rootCert) {
        try {
            return timestampToken(signatureValue, tsaKey, tsaCert, rootCert);
        } catch (Exception e) {
            throw new IllegalStateException("生成时间戳令牌失败", e);
        }
    }

    /**
     * 按 GM/T 0033-2014 7.2 生成时间戳令牌：ContentInfo(SignedData)，
     * eContent 为 TSTInfo，messageImprint 为待签章值的 SM3 摘要。
     */
    private static byte[] timestampToken(byte[] signatureValue, PrivateKey tsaKey,
                                         X509Certificate tsaCert, X509Certificate rootCert) throws Exception {
        byte[] digest = sm3(signatureValue);
        TimeStampRequestGenerator reqGen = new TimeStampRequestGenerator();
        reqGen.setCertReq(true);
        TimeStampRequest request = reqGen.generate(new ASN1ObjectIdentifier("1.2.156.10197.1.401"), digest);
        SignerInfoGenerator sigGen = new JcaSimpleSignerInfoGeneratorBuilder()
                .setProvider("BC").build("SM3withSM2", tsaKey, tsaCert);
        TimeStampTokenGenerator tokenGen = new TimeStampTokenGenerator(
                sigGen,
                new JcaDigestCalculatorProviderBuilder().setProvider("BC").build()
                        .get(new AlgorithmIdentifier(org.bouncycastle.asn1.oiw.OIWObjectIdentifiers.idSHA1)),
                new ASN1ObjectIdentifier("1.2.156.10197.1.501.1"));
        tokenGen.addCertificates(new JcaCertStore(List.of(tsaCert, rootCert)));
        TimeStampToken token = tokenGen.generate(request,
                BigInteger.valueOf(System.currentTimeMillis()), new Date());
        return token.getEncoded();
    }

    // ---------------------------------------------------------------- 算法

    static byte[] sm3(byte[] data) {
        return new SM3.Digest().digest(data);
    }

    static byte[] sm2Sign(byte[] data, PrivateKey key) throws GeneralSecurityException {
        Signature sg = Signature.getInstance("SM3WithSM2", "BC");
        sg.initSign(key);
        sg.update(data);
        return sg.sign();
    }

    static boolean sm2Verify(byte[] data, byte[] sig, PublicKey key) throws GeneralSecurityException {
        Signature sg = Signature.getInstance("SM3WithSM2", "BC");
        sg.initVerify(key);
        sg.update(data);
        return sg.verify(sig);
    }

    static byte[] sm4CbcEncrypt(byte[] plain, byte[] key, byte[] iv) throws Exception {
        PaddedBufferedBlockCipher cipher =
                new PaddedBufferedBlockCipher(new CBCBlockCipher(new SM4Engine()), new PKCS7Padding());
        cipher.init(true, new ParametersWithIV(new KeyParameter(key), iv));
        byte[] out = new byte[plain.length + cipher.getBlockSize()];
        int n = cipher.processBytes(plain, 0, plain.length, out, 0);
        n += cipher.doFinal(out, n);
        byte[] res = new byte[n];
        System.arraycopy(out, 0, res, 0, n);
        return res;
    }

    static byte[] sm4CbcDecrypt(byte[] cipherBytes, byte[] key, byte[] iv) throws Exception {
        PaddedBufferedBlockCipher cipher =
                new PaddedBufferedBlockCipher(new CBCBlockCipher(new SM4Engine()), new PKCS7Padding());
        cipher.init(false, new ParametersWithIV(new KeyParameter(key), iv));
        byte[] out = new byte[cipherBytes.length + cipher.getBlockSize()];
        int n = cipher.processBytes(cipherBytes, 0, cipherBytes.length, out, 0);
        n += cipher.doFinal(out, n);
        byte[] res = new byte[n];
        System.arraycopy(out, 0, res, 0, n);
        return res;
    }

    // ---------------------------------------------------------------- JS 互操作校验

    @SuppressWarnings("unchecked")
    private static void verifyJs(Path jsPropsPath, Path certDir) throws Exception {
        Properties props = new Properties();
        try (InputStream in = Files.newInputStream(jsPropsPath)) {
            props.load(new InputStreamReader(in, StandardCharsets.UTF_8));
        }
        Certificate signerCert = loadCert(certDir.resolve("signer-cert.pem"));
        PrivateKey signerKey = loadPrivateKey(certDir.resolve("signer-key.pem"));
        byte[] message = hexToBytes(props.getProperty("messageHex"));
        byte[] jsSig = Base64.getDecoder().decode(props.getProperty("signatureDerB64"));
        boolean sigOk = sm2Verify(message, jsSig, signerCert.getPublicKey());
        byte[] der = Base64.getDecoder().decode(props.getProperty("sm2CipherDerB64"));
        SM2Cipher cipher = SM2Cipher.getInstance(org.bouncycastle.asn1.ASN1Primitive.fromByteArray(der));
        byte[] c1c3c2 = cipher.convertC1C3C2();
        byte[] plain = decryptSm2(c1c3c2, signerKey);
        boolean cipherOk = hex(plain).equals(props.getProperty("sm2PlaintextHex"));
        byte[] raw = hexToBytes(props.getProperty("sm2CipherC1C3C2Hex"));
        if (raw.length == 112) {
            // sm-crypto 输出的 C1C3C2 不含未压缩点前缀 0x04，BC SM2Engine 需要
            byte[] withPrefix = new byte[raw.length + 1];
            withPrefix[0] = 0x04;
            System.arraycopy(raw, 0, withPrefix, 1, raw.length);
            raw = withPrefix;
        }
        byte[] plainRaw = decryptSm2(raw, signerKey);
        boolean rawOk = hex(plainRaw).equals(props.getProperty("sm2PlaintextHex"));

        Map<String, Object> result = mapOf(
                "jsSignatureVerifiedByJava", sigOk,
                "jsSm2CipherDerDecryptedByJava", cipherOk,
                "jsSm2CipherRawDecryptedByJava", rawOk,
                "jsSm2PlaintextHex", props.getProperty("sm2PlaintextHex"),
                "javaDecryptedPlaintextHex", hex(plain));
        Files.writeString(jsPropsPath.getParent().resolve("js-crosscheck-java.json"),
                toJson(result), StandardCharsets.UTF_8);
        System.out.println("JAVA_VERIFY_JS " + toJson(result));
        if (!sigOk || !cipherOk || !rawOk) {
            throw new IllegalStateException("JS 生成的签名或密文未被 Java 验证通过");
        }
    }

    private static byte[] decryptSm2(byte[] c1c3c2, PrivateKey key) throws Exception {
        SM2Engine engine = new SM2Engine(SM2Engine.Mode.C1C3C2);
        engine.init(false, ECUtil.generatePrivateKeyParameter(key));
        return engine.processBlock(c1c3c2, 0, c1c3c2.length);
    }

    static Certificate loadCert(Path pem) throws Exception {
        try (PEMParser parser = new PEMParser(new InputStreamReader(Files.newInputStream(pem), StandardCharsets.UTF_8))) {
            Object o = parser.readObject();
            if (o instanceof X509CertificateHolder) {
                return new JcaX509CertificateConverter().setProvider("BC")
                        .getCertificate((X509CertificateHolder) o);
            }
            throw new IllegalArgumentException("无法解析证书: " + pem);
        }
    }

    static PrivateKey loadPrivateKey(Path pem) throws Exception {
        try (PEMParser parser = new PEMParser(new InputStreamReader(Files.newInputStream(pem), StandardCharsets.UTF_8))) {
            Object o = parser.readObject();
            JcaPEMKeyConverter converter = new JcaPEMKeyConverter().setProvider("BC");
            if (o instanceof PEMKeyPair) {
                return converter.getPrivateKey(((PEMKeyPair) o).getPrivateKeyInfo());
            }
            if (o instanceof org.bouncycastle.asn1.pkcs.PrivateKeyInfo) {
                return converter.getPrivateKey((org.bouncycastle.asn1.pkcs.PrivateKeyInfo) o);
            }
            throw new IllegalArgumentException("无法解析私钥: " + pem);
        }
    }

    // ---------------------------------------------------------------- 工具

    static String publicKeyHex(PublicKey key) {
        ECPublicKey ec = (ECPublicKey) key;
        return "04" + padHex(ec.getW().getAffineX().toString(16), 64)
                + padHex(ec.getW().getAffineY().toString(16), 64);
    }

    static String privateKeyHex(PrivateKey key) {
        return padHex(((ECPrivateKey) key).getS().toString(16), 64);
    }

    static String padHex(String hex, int len) {
        StringBuilder sb = new StringBuilder();
        for (int i = hex.length(); i < len; i++) {
            sb.append('0');
        }
        return sb.append(hex).toString();
    }

    static String hex(byte[] data) {
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (byte b : data) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    static byte[] hexToBytes(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    static String sha256Hex(byte[] data) throws GeneralSecurityException {
        return hex(MessageDigest.getInstance("SHA-256").digest(data));
    }

    static Map<String, Object> sampleInfo(Path path) throws Exception {
        return mapOf(
                "path", path.toAbsolutePath().toString(),
                "size", Files.size(path),
                "sha256", sha256Hex(Files.readAllBytes(path)));
    }

    static Map<String, Object> mapOf(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            map.put((String) kv[i], kv[i + 1]);
        }
        return map;
    }

    /** 比较两个 OFD（zip）内每个条目的路径与内容摘要，忽略压缩元数据差异。 */
    static boolean zipContentsEqual(Path a, Path b) throws Exception {
        Map<String, String> ea = zipDigests(a);
        Map<String, String> eb = zipDigests(b);
        if (!ea.keySet().equals(eb.keySet())) {
            System.out.println("zip entry diff: " + ea.keySet() + " vs " + eb.keySet());
            return false;
        }
        for (String name : ea.keySet()) {
            if (!ea.get(name).equals(eb.get(name))) {
                System.out.println("zip content diff: " + name);
                return false;
            }
        }
        return true;
    }

    static Map<String, String> zipDigests(Path zip) throws Exception {
        Map<String, String> res = new TreeMap<>();
        try (ZipFile zf = new ZipFile(zip.toFile())) {
            for (ZipEntry entry : Collections.list(zf.entries())) {
                if (entry.isDirectory()) {
                    continue;
                }
                try (InputStream in = zf.getInputStream(entry)) {
                    res.put(entry.getName(), hex(MessageDigest.getInstance("SHA-256").digest(in.readAllBytes())));
                }
            }
        }
        return res;
    }

    static String toJson(Object obj) {
        StringBuilder sb = new StringBuilder();
        appendJson(sb, obj);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void appendJson(StringBuilder sb, Object obj) {
        if (obj == null) {
            sb.append("null");
        } else if (obj instanceof String) {
            sb.append('"').append(escape((String) obj)).append('"');
        } else if (obj instanceof Number || obj instanceof Boolean) {
            sb.append(obj);
        } else if (obj instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) obj).entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                sb.append('"').append(escape(e.getKey())).append("\":");
                appendJson(sb, e.getValue());
            }
            sb.append('}');
        } else if (obj instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object item : (Iterable<Object>) obj) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                appendJson(sb, item);
            }
            sb.append(']');
        } else {
            sb.append('"').append(escape(String.valueOf(obj))).append('"');
        }
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}