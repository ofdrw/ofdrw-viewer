# 受保护 OFD 夹具生成器

用 ofdrw 2.4.0 生成并校验 `packages/ofdrw-viewer-crypto/test/fixtures/crypto/` 下的 PEM/DER 测试证书、口令/证书加密 OFD、SESv4/v5 签章、防夹带完整性、组合样例与负例。

夹具的消费说明、凭据和预期结果见 [`fixtures/crypto/README.md`](../../packages/ofdrw-viewer-crypto/test/fixtures/crypto/README.md)。

> **所有证书/私钥仅用于测试，禁止用于生产。** 私钥无口令保护，任何拿到仓库的人都能使用。

## 1. 前置条件

| 依赖 | 要求 |
|---|---|
| JDK | **完整 JDK 21**（需要 `javac`；JRE 不够） |
| Maven | 3.8+ |
| ofdrw | 2.4.0，安装到工作区本地仓库 `.cache/m2`（不要写 `~/.m2`） |

系统只有 JRE 21 时，可把 OpenJDK 21 放到 `.cache/jdk21`；脚本会自动使用：

```bash
export JAVA_HOME=/home/kkk/project/ofdrw-view/.cache/jdk21
export PATH="$JAVA_HOME/bin:$PATH"
```

## 2. 构建 ofdrw 到本地仓库

```bash
cd references/ofdrw
JAVA_HOME=/path/to/jdk-21 \
mvn -B -Dmaven.repo.local=/home/kkk/project/ofdrw-view/.cache/m2 \
  -DskipTests -Dmaven.test.skip=true -Dgpg.skip=true \
  -Dmaven.javadoc.skip=true -Dsource.skip=true \
  -pl ofdrw-sign,ofdrw-crypto -am install
```

## 3. 生成

```bash
cd /home/kkk/project/ofdrw-view
bash scripts/crypto-fixtures/generate-fixtures.sh
```

可选参数：

```bash
bash scripts/crypto-fixtures/generate-fixtures.sh <fixtureDir> <baseOfd>
```

- `<fixtureDir>` 默认 `packages/ofdrw-viewer-crypto/test/fixtures/crypto`；
- `<baseOfd>` 默认 `references/ofdrw/ofdrw-crypto/src/test/resources/hello.ofd`；
- 若 `<fixtureDir>/certs/root-ca.crt.pem` 不存在，会先执行 `generate-certs`；
- 若证书已存在，不会覆盖，避免样例与已提交私钥失配；
- 生成结束会自动调用一次 Java 侧校验，失败则脚本非 0。

单独执行证书生成：

```bash
cd scripts/crypto-fixtures
mvn -B -q -Dmaven.repo.local=.../m2 compile exec:java \
  -Dexec.args="generate-certs .../packages/ofdrw-viewer-crypto/test/fixtures/crypto"
```

## 4. 校验

```bash
cd /home/kkk/project/ofdrw-view
bash scripts/crypto-fixtures/verify-fixtures.sh
```

校验分两步：

1. `manifest.sha256`：所有 `cases`/`certs` 路径存在且 SHA-256 匹配；
2. `CryptoFixtures verify`：用 ofdrw Java 侧执行
   - 明文打开；
   - 口令/证书解密并与 `plain.ofd` 比较；
   - `OFDValidator` + SESv4/SESv5 容器验签；
   - `OFDIntegrityVerifier` 完整性/夹带检查；
   - 组合样例解密后同时验签与完整性；
   - 负例必须失败；
   - 证书链（根 -> 签名者/加密者）与有效期、KeyUsage；
   - 单个样例 < 5MB、总计 < 20MB。

通过时输出类似：

```text
FIXTURES_VERIFY_OK .../fixtures/crypto
cases=12 totalBytes=137678 trustedRoot=valid trustRootMissing=unknown
```

## 5. 生成器做了什么

1. `generate-certs`：
   - 生成 SM2 根 CA、签名者、加密者、制章者、TSA 五套密钥；
   - 固定主题/有效期/KeyUsage/EKU，签名算法 `SM3withSM2`；
   - 每套输出证书 PEM/DER、PKCS#8 私钥 PEM/DER。
2. `generate`：
   - 复制基准为 `plain.ofd`；
   - `OFDEncryptor` + `UserPasswordEncryptor` 生成口令加密；
   - `OFDEncryptor` + `UserCertEncryptor` 生成证书加密（加密证书/私钥独立于签名证书）；
   - `OFDSigner` + `SESV4Container`/`SESV5Container` 生成签章，并挂 GM/T 0033 时间戳；
   - `OFDIntegrity` + `GMProtectSigner` 生成 GB/T 35275 完整性样例；
   - 先签名、再完整性、最后口令加密，生成组合样例；
   - 用 ZIP 重写生成 4 个负例：篡改引用文件、篡改 `SignedValue.dat`、篡改 `Signature.xml`、夹带未登记文件；
   - 写 `manifest.json` + `manifest.sha256`。
3. `verify`：
   - 不依赖 JS 实现，纯 ofdrw Java 侧校验，作为跨语言夹具的“真值”。

## 6. 重新生成与稳定性

证书固定主题/有效期，但密钥在首次生成时随机；之后不会覆盖。OFD 内的 FEK/IV、签章签名、时间戳、加密时间含随机/当前时间，因此：

- 重新生成会改变 `.ofd` 字节与 SHA-256；
- `manifest.json` / `manifest.sha256` 会同步更新；
- 测试应通过 manifest 或固定文件名引用，不要硬编码 SHA-256；
- 已提交的夹具与 manifest 是一组一致快照。

## 7. 文件清单

```text
scripts/crypto-fixtures/
├── README.md
├── pom.xml
├── generate-fixtures.sh
├── verify-fixtures.sh
└── src/main/java/org/ofdrw/fixtures/CryptoFixtures.java
```

`CryptoFixtures` 支持三种模式：

```text
generate-certs <fixtureDir>
generate       <fixtureDir> <baseOfd>
verify         <fixtureDir>
```

## 8. 版本与许可

- ofdrw 2.4.0，Apache License 2.0；
- 本脚本与生成的测试材料随仓库发布，遵循仓库 MIT 许可证；
- 测试证书/私钥仅用于测试，不构成生产信任。