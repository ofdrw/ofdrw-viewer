# sm-crypto / ofdrw 密码学 PoC

本目录是 R0 调研的**可复现代码**，用于验证：

- `sm-crypto` 的 SM3、SM4-CBC/PKCS#7、KDF、SM2 签名/验签、SM2Cipher 加解密；
- 纯 JS 解密 ofdrw 生成的口令加密/证书加密 OFD；
- 纯 JS 解析并验证 SESv4/SESv5 电子签章、GB/T 35275 完整性签名、GM/T 0033 时间戳令牌（仅解析）；
- Java(ofdrw) 与 JS 的双向互操作；
- 浏览器 bundle 可行性。

结论与风险详见 [`docs/密码学PoC验证报告.md`](../../docs/密码学PoC验证报告.md)。

> 所有生成物写入仓库根目录的 `.cache/crypto-poc/`，不提交。测试证书/私钥仅用于 PoC，**禁止用于生产**。

## 1. 目录

```text
scripts/crypto-poc/
├── sm-crypto-poc.mjs        # Node 侧主 PoC：算法向量 + OFD 解密 + 签章/完整性验证
├── lib/
│   ├── der.mjs              # 最小 DER 解析/编码、X.509、PKCS#7 SignedData
│   ├── ofd.mjs              # OFD XML、Encryptions/DecyptSeed/entriesmap、SES/Seal/时间戳
│   └── vectors.mjs          # SM3/SM4/KDF/SM2 标准向量与跨语言断言
├── browser-entry.mjs        # 浏览器入口：运行固定向量并写出 window.__POC_RESULT__
├── browser-test.html        # 浏览器测试页
├── run-browser-poc.sh       # esbuild + 本地 HTTP + playwright-cli 一键测试
├── package.json
├── .gitignore
└── java/
    ├── pom.xml              # ofdrw-sign/ofdrw-crypto 2.4.0 + BC 1.85
    └── src/main/java/org/ofdrw/poc/CryptoPoc.java
```

## 2. 前置条件

| 依赖 | 要求 |
|---|---|
| Node.js | 22+；已在 22.22.0 与 26.10.0 验证 |
| npm | 可写工作区 cache（示例用 `.cache/npm`） |
| JDK | **完整 JDK 21**（不是 JRE；需要 `javac`） |
| Maven | 3.8+ |
| ofdrw | 2.4.0，构建到 `.cache/m2` |
| 浏览器测试 | `playwright-cli` + Chromium |

系统若只有 JRE 21，可下载 OpenJDK 21 到 `.cache/jdk21`，运行时设置：

```bash
export JAVA_HOME=/home/kkk/project/ofdrw-view/.cache/jdk21
export PATH="$JAVA_HOME/bin:$PATH"
```

## 3. 安装 JS 依赖

```bash
cd scripts/crypto-poc
npm --cache ../../.cache/npm --logs-dir ../../.cache/npm-logs install
```

> 若 home 目录只读，必须显式指定 `--cache` 与 `--logs-dir`，否则 npm 会在 `~/.npm/_logs` 写日志失败。

## 4. 构建 ofdrw（首次）

```bash
cd references/ofdrw
JAVA_HOME=/path/to/jdk-21 \
mvn -B -Dmaven.repo.local=/home/kkk/project/ofdrw-view/.cache/m2 \
  -DskipTests -Dmaven.test.skip=true -Dgpg.skip=true \
  -Dmaven.javadoc.skip=true -Dsource.skip=true \
  -pl ofdrw-sign,ofdrw-crypto -am install
```

生成 `.cache/m2/org/ofdrw/ofdrw-sign/2.4.0/` 与 `ofdrw-crypto/2.4.0/`。

## 5. 运行 Java PoC（生成样例与基线证据）

```bash
cd scripts/crypto-poc/java
JAVA_HOME=/path/to/jdk-21 \
mvn -B -Dmaven.repo.local=/home/kkk/project/ofdrw-view/.cache/m2 \
  compile exec:java \
  -Dexec.args="/home/kkk/project/ofdrw-view/.cache/crypto-poc/out \
               /home/kkk/project/ofdrw-view/.cache/crypto-poc/certs \
               /home/kkk/project/ofdrw-view/references/ofdrw/ofdrw-crypto/src/test/resources/hello.ofd"
```

输出：

```text
JAVA_POC_OK .../.cache/crypto-poc/out
passwordRoundTrip=true certRoundTrip=true sesV4=true sesV5=true integrity=true
```

生成：

