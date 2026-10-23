import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.ofdrw.crypto.OFDDecryptor;
import org.ofdrw.crypto.decryptor.UserPasswordDecryptor;
import org.ofdrw.crypto.integrity.GMProtectVerifier;
import org.ofdrw.crypto.integrity.OFDIntegrityVerifier;
import org.ofdrw.gm.ses.parse.SESVersionHolder;
import org.ofdrw.gm.ses.parse.VersionParser;
import org.ofdrw.reader.OFDReader;
import org.ofdrw.sign.verify.OFDValidator;
import org.ofdrw.sign.verify.container.SESV4ValidateContainer;
import org.ofdrw.sign.verify.container.SESV5ValidateContainer;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.Security;
import java.security.cert.CertificateFactory;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * t13 独立 Java 基线：用 ofdrw 2.4.0 校验样例/负例，并解析 SES v4/v5 字段。
 *
 * 本程序只作为测试证据生成器，不进入产品代码；输出由
 * {@code test/verification/sign/java-expected.json} 固化，供 Vitest 对照。
 */
public final class JavaSignOracle {
    private static final String PASSWORD_USER = "fixture-password-user";
    private static final String PASSWORD = "FixturePass123";

    private JavaSignOracle() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            throw new IllegalArgumentException("usage: JavaSignOracle <fixtureDir> <outJson> <tempDir>");
        }
        Security.addProvider(new BouncyCastleProvider());
        Path fixtureDir = Paths.get(args[0]);
        Path outJson = Paths.get(args[1]);
        Path tempDir = Paths.get(args[2]);
        Files.createDirectories(tempDir);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("generatedBy", "test/verification/sign/java/JavaSignOracle.java");
        result.put("ofdrwVersion", "2.4.0");
        result.put("note", "OFDValidator/SESV4/SESV5 与 OFDIntegrityVerifier 的独立基线；由 Java 21 + ofdrw 2.4.0 生成");

        Map<String, Object> cases = new LinkedHashMap<>();
        cases.put("signed-sesv4.ofd", signatureCase(fixtureDir.resolve("signed-sesv4.ofd"), 4));
        cases.put("signed-sesv5.ofd", signatureCase(fixtureDir.resolve("signed-sesv5.ofd"), 5));
        cases.put("integrity.ofd", integrityCase(fixtureDir.resolve("integrity.ofd")));
        cases.put("combined-signed-integrity.ofd", combinedCase(fixtureDir.resolve("combined-signed-integrity.ofd"), 4));
        cases.put("negative-tampered-content.ofd", signatureCase(fixtureDir.resolve("negative-tampered-content.ofd"), 4));
        cases.put("negative-tampered-signedvalue.ofd", signatureCase(fixtureDir.resolve("negative-tampered-signedvalue.ofd"), 4));
        cases.put("negative-tampered-signature.ofd", signatureCase(fixtureDir.resolve("negative-tampered-signature.ofd"), 4));
        cases.put("negative-extra-file.ofd", integrityCase(fixtureDir.resolve("negative-extra-file.ofd")));

        Path decrypted = tempDir.resolve("combined-password-decrypted.ofd");
        try {
            try (OFDDecryptor decryptor = new OFDDecryptor(
                    fixtureDir.resolve("combined-password-encrypted.ofd"), decrypted)) {
                decryptor.addUser(new UserPasswordDecryptor(PASSWORD_USER, PASSWORD));
                decryptor.decrypt();
            }
            cases.put("combined-password-encrypted.ofd(decrypted)", combinedCase(decrypted, 4));
        } finally {
            Files.deleteIfExists(decrypted);
        }

        // 独立构造 Seal.esl 截断与 OFDEntries.xml 篡改，确认 Java 侧同样拒绝。
        Path tamperedSeal = tempDir.resolve("security-tampered-seal.ofd");
        byte[] seal = readZipEntry(fixtureDir.resolve("signed-sesv4.ofd"), "Doc_0/Signs/Sign_0/Seal.esl");
        rewriteZip(
                fixtureDir.resolve("signed-sesv4.ofd"),
                tamperedSeal,
                Map.of("Doc_0/Signs/Sign_0/Seal.esl", java.util.Arrays.copyOf(seal, seal.length - 1)));
        try {
            cases.put("security-tampered-seal.ofd", signatureCase(tamperedSeal, 4));
        } finally {
            Files.deleteIfExists(tamperedSeal);
        }

        // 保持 DER 结构不变，仅翻转签名值首字节：验证数学验签失败而非解析失败。
        Path tamperedSignatureValue = tempDir.resolve("security-tampered-signature-value.ofd");
        byte[] signedValue = readZipEntry(fixtureDir.resolve("signed-sesv4.ofd"), "Doc_0/Signs/Sign_0/SignedValue.dat");
        org.ofdrw.gm.ses.v4.SES_Signature signature = org.ofdrw.gm.ses.v4.SES_Signature.getInstance(signedValue);
        byte[] signatureBytes = signature.getSignature().getOctets();
        signatureBytes[0] ^= 0x01;
        signature.setSignature(signatureBytes);
        rewriteZip(
                fixtureDir.resolve("signed-sesv4.ofd"),
                tamperedSignatureValue,
                Map.of("Doc_0/Signs/Sign_0/SignedValue.dat", signature.getEncoded("DER")));
        try {
            cases.put("security-tampered-signature-value.ofd", signatureCase(tamperedSignatureValue, 4));
        } finally {
            Files.deleteIfExists(tamperedSignatureValue);
        }

        // 保持 Seal.esl DER 结构不变，仅翻转制章人签名值：验证 Seal 数学验签失败。
        Path tamperedSealSignature = tempDir.resolve("security-tampered-seal-signature.ofd");
        byte[] sealBytes = readZipEntry(fixtureDir.resolve("signed-sesv4.ofd"), "Doc_0/Signs/Sign_0/Seal.esl");
        org.ofdrw.gm.ses.v4.SESeal sealObject = org.ofdrw.gm.ses.v4.SESeal.getInstance(sealBytes);
        byte[] sealSignatureBytes = sealObject.getSignedValue().getOctets();
        sealSignatureBytes[0] ^= 0x01;
        sealObject.setSignedValue(sealSignatureBytes);
        rewriteZip(
                fixtureDir.resolve("signed-sesv4.ofd"),
                tamperedSealSignature,
                Map.of("Doc_0/Signs/Sign_0/Seal.esl", sealObject.getEncoded("DER")));
        try {
            cases.put("security-tampered-seal-signature.ofd", signatureCase(tamperedSealSignature, 4));
        } finally {
            Files.deleteIfExists(tamperedSealSignature);
        }

        Path tamperedEntries = tempDir.resolve("security-tampered-entries.ofd");
        byte[] entries = readZipEntry(fixtureDir.resolve("integrity.ofd"), "OFDEntries.xml");
        byte[] badEntries = entries.clone();
        badEntries[badEntries.length - 1] = '?';
        rewriteZip(
                fixtureDir.resolve("integrity.ofd"),
                tamperedEntries,
                Map.of("OFDEntries.xml", badEntries));
        try {
            cases.put("security-tampered-entries.ofd", integrityCase(tamperedEntries));
        } finally {
            Files.deleteIfExists(tamperedEntries);
        }
        result.put("cases", cases);

        Map<String, Object> seals = new LinkedHashMap<>();
        seals.put("signed-sesv4.ofd", sealInfo(fixtureDir.resolve("signed-sesv4.ofd")));
        seals.put("signed-sesv5.ofd", sealInfo(fixtureDir.resolve("signed-sesv5.ofd")));
        result.put("seals", seals);

        Map<String, Object> signedValues = new LinkedHashMap<>();
        signedValues.put("signed-sesv4.ofd", signedValueInfo(fixtureDir.resolve("signed-sesv4.ofd")));
        signedValues.put("signed-sesv5.ofd", signedValueInfo(fixtureDir.resolve("signed-sesv5.ofd")));
        result.put("signedValues", signedValues);

        Files.writeString(outJson, toJson(result), StandardCharsets.UTF_8);
        System.out.println("JAVA_T13_ORACLE_OK " + outJson);
    }

    private static Map<String, Object> signatureCase(Path file, int version) {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            validateSignature(file, version);
            out.put("signature", Map.of("valid", true));
        } catch (Throwable error) {
            out.put("signature", failure(error));
        }
        return out;
    }

    private static Map<String, Object> integrityCase(Path file) {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            boolean valid = new OFDIntegrityVerifier().integrity(file, new GMProtectVerifier());
            out.put("integrity", Map.of("valid", valid));
        } catch (Throwable error) {
            out.put("integrity", failure(error));
        }
        return out;
    }

    private static Map<String, Object> combinedCase(Path file, int version) {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            validateSignature(file, version);
            out.put("signature", Map.of("valid", true));
        } catch (Throwable error) {
            out.put("signature", failure(error));
        }
        try {
            boolean valid = new OFDIntegrityVerifier().integrity(file, new GMProtectVerifier());
            out.put("integrity", Map.of("valid", valid));
        } catch (Throwable error) {
            out.put("integrity", failure(error));
        }
        return out;
    }

    private static void validateSignature(Path file, int version) throws Exception {
        try (OFDReader reader = new OFDReader(file);
             OFDValidator validator = new OFDValidator(reader)) {
            validator.setValidator(version == 4 ? new SESV4ValidateContainer() : new SESV5ValidateContainer());
            validator.exeValidate();
        }
    }

    private static Map<String, Object> failure(Throwable error) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("valid", false);
        out.put("error", error.getClass().getSimpleName());
        String message = error.getMessage();
        out.put("message", message == null ? "" : message);
        return out;
    }

    private static Map<String, Object> sealInfo(Path file) throws Exception {
        byte[] bytes = readZipEntry(file, "Doc_0/Signs/Sign_0/Seal.esl");
        SESVersionHolder holder = VersionParser.parseSES_SealVersion(bytes);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("version", holder.getVersion().name());
        if (holder.getVersion().getVersion() == 4) {
            org.ofdrw.gm.ses.v4.SESeal seal = holder.getInstanceV4Seal();
            org.ofdrw.gm.ses.v4.SES_SealInfo info = seal.geteSealInfo();
            org.ofdrw.gm.ses.v4.SES_ESPropertyInfo property = info.getProperty();
            out.put("esId", info.getEsID().getString());
            out.put("name", property.getName().getString());
            out.put("typeCode", property.getType().getValue().intValue());
            out.put("createDate", property.getCreateDate().getDate().toInstant().toString());
            out.put("validStart", property.getValidStart().getDate().toInstant().toString());
            out.put("validEnd", property.getValidEnd().getDate().toInstant().toString());
            out.put("pictureType", info.getPicture().getType().getString());
            out.put("pictureWidthMm", info.getPicture().getWidth().getValue().intValue());
            out.put("pictureHeightMm", info.getPicture().getHeight().getValue().intValue());
            out.put("pictureLength", info.getPicture().getData().getOctets().length);
        } else if (holder.getVersion().getVersion() == 5) {
            org.ofdrw.gm.ses.v5.SESeal seal = holder.getInstanceV5Seal();
            org.ofdrw.gm.ses.v5.SES_SealInfo info = seal.geteSealInfo();
            org.ofdrw.gm.ses.v5.SES_ESPropertyInfo property = info.getProperty();
            out.put("esId", info.getEsID().getString());
            out.put("name", property.getName().getString());
            out.put("typeCode", property.getType().getValue().intValue());
            out.put("createDate", property.getCreateDate().getDate().toInstant().toString());
            out.put("validStart", property.getValidStart().getDate().toInstant().toString());
            out.put("validEnd", property.getValidEnd().getDate().toInstant().toString());
            out.put("pictureType", info.getPicture().getType().getString());
            out.put("pictureWidthMm", info.getPicture().getWidth().getValue().intValue());
            out.put("pictureHeightMm", info.getPicture().getHeight().getValue().intValue());
            out.put("pictureLength", info.getPicture().getData().getOctets().length);
        } else {
            throw new IllegalArgumentException("仅支持 v4/v5: " + file);
        }
        return out;
    }

    private static Map<String, Object> signedValueInfo(Path file) throws Exception {
        byte[] bytes = readZipEntry(file, "Doc_0/Signs/Sign_0/SignedValue.dat");
        SESVersionHolder holder = VersionParser.parseSES_SignatureVersion(bytes);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("version", holder.getVersion().name());
        if (holder.getVersion().getVersion() == 4) {
            org.ofdrw.gm.ses.v4.TBS_Sign tbs = holder.getInstanceV4().getToSign();
            out.put("dataHash", hex(tbs.getDataHash().getOctets()));
            out.put("signedAt", tbs.getTimeInfo().getDate().toInstant().toString());
            out.put("propertyInfo", tbs.getPropertyInfo().getString());
        } else if (holder.getVersion().getVersion() == 5) {
            org.ofdrw.gm.ses.v5.TBS_Sign tbs = holder.getInstanceV5().getToSign();
            out.put("dataHash", hex(tbs.getDataHash().getOctets()));
            out.put("signedAt", tbs.getTimeInfo().getDate().toInstant().toString());
            out.put("propertyInfo", tbs.getPropertyInfo().getString());
        } else {
            throw new IllegalArgumentException("仅支持 v4/v5: " + file);
        }
        return out;
    }

    private static byte[] readZipEntry(Path zipPath, String entryName) throws IOException {
        try (ZipFile zip = new ZipFile(zipPath.toFile())) {
            ZipEntry entry = zip.getEntry(entryName);
            if (entry == null) throw new IOException("缺少条目: " + entryName);
            try (InputStream input = zip.getInputStream(entry)) {
                return input.readAllBytes();
            }
        }
    }

    private static void rewriteZip(Path source, Path dest, Map<String, byte[]> replacements) throws IOException {
        try (ZipFile zip = new ZipFile(source.toFile());
             OutputStream fileOut = Files.newOutputStream(dest);
             ZipOutputStream out = new ZipOutputStream(fileOut)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                out.putNextEntry(new ZipEntry(entry.getName()));
                if (!entry.isDirectory()) {
                    byte[] replacement = replacements.get(entry.getName());
                    if (replacement == null) {
                        try (InputStream input = zip.getInputStream(entry)) {
                            input.transferTo(out);
                        }
                    } else {
                        out.write(replacement);
                    }
                }
                out.closeEntry();
            }
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format("%02x", value & 0xff));
        return out.toString();
    }

    private static String toJson(Object value) {
        if (value == null) return "null";
        if (value instanceof String string) return "\"" + escape(string) + "\"";
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        if (value instanceof Map<?, ?> map) {
            List<String> parts = new ArrayList<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                parts.add("\"" + escape(String.valueOf(entry.getKey())) + "\":" + toJson(entry.getValue()));
            }
            return "{" + String.join(",", parts) + "}";
        }
        if (value instanceof Iterable<?> iterable) {
            List<String> parts = new ArrayList<>();
            for (Object item : iterable) parts.add(toJson(item));
            return "[" + String.join(",", parts) + "]";
        }
        throw new IllegalArgumentException("unsupported JSON value: " + value.getClass());
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }
}
