import org.bouncycastle.jcajce.provider.asymmetric.util.ECUtil;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.ofdrw.crypto.OFDDecryptor;
import org.ofdrw.crypto.decryptor.UserCertDecryptor;
import org.ofdrw.crypto.decryptor.UserPasswordDecryptor;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Security;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 独立 Java 解密基准生成器（t12 验证专用，不进入生产代码）。
 *
 * 使用 ofdrw 2.4.0 的 OFDDecryptor 解密口令/证书/组合样例，按 ZIP 条目输出
 * 路径、长度与 SHA-256，供 JS 验证逐文件比对。
 *
 * 用法：java JavaDecryptOracle <fixtureDir> <outputJson>
 */
public final class JavaDecryptOracle {
    private static final String PASSWORD_USER = "fixture-password-user";
    private static final String PASSWORD = "FixturePass123";
    private static final String CERT_USER = "fixture-cert-user";

    static {
        Security.addProvider(new BouncyCastleProvider());
    }

    private JavaDecryptOracle() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException("用法: JavaDecryptOracle <fixtureDir> <outputJson>");
        }
        Path fixtureDir = Paths.get(args[0]).toAbsolutePath().normalize();
        Path output = Paths.get(args[1]).toAbsolutePath().normalize();

        Map<String, Map<String, Entry>> cases = new TreeMap<>();
        cases.put("plain.ofd", readZip(fixtureDir.resolve("plain.ofd")));
        cases.put("password-encrypted.ofd", decryptPassword(
                fixtureDir, "password-encrypted.ofd"));
        cases.put("cert-encrypted.ofd", decryptCertificate(
                fixtureDir, "cert-encrypted.ofd"));
        cases.put("combined-signed-integrity.ofd", readZip(
                fixtureDir.resolve("combined-signed-integrity.ofd")));
        cases.put("combined-password-encrypted.ofd", decryptPassword(
                fixtureDir, "combined-password-encrypted.ofd"));

        StringBuilder json = new StringBuilder();
        json.append("{\n");
        json.append("  \"generatedBy\": \"ofdrw 2.4.0 OFDDecryptor (Java 21.0.2)\",\n");
        json.append("  \"cases\": {\n");
        int caseIndex = 0;
        for (Map.Entry<String, Map<String, Entry>> item : cases.entrySet()) {
            if (caseIndex > 0) json.append(",\n");
            caseIndex += 1;
            json.append("    ").append(quote(item.getKey())).append(": {\n");
            int entryIndex = 0;
            for (Map.Entry<String, Entry> entry : item.getValue().entrySet()) {
                if (entryIndex > 0) json.append(",\n");
                entryIndex += 1;
                json.append("      ").append(quote(entry.getKey())).append(": {");
                json.append("\"size\": ").append(entry.getValue().size).append(", ");
                json.append("\"sha256\": ").append(quote(entry.getValue().sha256)).append("}");
            }
            json.append("\n    }");
        }
        json.append("\n  }\n}\n");
        Files.writeString(output, json.toString(), StandardCharsets.UTF_8);
        System.out.println("JAVA_DECRYPT_OK " + output);
    }

    private static Map<String, Entry> decryptPassword(Path fixtureDir, String name) throws Exception {
        Path encrypted = fixtureDir.resolve(name);
        Path decrypted = Files.createTempFile("t12-java-password-", ".ofd");
        try {
            try (OFDDecryptor decryptor = new OFDDecryptor(encrypted, decrypted)) {
                decryptor.addUser(new UserPasswordDecryptor(PASSWORD_USER, PASSWORD));
                decryptor.decrypt();
            }
            return readZip(decrypted);
        } finally {
            Files.deleteIfExists(decrypted);
        }
    }

    private static Map<String, Entry> decryptCertificate(Path fixtureDir, String name) throws Exception {
        Path encrypted = fixtureDir.resolve(name);
        PrivateKey privateKey = readPrivateKey(fixtureDir.resolve("certs/encrypt.key.pem"));
        Path decrypted = Files.createTempFile("t12-java-cert-", ".ofd");
        try {
            try (OFDDecryptor decryptor = new OFDDecryptor(encrypted, decrypted)) {
                decryptor.addUser(new UserCertDecryptor(CERT_USER,
                        (org.bouncycastle.crypto.params.ECPrivateKeyParameters)
                                ECUtil.generatePrivateKeyParameter(privateKey)));
                decryptor.decrypt();
            }
            return readZip(decrypted);
        } finally {
            Files.deleteIfExists(decrypted);
        }
    }

    private static PrivateKey readPrivateKey(Path pemFile) throws Exception {
        String text = Files.readString(pemFile, StandardCharsets.US_ASCII);
        String base64 = text
                .replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replaceAll("\\s", "");
        byte[] der = Base64.getDecoder().decode(base64);
        return KeyFactory.getInstance("EC", "BC")
                .generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    private static Map<String, Entry> readZip(Path file) throws Exception {
        Map<String, Entry> result = new TreeMap<>();
        try (ZipFile zip = new ZipFile(file.toFile())) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            for (ZipEntry entry : Collections.list(entries)) {
                if (entry.isDirectory()) continue;
                try (InputStream input = zip.getInputStream(entry)) {
                    byte[] bytes = input.readAllBytes();
                    result.put(entry.getName(), new Entry(bytes.length, sha256(bytes)));
                }
            }
        }
        return result;
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte value : digest) hex.append(String.format("%02x", value));
        return hex.toString();
    }

    private static String quote(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static final class Entry {
        final int size;
        final String sha256;

        Entry(int size, String sha256) {
            this.size = size;
            this.sha256 = sha256;
        }
    }
}