| 文件 | 说明 |
|---|---|
| `certs/root-cert.pem` / `root-key.pem` | 测试根证书/私钥（PKCS#8） |
| `certs/signer-cert.pem` / `signer-key.pem` | 签章者证书/私钥（PKCS#8） |
| `certs/signer-key-sec1.pem` | 同一私钥的 SEC1 编码，用于解析对比 |
| `certs/seal-cert.pem` / `seal-key.pem` | 制章者证书/私钥 |
| `certs/tsa-cert.pem` / `tsa-key.pem` | TSA 证书/私钥（EKU timeStamping critical） |
| `out/password-encrypted.ofd` | 口令加密 |
| `out/password-decrypted.ofd` | Java 解密结果 |
| `out/cert-encrypted.ofd` | 证书加密 |
| `out/cert-decrypted.ofd` | Java 解密结果 |
| `out/signed-sesv4.ofd` | SESv4 签章 + 时间戳 |
| `out/signed-sesv5.ofd` | SESv5 签章 + 时间戳 |
| `out/integrity.ofd` | 防夹带完整性（无 authAttrs） |
| `out/integrity-authattrs.ofd` | 防夹带完整性（带 PKCS#9 authAttrs） |
| `out/java-evidence.json` / `.properties` | Java 证据（路径、大小、SHA-256、公钥、签名等） |
| `out/js-crosscheck-java.json` | Java 反向验证 JS 产物的结果 |

> Java PoC 每次运行都会生成新的证书、FEK、IV、签名，因此样例 SHA-256 每次不同，这是预期行为；验证的是结构与互操作，不是固定字节。

## 6. 运行 JS PoC

```bash
cd scripts/crypto-poc
node sm-crypto-poc.mjs ../../.cache/crypto-poc/out ../../.cache/crypto-poc/certs
```

输出：

```text
JS_POC_OK checks=119 failed=0
```

产物：

- `out/js-evidence.json`：逐条断言、版本、样例摘要；
- `out/js-evidence.properties`：供 Java 反向验证的签名/密文/明文；
- `out/browser-evidence.txt`：浏览器测试输出（如已运行）。

JS 会读取本次 Java 生成的证书与样例；若重新跑过 Java PoC，直接重跑本命令即可，无需改代码。

## 7. Java 反向验证 JS

```bash
cd scripts/crypto-poc/java
JAVA_HOME=/path/to/jdk-21 \
mvn -B -q -Dmaven.repo.local=/home/kkk/project/ofdrw-view/.cache/m2 \
  exec:java -Dexec.args="verify-js \
    /home/kkk/project/ofdrw-view/.cache/crypto-poc/out/js-evidence.properties \
    /home/kkk/project/ofdrw-view/.cache/crypto-poc/certs"
```

期望：

```json
{
  "jsSignatureVerifiedByJava": true,
  "jsSm2CipherDerDecryptedByJava": true,
  "jsSm2CipherRawDecryptedByJava": true,
  "jsSm2PlaintextHex": "00112233445566778899aabbccddeeff"
}
```

## 8. 浏览器 bundle 测试

```bash
cd scripts/crypto-poc
bash run-browser-poc.sh
```

脚本会：

1. 用 esbuild 打包 `browser-entry.mjs` 到 `.artifacts/browser-poc.js`；
2. 启动 `http://127.0.0.1:8765`；
3. 用 `playwright-cli` 打开 Chromium；
4. 执行固定向量，输出 `{"allPassed":true,"passedCount":14,...}`；
5. 关闭浏览器与 HTTP 服务。

> 脚本设置 `XDG_CACHE_HOME` 到工作区 `.cache`，避免 `playwright-cli` 在只读 home 下写缓存失败。

## 9. 重要约定（后续实现必读）

1. **SM4 字符串输入**：`sm4.encrypt` 把字符串当 UTF-8 明文，`sm4.decrypt` 把字符串当十六进制密文；统一传字节数组。
2. **SM2 C1C3C2**：`sm-crypto` 输出不含 `04` 前缀；BC 需要 `04`。不要用首字节判断，按长度 112 补前缀。
3. **SM2 userId**：默认 `1234567812345678`；自定义 userId 会导致验签失败，无法从证书自动推导。
4. **PKCS#8**：`parseSm2PrivateKeyPem` 同时支持 `PRIVATE KEY`（PKCS#8）与 `EC PRIVATE KEY`（SEC1）；只支持 SM2/EC 私钥。
5. **`EncryptCaseId`**：ofdrw 2.4.0 加密器未写入该字段，解密不能依赖它。
6. **`entriesmap.dat`**：可能被 SM4 加密，也可能是明文；先尝试解密，失败回退 XML。
7. **时间戳**：仅解析，不验证 TSA 签名；外层 ContentInfo 可能是 GM/T 0010 OID，不要硬编码 PKCS#7 OID。
8. **`CheckMethod`**：可能是 `SM3` 或 `1.2.156.10197.1.401`，两者都要接受。
9. **SES v1 未实现**：本 PoC 仅 v4/v5；v1 需要独立解析分支。

## 10. 清理

```bash
rm -rf scripts/crypto-poc/.artifacts scripts/crypto-poc/node_modules
rm -rf .cache/crypto-poc
```

`.gitignore` 已忽略 `node_modules/`、`.artifacts/`、`dist/`、`.playwright-cli/`、`*.log`；`.cache/` 由仓库根 `.gitignore` 忽略。不要提交生成的样例、私钥或大文件。