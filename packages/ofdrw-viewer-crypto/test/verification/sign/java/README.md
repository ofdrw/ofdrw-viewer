# t13 Java 基线生成器

[`JavaSignOracle.java`](./JavaSignOracle.java) 只用于生成独立基线，不进入产品代码。使用 ofdrw 2.4.0：

- `OFDValidator` + `SESV4ValidateContainer` / `SESV5ValidateContainer` 校验签章；
- `OFDIntegrityVerifier` 校验防夹带完整性；
- ofdrw GM 模块解析 SES v4/v5 `Seal.esl` 与 `SignedValue.dat` 字段；
- 用 `OFDDecryptor` 解密 `combined-password-encrypted.ofd` 后再校验；
- 临时构造“Seal.esl 截断”“Seal 制章人签名值翻转”“SignedValue 签名值翻转”“OFDEntries.xml 损坏”等变体，确认 Java 同样拒绝。

## 前置条件

- 完整 JDK 21（需要 `javac`；系统 `javac` 可能是 1.8，请显式使用 JDK 21 的路径）；
- 工作区已有 ofdrw 2.4.0 的 Maven 仓：`.cache/m2`（由 ofdrw 构建流程准备）；
- Maven 3.8+。

本仓库此前把 JDK 21 放在 `.cache/jdk21`，以下命令使用该路径；如不存在，可换成本机 JDK 21 的绝对路径。

## 生成步骤

在仓库根目录执行：

```bash
ROOT="$(pwd)"
FIXTURES="$ROOT/packages/ofdrw-viewer-crypto/test/fixtures/crypto"
OUT_DIR="$ROOT/.cache/t13"
mkdir -p "$OUT_DIR/classes" "$OUT_DIR/java"

# 1) 解析 ofdrw 2.4.0 依赖，生成 classpath
#    原 pom 随 scripts/ 移除，需自备引用 ofdrw 2.4.0 的 Maven 工程
mvn -q -f <your-ofdrw-pom.xml> \
  -Dmaven.repo.local="$ROOT/.cache/m2" \
  dependency:build-classpath \
  -Dmdep.outputFile="$OUT_DIR/cp.txt"

# 2) 编译生成器
"$ROOT/.cache/jdk21/bin/javac" -encoding UTF-8 \
  -cp "$(cat "$OUT_DIR/cp.txt")" \
  -d "$OUT_DIR/classes" \
  "$ROOT/packages/ofdrw-viewer-crypto/test/verification/sign/java/JavaSignOracle.java"

# 3) 运行并覆盖基线 JSON
"$ROOT/.cache/jdk21/bin/java" \
  -cp "$OUT_DIR/classes:$(cat "$OUT_DIR/cp.txt")" \
  JavaSignOracle "$FIXTURES" \
  "$ROOT/packages/ofdrw-viewer-crypto/test/verification/sign/java-expected.json" \
  "$OUT_DIR/java"
```

期望输出：

```text
JAVA_T13_ORACLE_OK .../test/verification/sign/java-expected.json
```

## 基线字段

- `cases`：签名/完整性布尔结果；失败项附带 Java 异常类型与消息。
- `seals`：v4/v5 的 `version/esId/name/typeCode/有效期/图片类型/尺寸/图片长度`。
- `signedValues`：v4/v5 的 `version/dataHash/signedAt/propertyInfo`。

生成器会临时写入 `.cache/t13/java` 后删除临时变体；复现完成后可清理整个 `.cache/t13`。
