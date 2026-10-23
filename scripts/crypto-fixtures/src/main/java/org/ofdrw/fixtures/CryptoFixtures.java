package org.ofdrw.fixtures;

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
import org.bouncycastle.asn1.oiw.OIWObjectIdentifiers;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.ExtendedKeyUsage;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyPurposeId;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.X509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.JcaCertStore;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509ExtensionUtils;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.cms.SignerInfoGenerator;
import org.bouncycastle.cms.jcajce.JcaSimpleSignerInfoGeneratorBuilder;
import org.bouncycastle.jcajce.provider.asymmetric.util.ECUtil;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.openssl.PEMKeyPair;
import org.bouncycastle.openssl.PEMParser;
import org.bouncycastle.openssl.jcajce.JcaPEMKeyConverter;
import org.bouncycastle.openssl.jcajce.JcaPEMWriter;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.bouncycastle.operator.jcajce.JcaDigestCalculatorProviderBuilder;
import org.bouncycastle.tsp.TimeStampRequest;
import org.bouncycastle.tsp.TimeStampRequestGenerator;
import org.bouncycastle.tsp.TimeStampToken;
import org.bouncycastle.tsp.TimeStampTokenGenerator;
import org.bouncycastle.util.io.pem.PemObject;
import org.bouncycastle.util.io.pem.PemWriter;
import org.ofdrw.crypto.OFDDecryptor;
import org.ofdrw.crypto.OFDEncryptor;
import org.ofdrw.crypto.decryptor.UserCertDecryptor;
import org.ofdrw.crypto.decryptor.UserPasswordDecryptor;
import org.ofdrw.crypto.enryptor.UserCertEncryptor;
import org.ofdrw.crypto.enryptor.UserPasswordEncryptor;
import org.ofdrw.crypto.integrity.GMProtectSigner;
import org.ofdrw.crypto.integrity.GMProtectVerifier;
import org.ofdrw.crypto.integrity.OFDIntegrity;
import org.ofdrw.crypto.integrity.OFDIntegrityVerifier;
import org.ofdrw.gm.ses.v1.SES_ESPictrueInfo;
import org.ofdrw.gm.ses.v4.SES_CertList;
import org.ofdrw.gm.ses.v4.SES_ESPropertyInfo;
import org.ofdrw.gm.ses.v4.SES_SealInfo;
import org.ofdrw.gm.ses.v1.SES_Header;
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
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Security;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * 受保护 OFD 夹具生成器与校验器。
 *
 * <p>用法：
 * <pre>
 *   generate-certs &lt;fixtureDir&gt;
 *   generate       &lt;fixtureDir&gt; &lt;baseOfd&gt;
 *   verify         &lt;fixtureDir&gt;
 * </pre>
 *
 * <p>生成器只使用 ofdrw 2.4.0 的公开 API；证书、私钥仅用于测试，禁止用于生产。
 */
public final class CryptoFixtures {

    static {
        Security.addProvider(new BouncyCastleProvider());
    }

    private static final String PASSWORD_USER = "fixture-password-user";
    private static final String PASSWORD = "FixturePass123";
    private static final String CERT_USER = "fixture-cert-user";
    private static final String SIGNER_DN = "CN=OFDRW Viewer Crypto Fixtures Signer,O=ofdrw-viewer test,C=CN";
    private static final String ENCRYPT_DN = "CN=OFDRW Viewer Crypto Fixtures Encrypt,O=ofdrw-viewer test,C=CN";
    private static final String SEAL_DN = "CN=OFDRW Viewer Crypto Fixtures Seal Maker,O=ofdrw-viewer test,C=CN";
    private static final String TSA_DN = "CN=OFDRW Viewer Crypto Fixtures TSA,O=ofdrw-viewer test,C=CN";
    private static final String ROOT_DN = "CN=OFDRW Viewer Crypto Fixtures Root CA,O=ofdrw-viewer test,C=CN";

    private static final Date ROOT_FROM = Date.from(Instant.parse("2020-01-01T00:00:00Z"));
    private static final Date ROOT_TO = Date.from(Instant.parse("2045-01-01T00:00:00Z"));
    private static final Date LEAF_FROM = Date.from(Instant.parse("2025-01-01T00:00:00Z"));
    private static final Date LEAF_TO = Date.from(Instant.parse("2040-01-01T00:00:00Z"));
    private static final Date SEAL_CREATE = Date.from(Instant.parse("2025-01-01T00:00:00Z"));
    private static final Date SEAL_VALID_TO = Date.from(Instant.parse("2040-01-01T00:00:00Z"));

    private static final byte[] ONE_PX_PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    private CryptoFixtures() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("用法: generate-certs <fixtureDir> | generate <fixtureDir> <baseOfd> | verify <fixtureDir>");
            System.exit(2);
        }
        Path fixtureDir = Paths.get(args[1]).toAbsolutePath().normalize();
        switch (args[0]) {
            case "generate-certs" -> generateCerts(fixtureDir.resolve("certs"));
            case "generate" -> {
                if (args.length < 3) {
                    throw new IllegalArgumentException("generate 需要 baseOfd 参数");
                }
                generateFixtures(fixtureDir, Paths.get(args[2]));
            }
            case "verify" -> verifyFixtures(fixtureDir);
            default -> throw new IllegalArgumentException("未知模式: " + args[0]);
        }
    }

    // ---------------------------------------------------------------- 证书生成

    private static void generateCerts(Path certDir) throws Exception {
        Files.createDirectories(certDir);
        KeyPair rootKp = keyPair();
        X509Certificate root = selfSignedRoot(rootKp);

        KeyPair signerKp = keyPair();
        X509Certificate signer = issueCert(signerKp, SIGNER_DN, root, rootKp.getPrivate(),
                new KeyUsage(KeyUsage.digitalSignature | KeyUsage.nonRepudiation),
                KeyPurposeId.id_kp_clientAuth, false, BigInteger.valueOf(1001));

        KeyPair encryptKp = keyPair();
        X509Certificate encrypt = issueCert(encryptKp, ENCRYPT_DN, root, rootKp.getPrivate(),
                new KeyUsage(KeyUsage.keyEncipherment | KeyUsage.dataEncipherment),
                KeyPurposeId.id_kp_emailProtection, false, BigInteger.valueOf(1002));

        KeyPair sealKp = keyPair();
        X509Certificate seal = issueCert(sealKp, SEAL_DN, root, rootKp.getPrivate(),
                new KeyUsage(KeyUsage.digitalSignature | KeyUsage.nonRepudiation),
                KeyPurposeId.id_kp_clientAuth, false, BigInteger.valueOf(1003));

        KeyPair tsaKp = keyPair();
        X509Certificate tsa = issueCert(tsaKp, TSA_DN, root, rootKp.getPrivate(),
                new KeyUsage(KeyUsage.digitalSignature | KeyUsage.nonRepudiation),
                KeyPurposeId.id_kp_timeStamping, true, BigInteger.valueOf(1004));

        writeCertPair(certDir, "root-ca", root);
        writeCertPair(certDir, "signer", signer);
        writeCertPair(certDir, "encrypt", encrypt);
        writeCertPair(certDir, "seal", seal);
        writeCertPair(certDir, "tsa", tsa);

        writeKeyPair(certDir, "root-ca", rootKp.getPrivate());
        writeKeyPair(certDir, "signer", signerKp.getPrivate());
        writeKeyPair(certDir, "encrypt", encryptKp.getPrivate());
        writeKeyPair(certDir, "seal", sealKp.getPrivate());
        writeKeyPair(certDir, "tsa", tsaKp.getPrivate());

        System.out.println("FIXTURE_CERTS_OK " + certDir);
        System.out.println("root=" + root.getSubjectX500Principal().getName()
                + " signer=" + signer.getSubjectX500Principal().getName()
                + " encrypt=" + encrypt.getSubjectX500Principal().getName()
                + " seal=" + seal.getSubjectX500Principal().getName()
                + " tsa=" + tsa.getSubjectX500Principal().getName());
    }

    private static KeyPair keyPair() throws GeneralSecurityException {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC", "BC");
        kpg.initialize(new ECGenParameterSpec("sm2p256v1"));
        return kpg.generateKeyPair();
    }

    private static X509Certificate selfSignedRoot(KeyPair kp) throws Exception {
        X500Name name = new X500Name(ROOT_DN);
        JcaX509ExtensionUtils ext = new JcaX509ExtensionUtils();
        X509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                name, BigInteger.valueOf(1000), ROOT_FROM, ROOT_TO, name, kp.getPublic());
        builder.addExtension(Extension.basicConstraints, true, new BasicConstraints(true));
        builder.addExtension(Extension.keyUsage, true,
                new KeyUsage(KeyUsage.keyCertSign | KeyUsage.cRLSign | KeyUsage.digitalSignature));
        builder.addExtension(Extension.subjectKeyIdentifier, false, ext.createSubjectKeyIdentifier(kp.getPublic()));
        ContentSigner signer = new JcaContentSignerBuilder("SM3withSM2").setProvider("BC").build(kp.getPrivate());
        return new JcaX509CertificateConverter().setProvider("BC").getCertificate(builder.build(signer));
    }

    private static X509Certificate issueCert(KeyPair subjectKp, String dn,
                                             X509Certificate caCert, PrivateKey caKey,
                                             KeyUsage usage, KeyPurposeId eku, boolean ekuCritical,
                                             BigInteger serial) throws Exception {
        X500Name issuer = X500Name.getInstance(caCert.getSubjectX500Principal().getEncoded());
        X500Name subject = new X500Name(dn);
        JcaX509ExtensionUtils ext = new JcaX509ExtensionUtils();
        X509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                issuer, serial, LEAF_FROM, LEAF_TO, subject, subjectKp.getPublic());
        builder.addExtension(Extension.basicConstraints, true, new BasicConstraints(false));
        builder.addExtension(Extension.keyUsage, true, usage);
        builder.addExtension(Extension.extendedKeyUsage, ekuCritical, new ExtendedKeyUsage(eku));
        builder.addExtension(Extension.subjectKeyIdentifier, false, ext.createSubjectKeyIdentifier(subjectKp.getPublic()));
        builder.addExtension(Extension.authorityKeyIdentifier, false, ext.createAuthorityKeyIdentifier(caCert));
        ContentSigner signer = new JcaContentSignerBuilder("SM3withSM2").setProvider("BC").build(caKey);
        return new JcaX509CertificateConverter().setProvider("BC").getCertificate(builder.build(signer));
    }

    private static void writeCertPair(Path dir, String base, X509Certificate cert) throws Exception {
        try (OutputStream out = Files.newOutputStream(dir.resolve(base + ".crt.pem"));
             JcaPEMWriter writer = new JcaPEMWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8))) {
            writer.writeObject(cert);
        }
        Files.write(dir.resolve(base + ".crt.der"), cert.getEncoded());
    }

    private static void writeKeyPair(Path dir, String base, PrivateKey key) throws IOException {
        try (OutputStream out = Files.newOutputStream(dir.resolve(base + ".key.pem"));
             PemWriter writer = new PemWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8))) {
            writer.writeObject(new PemObject("PRIVATE KEY", key.getEncoded()));
        }
        Files.write(dir.resolve(base + ".key.der"), key.getEncoded());
    }

    // ---------------------------------------------------------------- 样例生成

    private static void generateFixtures(Path fixtureDir, Path baseOfd) throws Exception {
        Files.createDirectories(fixtureDir);
        Path certDir = fixtureDir.resolve("certs");
        require(certDir.resolve("root-ca.crt.pem"), "测试证书不存在，请先运行 generate-certs");
        require(certDir.resolve("signer.crt.pem"), "签名证书不存在");
        require(certDir.resolve("signer.key.pem"), "签名私钥不存在");
        require(certDir.resolve("encrypt.crt.pem"), "加密证书不存在");
        require(certDir.resolve("encrypt.key.pem"), "加密私钥不存在");
        require(certDir.resolve("seal.crt.pem"), "制章证书不存在");
        require(certDir.resolve("seal.key.pem"), "制章私钥不存在");
        require(certDir.resolve("tsa.crt.pem"), "TSA 证书不存在");
        require(certDir.resolve("tsa.key.pem"), "TSA 私钥不存在");
        require(baseOfd, "基准 OFD 不存在");

        X509Certificate rootCert = readCert(certDir.resolve("root-ca.crt.pem"));
        X509Certificate signerCert = readCert(certDir.resolve("signer.crt.pem"));
        X509Certificate encryptCert = readCert(certDir.resolve("encrypt.crt.pem"));
        X509Certificate sealCert = readCert(certDir.resolve("seal.crt.pem"));
        X509Certificate tsaCert = readCert(certDir.resolve("tsa.crt.pem"));
        PrivateKey signerKey = readKey(certDir.resolve("signer.key.pem"));
        PrivateKey encryptKey = readKey(certDir.resolve("encrypt.key.pem"));
        PrivateKey sealKey = readKey(certDir.resolve("seal.key.pem"));
        PrivateKey tsaKey = readKey(certDir.resolve("tsa.key.pem"));

        Path plain = fixtureDir.resolve("plain.ofd");
        Files.copy(baseOfd, plain, StandardCopyOption.REPLACE_EXISTING);

        // 口令加密
        Path passwordEncrypted = fixtureDir.resolve("password-encrypted.ofd");
        try (OFDEncryptor enc = new OFDEncryptor(plain, passwordEncrypted)) {
            enc.addUser(new UserPasswordEncryptor(PASSWORD_USER, PASSWORD));
            enc.encrypt();
        }

        // SM2 证书加密
        Path certEncrypted = fixtureDir.resolve("cert-encrypted.ofd");
        try (OFDEncryptor enc = new OFDEncryptor(plain, certEncrypted)) {
            enc.addUser(new UserCertEncryptor(CERT_USER, encryptCert));
            enc.encrypt();
        }

        // SESv4 / SESv5 签章（带 GM/T 0033 时间戳）
        org.ofdrw.gm.ses.v4.SESeal sealV4 = buildSealV4(sealKey, sealCert, signerCert);
        Path signedV4 = fixtureDir.resolve("signed-sesv4.ofd");
        try (OFDReader reader = new OFDReader(plain);
             OFDSigner signer = new OFDSigner(reader, signedV4)) {
            SESV4Container container = new SESV4Container(
                    signerKey, sealV4, signerCert,
                    value -> timestampToken(value, tsaKey, tsaCert, rootCert));
            signer.setSignMode(SignMode.ContinueSign);
            signer.setSignContainer(container);
            signer.addApPos(new NormalStampPos(1, 50, 50, 40, 40));
            signer.exeSign();
        }

        org.ofdrw.gm.ses.v5.SESeal sealV5 = buildSealV5(sealKey, sealCert, signerCert);
        Path signedV5 = fixtureDir.resolve("signed-sesv5.ofd");
        try (OFDReader reader = new OFDReader(plain);
             OFDSigner signer = new OFDSigner(reader, signedV5)) {
            SESV5Container container = new SESV5Container(
                    signerKey, sealV5, signerCert,
                    value -> timestampToken(value, tsaKey, tsaCert, rootCert));
            signer.setSignMode(SignMode.ContinueSign);
            signer.setSignContainer(container);
            signer.addApPos(new NormalStampPos(1, 50, 50, 40, 40));
            signer.exeSign();
        }

        // 防夹带完整性保护
        Path integrity = fixtureDir.resolve("integrity.ofd");
        try (OFDIntegrity protector = new OFDIntegrity(plain, integrity)) {
            protector.protect(new GMProtectSigner(signerKey, signerCert));
        }

        // 组合：签名 + 完整性 + 口令加密。
        // 顺序必须是先签名、再完整性保护（FileList 覆盖签名文件）、最后加密。
        Path combinedSignedIntegrity = fixtureDir.resolve("combined-signed-integrity.ofd");
        try (OFDIntegrity protector = new OFDIntegrity(signedV4, combinedSignedIntegrity)) {
            protector.protect(new GMProtectSigner(signerKey, signerCert));
        }
        Path combinedEncrypted = fixtureDir.resolve("combined-password-encrypted.ofd");
        try (OFDEncryptor enc = new OFDEncryptor(combinedSignedIntegrity, combinedEncrypted)) {
            enc.addUser(new UserPasswordEncryptor(PASSWORD_USER, PASSWORD));
            enc.encrypt();
        }

        // 负例 1：引用文件内容被篡改
        Map<String, byte[]> signedZip = readZip(signedV4);
        Map<String, byte[]> tamperedContent = new TreeMap<>(signedZip);
        tamperedContent.put("Doc_0/Pages/Page_0/Content.xml",
                appendByte(tamperedContent.get("Doc_0/Pages/Page_0/Content.xml"), (byte) ' '));
        Path negativeContent = fixtureDir.resolve("negative-tampered-content.ofd");
        writeZip(negativeContent, tamperedContent);

        // 负例 2：SignedValue.dat 被篡改
        Map<String, byte[]> tamperedSignedValue = new TreeMap<>(signedZip);
        byte[] signedValue = tamperedSignedValue.get("Doc_0/Signs/Sign_0/SignedValue.dat");
        byte[] changedSignedValue = signedValue.clone();
        // 修改 DER 中部（TBS_Sign 内）的字节，确保签名/印章校验必然失效
        changedSignedValue[Math.min(64, changedSignedValue.length - 1)] ^= 0x01;
        tamperedSignedValue.put("Doc_0/Signs/Sign_0/SignedValue.dat", changedSignedValue);
        Path negativeSignedValue = fixtureDir.resolve("negative-tampered-signedvalue.ofd");
        writeZip(negativeSignedValue, tamperedSignedValue);

        // 负例 3：Signature.xml 被篡改（dataHash 不再匹配）
        Map<String, byte[]> tamperedSignature = new TreeMap<>(signedZip);
        tamperedSignature.put("Doc_0/Signs/Sign_0/Signature.xml",
                appendByte(tamperedSignature.get("Doc_0/Signs/Sign_0/Signature.xml"), (byte) ' '));
        Path negativeSignature = fixtureDir.resolve("negative-tampered-signature.ofd");
        writeZip(negativeSignature, tamperedSignature);

        // 负例 4：完整性包内新增未登记文件（夹带）
        Map<String, byte[]> integrityZip = readZip(integrity);
        Map<String, byte[]> smuggled = new TreeMap<>(integrityZip);
        smuggled.put("evil.txt", "unregistered file".getBytes(StandardCharsets.UTF_8));
        Path negativeExtra = fixtureDir.resolve("negative-extra-file.ofd");
        writeZip(negativeExtra, smuggled);

        writeManifest(fixtureDir, List.of(
                caseInfo(fixtureDir, "plain", "plain.ofd", "plain", "明文基准", null, expected("valid", true)),
                caseInfo(fixtureDir, "password-encrypted", "password-encrypted.ofd", "encrypted", "口令加密",
                        mapOf("kind", "password", "userName", PASSWORD_USER, "password", PASSWORD),
                        expected("decrypt", "ok")),
                caseInfo(fixtureDir, "cert-encrypted", "cert-encrypted.ofd", "encrypted", "SM2 证书加密",
                        mapOf("kind", "certificate", "userName", CERT_USER,
                                "privateKey", "certs/encrypt.key.pem"),
                        expected("decrypt", "ok")),
                caseInfo(fixtureDir, "signed-sesv4", "signed-sesv4.ofd", "signed", "SESv4 签章（含时间戳）",
                        null, signedExpected()),
                caseInfo(fixtureDir, "signed-sesv5", "signed-sesv5.ofd", "signed", "SESv5 签章（含时间戳）",
                        null, signedExpected()),
                caseInfo(fixtureDir, "integrity", "integrity.ofd", "integrity", "GB/T 35275 防夹带完整性",
                        null, mapOf("integrity", "valid", "antiSmuggling", "valid")),
                caseInfo(fixtureDir, "combined-signed-integrity", "combined-signed-integrity.ofd", "combined",
                        "签名 + 完整性", null,
                        mapOf("signature", "valid", "integrity", "valid")),
                caseInfo(fixtureDir, "combined-password-encrypted", "combined-password-encrypted.ofd", "combined",
                        "签名 + 完整性 + 口令加密",
                        mapOf("kind", "password", "userName", PASSWORD_USER, "password", PASSWORD),
                        mapOf("decrypt", "ok", "signature", "valid", "integrity", "valid")),
                caseInfo(fixtureDir, "negative-tampered-content", "negative-tampered-content.ofd", "negative",
                        "引用文件内容被篡改", null, mapOf("signature", "invalid")),
                caseInfo(fixtureDir, "negative-tampered-signedvalue", "negative-tampered-signedvalue.ofd", "negative",
                        "SignedValue.dat 被篡改", null, mapOf("signature", "invalid")),
                caseInfo(fixtureDir, "negative-tampered-signature", "negative-tampered-signature.ofd", "negative",
                        "Signature.xml 被篡改", null, mapOf("signature", "invalid")),
                caseInfo(fixtureDir, "negative-extra-file", "negative-extra-file.ofd", "negative",
                        "包内新增未登记文件（夹带）", null, mapOf("integrity", "invalid"))));

        verifyFixtures(fixtureDir);
        System.out.println("FIXTURES_GENERATE_OK " + fixtureDir);
        System.out.println("passwordUser=" + PASSWORD_USER + " password=" + PASSWORD
                + " certUser=" + CERT_USER);
    }

    private static Map<String, Object> expected(String key, Object value) {
        return mapOf(key, value);
    }

    private static Map<String, Object> signedExpected() {
        Map<String, Object> m = mapOf("signature", "valid", "timestamp", "parsed-only");
        m.put("trustRootConfigured", "valid");
        m.put("trustRootMissing", "unknown");
        return m;
    }

    private static Map<String, Object> caseInfo(Path fixtureDir, String id, String path, String type,
                                                String description, Map<String, Object> credentials,
                                                Map<String, Object> expected) throws Exception {
        Path file = fixtureDir.resolve(path);
        return mapOf(
                "id", id,
                "path", path,
                "type", type,
                "description", description,
                "size", Files.size(file),
                "sha256", sha256Hex(Files.readAllBytes(file)),
                "credentials", credentials,
                "expected", expected);
    }

    // ---------------------------------------------------------------- 印章与时间戳

    private static org.ofdrw.gm.ses.v4.SESeal buildSealV4(PrivateKey sealKey, X509Certificate sealCert,
                                                          X509Certificate signerCert) throws Exception {
        ASN1EncodableVector certArr = new ASN1EncodableVector();
        certArr.add(new DEROctetString(signerCert.getEncoded()));
        SES_ESPropertyInfo property = new SES_ESPropertyInfo()
                .setType(new ASN1Integer(2))
                .setName(new DERUTF8String("OFDRW Viewer 测试印章 v4"))
                .setCertListType(SES_ESPropertyInfo.CertListType)
                .setCertList(SES_CertList.getInstance(
                        SES_ESPropertyInfo.CertListType, new DERSequence(certArr)))
                .setCreateDate(new ASN1GeneralizedTime(SEAL_CREATE))
                .setValidStart(new ASN1GeneralizedTime(SEAL_CREATE))
                .setValidEnd(new ASN1GeneralizedTime(SEAL_VALID_TO));
        SES_SealInfo sealInfo = new SES_SealInfo()
                .setHeader(new SES_Header(SES_Header.V4, new DERIA5String("OFDRWFIXTURE")))
                .setEsID(new DERIA5String("OFDRWFIXTURESEALV4"))
                .setProperty(property)
                .setPicture(new SES_ESPictrueInfo().setType("PNG").setData(ONE_PX_PNG).setWidth(40).setHeight(40));
        byte[] sealSig = sm2Sign(sealInfo.getEncoded("DER"), sealKey);
        return new org.ofdrw.gm.ses.v4.SESeal()
                .seteSealInfo(sealInfo)
                .setCert(sealCert)
                .setSignAlgID(GMObjectIdentifiers.sm2sign_with_sm3)
                .setSignedValue(sealSig);
    }

    private static org.ofdrw.gm.ses.v5.SESeal buildSealV5(PrivateKey sealKey, X509Certificate sealCert,
                                                          X509Certificate signerCert) throws Exception {
        ASN1EncodableVector certArr = new ASN1EncodableVector();
        certArr.add(new DEROctetString(signerCert.getEncoded()));
        org.ofdrw.gm.ses.v5.SES_ESPropertyInfo property = new org.ofdrw.gm.ses.v5.SES_ESPropertyInfo()
                .setType(new ASN1Integer(2))
                .setName(new DERUTF8String("OFDRW Viewer 测试印章 v5"))
                .setCertListType(org.ofdrw.gm.ses.v5.SES_ESPropertyInfo.CertListType)
                .setCertList(org.ofdrw.gm.ses.v5.SES_CertList.getInstance(
                        org.ofdrw.gm.ses.v5.SES_ESPropertyInfo.CertListType, new DERSequence(certArr)))
                .setCreateDate(new ASN1GeneralizedTime(SEAL_CREATE))
                .setValidStart(new ASN1GeneralizedTime(SEAL_CREATE))
                .setValidEnd(new ASN1GeneralizedTime(SEAL_VALID_TO));
        org.ofdrw.gm.ses.v5.SES_SealInfo sealInfo = new org.ofdrw.gm.ses.v5.SES_SealInfo()
                .setHeader(new org.ofdrw.gm.ses.v5.SES_Header(
                        org.ofdrw.gm.ses.v5.SES_Header.V5, new DERIA5String("OFDRWFIXTURE")))
                .setEsID(new DERIA5String("OFDRWFIXTURESEALV5"))
                .setProperty(property)
                .setPicture(new org.ofdrw.gm.ses.v5.SES_ESPictrueInfo()
                        .setType("PNG").setData(ONE_PX_PNG).setWidth(40).setHeight(40));
        byte[] sealSig = sm2Sign(sealInfo.getEncoded("DER"), sealKey);
        return new org.ofdrw.gm.ses.v5.SESeal()
                .seteSealInfo(sealInfo)
                .setCert(sealCert)
                .setSignatureAlgID(GMObjectIdentifiers.sm2sign_with_sm3)
                .setSignatureValue(sealSig);
    }

    private static byte[] timestampToken(byte[] signatureValue, PrivateKey tsaKey,
                                         X509Certificate tsaCert, X509Certificate rootCert) {
        try {
            byte[] digest = sm3(signatureValue);
            TimeStampRequestGenerator reqGen = new TimeStampRequestGenerator();
            reqGen.setCertReq(true);
            TimeStampRequest request = reqGen.generate(
                    new ASN1ObjectIdentifier("1.2.156.10197.1.401"), digest);
            SignerInfoGenerator sigGen = new JcaSimpleSignerInfoGeneratorBuilder()
                    .setProvider("BC").build("SM3withSM2", tsaKey, tsaCert);
            TimeStampTokenGenerator tokenGen = new TimeStampTokenGenerator(
                    sigGen,
                    new JcaDigestCalculatorProviderBuilder().setProvider("BC").build()
                            .get(new AlgorithmIdentifier(OIWObjectIdentifiers.idSHA1)),
                    new ASN1ObjectIdentifier("1.2.156.10197.1.501.1"));
            tokenGen.addCertificates(new JcaCertStore(List.of(tsaCert, rootCert)));
            TimeStampToken token = tokenGen.generate(request,
                    BigInteger.valueOf(System.currentTimeMillis()), new Date());
            return token.getEncoded();
        } catch (Exception e) {
            throw new IllegalStateException("生成时间戳令牌失败", e);
        }
    }

    // ---------------------------------------------------------------- 校验

    private static void verifyFixtures(Path fixtureDir) throws Exception {
        Path certDir = fixtureDir.resolve("certs");
        X509Certificate rootCert = readCert(certDir.resolve("root-ca.crt.pem"));
        X509Certificate signerCert = readCert(certDir.resolve("signer.crt.pem"));
        X509Certificate encryptCert = readCert(certDir.resolve("encrypt.crt.pem"));
        PrivateKey encryptKey = readKey(certDir.resolve("encrypt.key.pem"));
        check(readCert(certDir.resolve("root-ca.crt.der")).equals(rootCert), "DER 根证书与 PEM 不一致");
        check(Arrays.equals(readKey(certDir.resolve("encrypt.key.der")).getEncoded(),
                encryptKey.getEncoded()), "DER 加密私钥与 PEM 不一致");

        // 证书链：根 -> 签名者、根 -> 加密者，配置根证书时可判定有效
        rootCert.verify(rootCert.getPublicKey());
        signerCert.verify(rootCert.getPublicKey());
        encryptCert.verify(rootCert.getPublicKey());
        check(signerCert.getIssuerX500Principal().equals(rootCert.getSubjectX500Principal()),
                "签名者证书 issuer 与根证书 subject 不一致");
        check(encryptCert.getIssuerX500Principal().equals(rootCert.getSubjectX500Principal()),
                "加密证书 issuer 与根证书 subject 不一致");
        signerCert.checkValidity();
        encryptCert.checkValidity();
        check(signerCert.getKeyUsage()[0], "签名者证书缺少 digitalSignature");
        check(encryptCert.getKeyUsage()[2], "加密证书缺少 keyEncipherment");

        Path plain = fixtureDir.resolve("plain.ofd");
        Path passwordEncrypted = fixtureDir.resolve("password-encrypted.ofd");
        Path certEncrypted = fixtureDir.resolve("cert-encrypted.ofd");
        Path signedV4 = fixtureDir.resolve("signed-sesv4.ofd");
        Path signedV5 = fixtureDir.resolve("signed-sesv5.ofd");
        Path integrity = fixtureDir.resolve("integrity.ofd");
        Path combinedSignedIntegrity = fixtureDir.resolve("combined-signed-integrity.ofd");
        Path combinedEncrypted = fixtureDir.resolve("combined-password-encrypted.ofd");

        try (OFDReader ignored = new OFDReader(plain)) {
            // 明文基准可被 ofdrw 打开
        }

        Path pwdDecrypted = Files.createTempFile("fixture-pwd-", ".ofd");
        try {
            try (OFDDecryptor dec = new OFDDecryptor(passwordEncrypted, pwdDecrypted)) {
                dec.addUser(new UserPasswordDecryptor(PASSWORD_USER, PASSWORD));
                dec.decrypt();
            }
            check(zipContentsEqual(plain, pwdDecrypted), "口令解密内容与明文基准不一致");
        } finally {
            Files.deleteIfExists(pwdDecrypted);
        }

        Path certDecrypted = Files.createTempFile("fixture-cert-", ".ofd");
        try {
            try (OFDDecryptor dec = new OFDDecryptor(certEncrypted, certDecrypted)) {
                dec.addUser(new UserCertDecryptor(CERT_USER,
                        (org.bouncycastle.crypto.params.ECPrivateKeyParameters)
                                ECUtil.generatePrivateKeyParameter(encryptKey)));
                dec.decrypt();
            }
            check(zipContentsEqual(plain, certDecrypted), "证书解密内容与明文基准不一致");
        } finally {
            Files.deleteIfExists(certDecrypted);
        }

        verifySignature(signedV4, 4);
        verifySignature(signedV5, 5);
        check(new OFDIntegrityVerifier().integrity(integrity, new GMProtectVerifier()),
                "完整性样例校验失败");
        verifySignature(combinedSignedIntegrity, 4);
        check(new OFDIntegrityVerifier().integrity(combinedSignedIntegrity, new GMProtectVerifier()),
                "组合（签名+完整性）样例完整性校验失败");

        Path combinedDecrypted = Files.createTempFile("fixture-combined-", ".ofd");
        try {
            try (OFDDecryptor dec = new OFDDecryptor(combinedEncrypted, combinedDecrypted)) {
                dec.addUser(new UserPasswordDecryptor(PASSWORD_USER, PASSWORD));
                dec.decrypt();
            }
            check(zipContentsEqual(combinedSignedIntegrity, combinedDecrypted),
                    "组合样例解密内容与签名+完整性中间态不一致");
            verifySignature(combinedDecrypted, 4);
            check(new OFDIntegrityVerifier().integrity(combinedDecrypted, new GMProtectVerifier()),
                    "组合（签名+完整性+加密）解密后完整性校验失败");
        } finally {
            Files.deleteIfExists(combinedDecrypted);
        }

        // 负例必须失败
        expectSignatureFailure(fixtureDir.resolve("negative-tampered-content.ofd"), "篡改引用文件未被发现");
        expectSignatureFailure(fixtureDir.resolve("negative-tampered-signedvalue.ofd"), "篡改 SignedValue 未被发现");
        expectSignatureFailure(fixtureDir.resolve("negative-tampered-signature.ofd"), "篡改 Signature.xml 未被发现");
        expectIntegrityFailure(fixtureDir.resolve("negative-extra-file.ofd"), "夹带文件未被发现");

        // 体积约束
        long total = 0;
        for (String name : List.of("plain.ofd", "password-encrypted.ofd", "cert-encrypted.ofd",
                "signed-sesv4.ofd", "signed-sesv5.ofd", "integrity.ofd",
                "combined-signed-integrity.ofd", "combined-password-encrypted.ofd",
                "negative-tampered-content.ofd", "negative-tampered-signedvalue.ofd",
                "negative-tampered-signature.ofd", "negative-extra-file.ofd")) {
            long size = Files.size(fixtureDir.resolve(name));
            check(size < 5L * 1024 * 1024, name + " 超过 5MB: " + size);
            total += size;
        }
        check(total < 20L * 1024 * 1024, "样例总计超过 20MB: " + total);

        System.out.println("FIXTURES_VERIFY_OK " + fixtureDir);
        System.out.println("cases=12 totalBytes=" + total
                + " trustedRoot=valid trustRootMissing=unknown");
    }

    private static void verifySignature(Path file, int version) throws Exception {
        try (OFDReader reader = new OFDReader(file);
             OFDValidator validator = new OFDValidator(reader)) {
            validator.setValidator(version == 4 ? new SESV4ValidateContainer() : new SESV5ValidateContainer());
            validator.exeValidate();
        }
    }

    private static void expectSignatureFailure(Path file, String message) throws Exception {
        boolean failed;
        try {
            verifySignature(file, 4);
            failed = false;
        } catch (Exception e) {
            failed = true;
        }
        check(failed, message);
    }

    private static void expectIntegrityFailure(Path file, String message) throws Exception {
        boolean valid;
        try {
            valid = new OFDIntegrityVerifier().integrity(file, new GMProtectVerifier());
        } catch (Exception e) {
            valid = false;
        }
        check(!valid, message);
    }

    // ---------------------------------------------------------------- manifest

    private static void writeManifest(Path fixtureDir, List<Map<String, Object>> cases) throws Exception {
        List<Map<String, Object>> certs = new ArrayList<>();
        for (String name : List.of("root-ca", "signer", "encrypt", "seal", "tsa")) {
            certs.add(certInfo(fixtureDir, name, "crt", "pem", "certificate"));
            certs.add(certInfo(fixtureDir, name, "crt", "der", "certificate"));
            certs.add(certInfo(fixtureDir, name, "key", "pem", "private-key"));
            certs.add(certInfo(fixtureDir, name, "key", "der", "private-key"));
        }
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("schemaVersion", 1);
        manifest.put("generatedAt", Instant.now().toString());
        manifest.put("ofdrwVersion", "2.4.0");
        manifest.put("description", "ofdrw-viewer 密码能力共用回归夹具；所有证书/私钥仅测试用");
        manifest.put("testOnly", true);
        manifest.put("password", mapOf("userName", PASSWORD_USER, "password", PASSWORD));
        manifest.put("certificateUser", mapOf("userName", CERT_USER, "privateKey", "certs/encrypt.key.pem"));
        manifest.put("trust", mapOf(
                "root", "certs/root-ca.crt.pem",
                "signer", "certs/signer.crt.pem",
                "configured", "valid",
                "notConfigured", "unknown"));
        manifest.put("cases", cases);
        manifest.put("certs", certs);
        String json = toJson(manifest);
        Files.writeString(fixtureDir.resolve("manifest.json"), json, StandardCharsets.UTF_8);

        List<String> lines = new ArrayList<>();
        for (Map<String, Object> c : cases) {
            lines.add(c.get("sha256") + "  " + c.get("path"));
        }
        for (Map<String, Object> c : certs) {
            lines.add(c.get("sha256") + "  " + c.get("path"));
        }
        Collections.sort(lines);
        Files.writeString(fixtureDir.resolve("manifest.sha256"), String.join("\n", lines) + "\n",
                StandardCharsets.UTF_8);
    }

    private static Map<String, Object> certInfo(Path fixtureDir, String base, String kind,
                                                String format, String type) throws Exception {
        String path = "certs/" + base + "." + kind + "." + format;
        Path file = fixtureDir.resolve(path);
        Map<String, Object> info = mapOf(
                "path", path,
                "kind", kind,
                "format", format,
                "type", type,
                "size", Files.size(file),
                "sha256", sha256Hex(Files.readAllBytes(file)),
                "testOnly", true);
        if ("crt".equals(kind)) {
            info.put("subject", readCert(file).getSubjectX500Principal().getName());
        }
        return info;
    }

    // ---------------------------------------------------------------- IO 与工具

    private static X509Certificate readCert(Path file) throws Exception {
        byte[] raw = Files.readAllBytes(file);
        if (raw.length > 0 && raw[0] == 0x30) {
            return (X509Certificate) java.security.cert.CertificateFactory.getInstance("X.509", "BC")
                    .generateCertificate(new ByteArrayInputStream(raw));
        }
        try (PEMParser parser = new PEMParser(new java.io.InputStreamReader(
                new ByteArrayInputStream(raw), StandardCharsets.UTF_8))) {
            Object obj = parser.readObject();
            if (obj instanceof X509CertificateHolder holder) {
                return new JcaX509CertificateConverter().setProvider("BC").getCertificate(holder);
            }
        }
        throw new IllegalArgumentException("无法解析证书: " + file);
    }

    private static PrivateKey readKey(Path file) throws Exception {
        byte[] raw = Files.readAllBytes(file);
        if (raw.length > 0 && raw[0] == 0x30) {
            return KeyFactory.getInstance("EC", "BC").generatePrivate(new PKCS8EncodedKeySpec(raw));
        }
        try (PEMParser parser = new PEMParser(new java.io.InputStreamReader(
                new ByteArrayInputStream(raw), StandardCharsets.UTF_8))) {
            Object obj = parser.readObject();
            JcaPEMKeyConverter conv = new JcaPEMKeyConverter().setProvider("BC");
            if (obj instanceof PrivateKey) {
                return (PrivateKey) obj;
            }
            if (obj instanceof PEMKeyPair pair) {
                return conv.getKeyPair(pair).getPrivate();
            }
            if (obj instanceof org.bouncycastle.asn1.pkcs.PrivateKeyInfo pki) {
                return conv.getPrivateKey(pki);
            }
        }
        throw new IllegalArgumentException("无法解析私钥: " + file);
    }

    private static byte[] sm2Sign(byte[] data, PrivateKey key) throws Exception {
        Signature sg = Signature.getInstance("SM3withSM2", "BC");
        sg.initSign(key);
        sg.update(data);
        return sg.sign();
    }

    private static byte[] sm3(byte[] data) {
        return new org.bouncycastle.jcajce.provider.digest.SM3.Digest().digest(data);
    }

    private static void require(Path path, String message) {
        if (Files.notExists(path)) {
            throw new IllegalStateException(message + ": " + path);
        }
    }

    private static void check(boolean ok, String message) {
        if (!ok) {
            throw new IllegalStateException(message);
        }
    }

    private static boolean zipContentsEqual(Path a, Path b) throws Exception {
        Map<String, String> ea = zipDigests(a);
        Map<String, String> eb = zipDigests(b);
        if (!ea.keySet().equals(eb.keySet())) {
            return false;
        }
        for (String name : ea.keySet()) {
            if (!ea.get(name).equals(eb.get(name))) {
                return false;
            }
        }
        return true;
    }

    private static Map<String, String> zipDigests(Path zip) throws Exception {
        Map<String, String> result = new TreeMap<>();
        try (ZipFile zf = new ZipFile(zip.toFile())) {
            for (ZipEntry entry : Collections.list(zf.entries())) {
                if (entry.isDirectory()) {
                    continue;
                }
                try (InputStream in = zf.getInputStream(entry)) {
                    result.put(entry.getName(),
                            hex(MessageDigest.getInstance("SHA-256").digest(in.readAllBytes())));
                }
            }
        }
        return result;
    }

    private static byte[] appendByte(byte[] data, byte b) {
        byte[] out = new byte[data.length + 1];
        System.arraycopy(data, 0, out, 0, data.length);
        out[data.length] = b;
        return out;
    }

    private static Map<String, byte[]> readZip(Path file) throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        try (ZipInputStream in = new ZipInputStream(Files.newInputStream(file))) {
            ZipEntry entry;
            while ((entry = in.getNextEntry()) != null) {
                if (entry.isDirectory()) {
                    continue;
                }
                entries.put(entry.getName(), in.readAllBytes());
            }
        }
        return entries;
    }

    private static void writeZip(Path file, Map<String, byte[]> entries) throws IOException {
        try (ZipOutputStream out = new ZipOutputStream(Files.newOutputStream(file))) {
            for (Map.Entry<String, byte[]> e : entries.entrySet()) {
                ZipEntry entry = new ZipEntry(e.getKey());
                entry.setTime(0);
                out.putNextEntry(entry);
                out.write(e.getValue());
                out.closeEntry();
            }
        }
    }

    private static String sha256Hex(byte[] data) throws GeneralSecurityException {
        return hex(MessageDigest.getInstance("SHA-256").digest(data));
    }

    private static String hex(byte[] data) {
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (byte b : data) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private static Map<String, Object> mapOf(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    private static String toJson(Object obj) {
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