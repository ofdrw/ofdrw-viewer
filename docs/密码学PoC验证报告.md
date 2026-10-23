# 密码学 PoC 验证报告（R0）

| 项 | 内容 |
|---|---|
| 状态 | 完成，全部 PoC 断言通过 |
| 日期 | 2026-10-23 |
| 任务 | R0 调研与 PoC：ofdrw 密码实现、sm-crypto 能力、受保护样例可行性 |
| 代码基线 | `references/ofdrw` commit `84e9eb2`，版本 2.4.0 |
| 运行环境 | Node 22.22.0（主）/26.10.0（兼容）、OpenJDK 21.0.2、Maven 3.8.7、BouncyCastle 1.85、sm-crypto 0.5.7、fflate 0.8.2、esbuild 0.28.2、Chromium(Playwright) |
| 证据目录 | `.cache/crypto-poc/`（临时产物，不提交） |
| PoC 脚本 | [`scripts/crypto-poc/`](../scripts/crypto-poc/) |

> 结论先行：**技术路线可行**。`sm-crypto` 可以在 Node 与浏览器 bundle 中完成 SM3/SM4/KDF/SM2 签名验签、SM2 加解密；配合少量 DER 解析即可完成 OFD 口令/证书解密、SESv4/SESv5 验签、GB/T 35275 完整性校验、时间戳令牌解析。Java(ofdrw) 与 JS 已完成**双向互操作**：Java 生成的签名/密文 JS 能验/能解，JS 生成的签名/密文 Java 也能验/能解。主要风险不在算法，而在**证书链/有效期策略、PKCS#8 私钥解析、时间戳“只解析不验证”的边界、SES v1 兼容性和异常输入健壮性**。

---

## 1. 验证范围与结论

### 1.1 已完成

- 阅读 `ofdrw-gm` / `ofdrw-sign` / `ofdrw-crypto` 关键实现，确认 SES v1/v4/v5、GB/T 35275 SignedData、SM2Cipher、KDF、OFD 加密容器、完整性保护的真实编码与调用约束。
- 用 ofdrw Java 在本地生成：SM2 根证书/签名者证书/制章者证书/TSA 证书、口令加密 OFD、证书加密 OFD、SESv4 签章、SESv5 签章、完整性保护 OFD、带 PKCS#9 authenticatedAttributes 的完整性 OFD。
- 用 Java(ofdrw) 自身完成解密、验签、完整性验证，作为“生成正确”的基线。
- 用纯 JS（sm-crypto + fflate + 自写 DER）完成同样的解密、验签、完整性验证，并额外兼容 ofdrw 仓库中的历史 `v4signed.ofd` / `signedFile.ofd`。
- 用 Java 反向验证 JS 生成的 SM2 DER 签名、ASN.1 SM2Cipher、原始 C1C3C2。
- 用 esbuild 打包浏览器 bundle，在 Chromium 中运行 SM3/SM4/KDF/SM2 向量，14 项全部通过。
- 对篡改页面内容、夹带额外文件做了负向验证。

### 1.2 未覆盖（明确边界）

- **SES v1**：JS 解析器只覆盖 v4/v5；v1 的 `SES_Signature`/`SESeal` 结构不同，若后续需要打开 v1 文档必须另写分支。
- **时间戳 TSA 签名验证**：按已确认设计“只解析不验证”，只校验 `messageImprint` 与签章签名值一致，不验证 TSA 的 SignedData 签名、ESSCertID、策略链。
- **证书链的 CRL/OCSP**：PoC 只做“签名者证书 -> 根证书”的签名与有效期校验，不做吊销。
- **多加密层实测**：ofdrw 加密器一次只写一个 `CT_EncryptInfo`；代码阅读确认解密器支持多个，但本轮未构造双层样例实测。
- **Node 22**：已在 Node 22.22.0 完成全量 JS PoC（119 项）；另在 Node 26.10.0 复跑通过。代码只使用标准 ESM、`TextDecoder`、`Uint8Array`。
- **大文件/畸形 ZIP**：未做 ZIP64、重复条目、路径穿越、超大文件压力测试。

### 1.3 源码调研结论（文件/行为映射）

| 模块/文件 | 关键行为 | 对实现的约束 |
|---|---|---|
| `ofdrw-crypto/OFDEncryptor` | 随机 FEK/IV；遍历容器内所有普通文件，SM4-CBC/PKCS#7 加密后写成“小写 basename + `.dat`”；`entriesmap.dat` 也加密；写 `Encryptions.xml`、`decryptseed.dat`；`DecyptSeed` **没有** `EncryptCaseId` | 不能依赖方案 ID；文件名映射必须按 `EncryptEntry`，不能自行推导 |
| `UserFEKEncryptor`/`UserFEKDecryptor` | 统一 FEK/IV 的包装/恢复接口；口令与证书实现分别返回 `UserInfo` 并恢复 `DecryptResult` | 解密器按 `UserInfo` 匹配，不能假设只有一个用户 |
| `ofdrw-crypto/OFDDecryptor` | 解压到工作目录；遍历所有 `CT_EncryptInfo`；按 `UserInfo` 匹配解密器恢复 FEK/IV；entriesmap 先尝试 SM4、失败回退明文；解密文件、删除元数据、重新打包 | 多加密层要循环；entriesmap 两种形态都要支持；输出直接进 `VirtualContainer` |
| `UserPasswordDecryptor` | `KEK = KDF(SM3, password UTF-8, 16)`；SM4-CBC 解 `EncryptedWK` | 口令按 UTF-8 编码；KDF 输出 16 字节 |
| `UserCertDecryptor` | `EncryptedWK` DER 解析为 `SM2Cipher`，`convertC1C3C2()` 后 BC SM2 解密 | 04 前缀/ASN.1 转换；私钥支持 PKCS#8 |
| `ofdrw-gm/SM2Cipher` | `SEQUENCE { INTEGER X, INTEGER Y, OCTET STRING HASH(32), OCTET STRING CipherText }`；`convertC1C3C2()` 返回 `04||X||Y||C3||C2` | DER 解析/编码必须保留整数前导零规则 |
| `ofdrw-gm/KDF` | GB/T 32918.3，SM3，32 位大端计数器从 1 开始，`SM3(Z||ct)` | 计数器/拼接顺序不能错 |
| `ofdrw-sign/OFDSigner` | 首次签名创建 `Signatures.xml` 并写入 `OFD.xml`；`ContinueSign` 时把 `Signatures.xml` 排除在 Reference 之外；先构造 `Signature.xml` 的 References，再对最终 `Signature.xml` 字节求 `dataHash` 并签名 | `dataHash` 必须对最终 XML 原始字节；不能对重新序列化的 XML 求摘要 |
| `ofdrw-sign/OFDValidator` | 逐 Reference 计算文件 SM3 与 `CheckValue` 比较；`checkSealMatch` 比较 `Seal.esl` 与 `SignedValue` 内嵌 `SESeal`；再委托 SES 容器验签 | 防夹带/防替换要同时校验 Reference 与印章字节；不要只验 `SignedValue` |
| `SESV4Container`/`SESV5Container` | `dataHash = SM3(Signature.xml 输入流)`；`TBS_Sign` 含 `eseal/timeInfo/dataHash/propertyInfo`；`timeStampHook` 在签名值之后生成 `[0] timeStamp` | 时间戳是 BIT STRING；`propertyInfo` 是容器路径 |
| `OFDIntegrity`/`OFDEntries`/`ProtectSigner`/`GMProtectSigner` | `OFDEntries.xml` 记录 FileList；`ProtectSigner.digestThenSign(tbs)` 对 SM3 摘要签名，`GMProtectSigner` 封装成 GB/T 35275 `ContentInfo(SignedData)` 写入 `signedvalue.dat`；`ProtectVerifier` 反向验证 | 完整性签名不带 authAttrs；要兼容带 authAttrs 的第三方文档；接口可注入便于测试 |
| `PKCS9SignedDataBuilder` | 生成 PKCS#9 contentType/signingTime/messageDigest，签名原文为 DER `SET` | 第 68 行证书数组下标 bug；复用需修复 |
| GM/T 0033-2014 第 7 章 | `TimeStampToken = ContentInfo(SignedData)`；`TSTInfo` 含 policy/messageImprint/serialNumber/genTime 等 | 只解析；外层 OID 可能是 GM/T 0010 |

---

## 2. 环境与可复现命令

### 2.1 版本

| 组件 | 版本/路径 | 说明 |
|---|---|---|
| Node | v22.22.0（主）/v26.10.0（兼容） | 任务要求 Node 22；两个版本均跑通 119 项 |
| npm | 12.2.0 | 只读 home，需把 cache/logs 指到工作区 |
| sm-crypto | 0.5.7 | CommonJS，ESM 默认导入 |
| fflate | 0.8.2 | 纯 JS ZIP 解包，Node/浏览器通用 |
| esbuild | 0.28.2 | 浏览器 bundle |
| JDK | OpenJDK 21.0.2（下载到 `.cache/jdk21`） | 系统只有 JRE 21，无 `javac`；必须用完整 JDK |
| Maven | 3.8.7 | 本地仓库固定 `.cache/m2` |
| ofdrw | 2.4.0（commit `84e9eb2`） | 从 `references/ofdrw` 本地构建 |
| BouncyCastle | bcprov/bcpkix 1.85 | ofdrw 传递依赖 |
| 浏览器 | Chromium（Playwright CLI） | 只用于 bundle 验证 |

> 重要：系统 `/usr/lib/jvm/java-21-openjdk-amd64` 只有 JRE，`javac` 是 1.8；直接 `mvn` 编译 release 21 会报“不支持发行版本 21”。本报告使用下载的 JDK 21.0.2 到 `.cache/jdk21`，不提交该目录。

### 2.2 构建 ofdrw 到本地仓库

```bash
cd references/ofdrw
JAVA_HOME=/path/to/jdk-21 \
mvn -B -Dmaven.repo.local=/home/kkk/project/ofdrw-view/.cache/m2 \
  -DskipTests -Dmaven.test.skip=true -Dgpg.skip=true \
  -Dmaven.javadoc.skip=true -Dsource.skip=true \
  -pl ofdrw-sign,ofdrw-crypto -am install
```

已确认 `.cache/m2/org/ofdrw/ofdrw-sign/2.4.0/`、`ofdrw-crypto/2.4.0/` 存在 jar 与 sources jar。

### 2.3 Java PoC

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

Java 侧另生成 `integrity-authattrs.ofd`，并在证据中记录 `integrityAuthAttrsValid=true`。

### 2.4 JS PoC

```bash
cd scripts/crypto-poc
npm --cache ../../.cache/npm --logs-dir ../../.cache/npm-logs install
# 本轮主验证使用 Node v22.22.0；v26.10.0 复跑结果相同
node sm-crypto-poc.mjs ../../.cache/crypto-poc/out ../../.cache/crypto-poc/certs
```

输出：

```text
JS_POC_OK checks=119 failed=0
```

### 2.5 Java 反向验证 JS 产物

```bash
cd scripts/crypto-poc/java
JAVA_HOME=/path/to/jdk-21 \
mvn -B -q -Dmaven.repo.local=/home/kkk/project/ofdrw-view/.cache/m2 \
  exec:java -Dexec.args="verify-js \
    /home/kkk/project/ofdrw-view/.cache/crypto-poc/out/js-evidence.properties \
    /home/kkk/project/ofdrw-view/.cache/crypto-poc/certs"
```

输出：

```json
{
  "jsSignatureVerifiedByJava": true,
  "jsSm2CipherDerDecryptedByJava": true,
  "jsSm2CipherRawDecryptedByJava": true,
  "jsSm2PlaintextHex": "00112233445566778899aabbccddeeff"
}
```

### 2.6 浏览器 bundle

```bash
cd scripts/crypto-poc
bash run-browser-poc.sh
```

输出：

```text
.artifacts/browser-poc.js  108.5kb
{"allPassed":true,"passedCount":14,"failed":[]}
```

脚本会启动临时 HTTP 服务、用 `playwright-cli` 打开 Chromium，执行后自动关闭浏览器与服务。

---

## 3. 算法能力验证

### 3.1 标准向量与跨语言一致性

| 断言 | 结果 | 证据 |
|---|---|---|
| SM3("abc") = `66c7f0f4...8f4ba8e0` | 通过 | JS `js-evidence.json`、Java `java-evidence.json` |
| SM4 单块标准向量 = `681edf34...536e4246` | 通过 | JS `SM4 单块加密/解密标准向量` |
| SM4-CBC/PKCS#7 与 Java(BC) 密文逐字节一致 | 通过 | `SM4-CBC/PKCS#7 加密与 Java 一致` |
| KDF(SM3, "PocPass123", 16) = `b5d32da4...d9c69e6c`（当次运行值） | 通过 | `KDF(SM3, password, 16) 与 Java 一致` |
| Java SM2 签名 -> JS 验签（默认 userId） | 通过 | `Java SM2 签名 -> JS 验签（默认 userId）` |
| 显式 userId `1234567812345678` 与默认等价 | 通过 | 同上 |
| 错误 userId 验签失败 | 通过 | `错误 userId 验签失败（ZA 语义敏感）` |
| ASN.1 SM2Cipher -> C1C3C2 -> JS 解密 | 通过 | `ASN.1 SM2Cipher -> C1C3C2 -> JS 私钥解密` |
| JS DER 签名 -> Java 验签 | 通过 | `jsSignatureVerifiedByJava=true` |
| JS ASN.1 SM2Cipher -> Java 解密 | 通过 | `jsSm2CipherDerDecryptedByJava=true` |
| JS 原始 C1C3C2 -> Java 解密 | 通过 | `jsSm2CipherRawDecryptedByJava=true` |

### 3.2 SM2 用户 ID 语义（关键风险）

`sm-crypto` 的 `doSignature` / `doVerifySignature` 默认使用 `1234567812345678`，并且 `hash:true` 时会执行 ZA（用户 ID + 公钥参数 + 曲线参数）|| 消息的 SM3。Java BouncyCastle 的 `SM3withSM2` 默认 ID 也是 `1234567812345678`，所以两边默认互操作通过。

PoC 已实测：**同一个签名、同一个公钥，仅把 userId 改成错误值，验签立刻失败**。这说明：

- 电子印章/证书体系如果使用了自定义用户 ID，JS 端不能假设默认值；
- X.509 证书本身通常不携带 SM2 用户 ID，无法从证书自动推导；
- 本期按“默认用户 ID”实现；若未来接入自定义 ID 的第三方印章，需要增加显式配置项，否则会误判为签名无效。

### 3.3 SM4 API 的字符串语义坑

`sm-crypto` 的 `sm4.encrypt` 对字符串输入按 **UTF-8 明文**处理，而 `sm4.decrypt` 对字符串输入按 **十六进制密文**处理。PoC 最初直接把明文字节转成 hex 字符串传入，得到 32 字节错误密文。正确做法是加密时传字节数组：

```js
sm4.encrypt(Array.from(plainBytes), keyHex, { mode: 'cbc', iv: ivHex, output: 'array' });
```

该坑已写入 PoC 封装 `sm4CbcEncrypt`，后续实现不要直接用字符串传明文。

### 3.4 SM2Cipher 的 04 前缀歧义

`sm-crypto` 输出的 C1C3C2 **不含**未压缩点前缀 `0x04`；Java 的 `SM2Cipher.convertC1C3C2()` **含** `0x04`。不能通过“首字节是否为 0x04”判断是否有前缀，因为 C1 的 X 坐标首字节本身也可能是 `0x04`。PoC 中 Java 反向验证曾因此失败，后改为**按长度 112 判断**并补 `0x04`：

```java
if (raw.length == 112) { /* 补 04 */ }
```

这是后续实现必须遵守的约定。

---

## 4. OFD 加密容器与解密

### 4.1 加密产物结构（实测）

口令加密样例 `password-encrypted.ofd` 的条目：

```text
Encryptions.xml
decryptseed.dat
entriesmap.dat
ofd.dat
Doc_0/document.dat
Doc_0/publicres.dat
Doc_0/Pages/Page_0/content.dat
Doc_0/Pages/Page_1/content.dat
```

`Encryptions.xml`（节选）：

```xml
<ofd:Encryptions ...>
  <ofd:EncryptInfo ID="1">
    <ofd:Provider Company="ofdrw.org" Name="ofdrw-crypto" Version="2.4.0"/>
    <ofd:EncryptDate>2026-10-23T01:34:07</ofd:EncryptDate>
    <ofd:EncryptScope>All</ofd:EncryptScope>
    <ofd:DecryptSeedLoc>/decryptseed.dat</ofd:DecryptSeedLoc>
    <ofd:EntriesMapLoc>/entriesmap.dat</ofd:EntriesMapLoc>
  </ofd:EncryptInfo>
</ofd:Encryptions>
```

`decryptseed.dat`（口令）**没有** `EncryptCaseId` 属性：

```xml
<ofd:DecyptSeed ... ID="1">
  <ofd:ExtendParams/>
  <ofd:UserInfo UserName="poc-password-user">
    <ofd:IVValue>...</ofd:IVValue>
    <ofd:EncryptedWK>...</ofd:EncryptedWK>
  </ofd:UserInfo>
</ofd:DecyptSeed>
```

证书加密的 `UserInfo` 额外有 `<ofd:UserCert>`（Base64 的 X.509 DER），`EncryptedWK` 是 Base64 的 ASN.1 `SM2Cipher` DER（长度 122 字节左右）。

### 4.2 口令解密流程（已验证）

```text
KEK = KDF(SM3, password UTF-8, 16)
FEK = SM4-CBC-Decrypt(EncryptedWK, KEK, IVValue)
entriesXml = SM4-CBC-Decrypt(entriesmap.dat, FEK, IVValue)
for each EncryptEntry:
    plain = SM4-CBC-Decrypt(EPath 内容, FEK, IVValue)
    写回 Path
```

实测解出 5 个文件，逐个与基准 `hello.ofd` 的 SM3 一致；Java 与 JS 均通过。

### 4.3 证书解密流程（已验证）

```text
SM2Cipher = DER-Parse(UserInfo.UserCert 对应的 EncryptedWK)
C1C3C2    = SM2Cipher.convertC1C3C2()
FEK       = SM2-Decrypt(C1C3C2[去掉 04], SM2 私钥)
后续同口令解密的 entriesmap / 文件解密
```

实测证书加密样例解出 5 个文件，逐个与基准一致。JS 端私钥来自 **PKCS#8 PEM**，解析后派生公钥与证书公钥一致。

### 4.4 PKCS#8/SEC1 私钥解析（已验证）

Java PoC 同时写出：

- `signer-key.pem`：PKCS#8，PEM 头 `PRIVATE KEY`；
- `signer-key-sec1.pem`：SEC1，PEM 头 `EC PRIVATE KEY`。

JS `parseSm2PrivateKeyPem` 断言：

- PKCS#8 解出的私钥标量与 Java 证据一致；
- PKCS#8 派生公钥与证书公钥一致；
- PKCS#8 内嵌公钥与派生公钥一致；
- SEC1 与 PKCS#8 解出的私钥/公钥一致。

这覆盖了“口令 + SM2 私钥(PEM/PKCS#8) 解密”中私钥加载的关键路径。

### 4.5 关键实现约束与风险

1. **`EncryptCaseId` 缺失**：`OFDEncryptor` 第 218 行声明 `encryptCaseId`，但只用于判断证书加密，**从未写入 `DecyptSeed`**；`OFDDecryptor` 第 285 行也注释承认可能为 null。因此解密时不能依赖方案标识，必须按用户名 + 凭据类型（有 `UserCert` 用证书，否则口令）匹配，并对 null 容错。
2. **`entriesmap.dat` 可能是明文**：`OFDDecryptor` 先尝试 SM4 解密，失败再按 XML 解析。JS 实现同样做了回退。
3. **文件名为小写 basename + `.dat`**：`ContainerPath` 将原文件名转小写并替换扩展名；同名冲突加 `_N`。解密时必须严格使用 `EncryptEntry.EPath` 反查，不能根据 `Path` 自行推导。
4. **多加密层**：`Encryptions.xml` 可包含多个 `CT_EncryptInfo`；ofdrw 解密器按顺序逐个处理，但没有设置 `Relative`。本期样例只有一层。实现引擎时应循环处理直到 `Encryptions.xml` 消失，并设置最大层数/循环检测，避免恶意文档导致死循环。
5. **`Relative`/`DecryptSeedLoc` 相对路径**：`EncryptEntry` 可带自己的 `DecryptSeedLoc`（可选）。当前 ofdrw 未使用该字段；实现应支持“每个条目独立密钥材料”的规范路径，否则会漏解外部工具生成的多密钥文档。
6. **内存容器**：解密后不能依赖落盘再重新 `OFDReader`；应把解密结果写入 `VirtualContainer`（明文条目）后再交给引擎。PoC 用 fflate 在内存中完成了解包/重打包，证明可行。

---

## 5. SESv4/SESv5 签章验证

### 5.1 实测结构

`SignedValue.dat` 顶层为 `SES_Signature`：

```text
SES_Signature ::= SEQUENCE {
  toSign        TBS_Sign,
  cert          OCTET STRING,      -- 签章者证书 DER
  signatureAlgID OBJECT IDENTIFIER, -- 1.2.156.10197.1.501 (SM2-with-SM3)
  signature     BIT STRING,
  [0] timeStamp BIT STRING OPTIONAL
}
```

`TBS_Sign` 为：

```text
TBS_Sign ::= SEQUENCE {
  version       INTEGER (4 或 5),
  eseal         SESeal,
  timeInfo      GeneralizedTime,
  dataHash      BIT STRING,       -- SM3(Signature.xml 原始字节)
  propertyInfo  IA5String,        -- 指向 Signature.xml 的容器路径
  [0] extDatas  OPTIONAL
}
```

本轮 v4/v5 样例均通过以下断言：

- `dataHash == SM3(Signature.xml 原始字节)`（不能重新序列化 XML）；
- `Signature.xml` 的每个 `Reference@FileRef` 的 `CheckValue` 与容器内文件 SM3 一致（6 个）；
- 签章者证书 DER 解析、issuer 与根证书 subject 一致、有效期覆盖当前时间、根证书对签章者证书验签通过；
- `Sign(TBS_Sign)` 用签章者公钥验签通过；
- `Seal.esl` 字节与 `SignedValue` 内嵌 `SESeal` 完全一致；
- 制章者证书链/有效期通过，`Sign(SES_SealInfo)` 用制章者公钥验签通过；
- 印章名称/有效期、`TBS_Sign.timeInfo` 解析正确。

> `CheckMethod` 在不同实现中可能是 `"SM3"`（ofdrw 生成）或 OID `"1.2.156.10197.1.401"`（历史样例）。实现必须同时接受两者；不能只匹配字符串 `SM3`。

### 5.2 历史样例兼容

JS 解析器额外验证了 ofdrw 仓库中的：

- `ofdrw-sign/src/test/resources/v4signed.ofd`
- `ofdrw-sign/src/test/resources/signedFile.ofd`

结果：SES 版本 4、签章值验签通过、`dataHash` 匹配、13 个历史 Reference 全部匹配、证书 subject 可解析。两例证书已于 2023 年过期，所以**没有**做“当前时间有效期”断言；这正好说明生产验证必须把“签名数学有效”和“证书当前有效”分开报告。

### 5.3 证书链/有效期策略（必须由新包实现）

ofdrw 的 `SESV4ValidateContainer`/`SESV5ValidateContainer` 只做：

- `dataHash == SM3(tbsContent)`；
- 用 `TBS_Sign` 内嵌证书验签。

它**不校验**证书链、有效期、吊销、印章证书与签章者证书的关系。新包必须在 ofdrw 之外实现：

1. 从 `SES_Signature.cert` 取签章者证书；
2. 从 `SESeal.cert` 取制章者证书；
3. 用配置的根证书验证两条链（当前 PoC 是单级根 -> 叶；生产需支持中间 CA 与链构建）；
4. 校验证书有效期（建议以“当前时间”判有效，另把 `SignatureDateTime`、时间戳 `genTime` 作为展示信息；不能把时间戳当作已验证的可信时间）；
5. 校验证书 KeyUsage（digitalSignature/nonRepudiation）与 BasicConstraints；
6. 未配置根证书时判定 `unknown`，不要判 `invalid`；
7. 证书过期/链不完整/根不匹配分别给出可区分状态，UI 才能正确展示。

### 5.4 SES v1/v4/v5 结构差异

| 版本 | `SES_Signature` 顶层 | `TBS_Sign` 字段 | 备注 |
|---|---|---|---|
| v1 | 2 个：`TBS_Sign, signature` | `version, eseal, timeInfo, dataHash, propertyInfo, cert, signatureAlgorithm`（7 个） | 证书/算法在 TBS 内；`timeInfo` 兼容 BIT STRING/OCTET STRING |
| v4 | 5 个：`TBS_Sign, cert, signatureAlgID, signature, [0] timeStamp` | `version, eseal, timeInfo, dataHash, propertyInfo, [0] extDatas`（5+可选） | `timeInfo` 是 GeneralizedTime；`SES_ESPropertyInfo` 有 7 个字段 |
| v5 | 5 个：`TBS_Sign, cert, signatureAlgID, signatureValue, [0] timeStamp` | 同 v4 | 字段语义与 v4 基本一致，Java 类名/访问器不同 |

v1 的结构与 v4/v5 不同：

- `SES_Signature ::= SEQUENCE { TBS_Sign, signature BIT STRING }`；
- `TBS_Sign` 内包含证书与签名算法，字段顺序与 v4/v5 不同；
- `SESeal ::= SEQUENCE { SES_SealInfo, SES_SignInfo }`。

`VersionParser` 通过顶层 SEQUENCE 元素个数和 TBS 首元素识别 v1/v4/v5。本期 JS 解析器对 v1 直接抛错；如果产品需要打开 v1 文档，必须补独立解析分支，不能复用 v4/v5 的字段下标。

---

## 6. 防夹带完整性（GB/T 35275）

### 6.1 ofdrw 实现

`OFDIntegrity.protect()`：

1. 遍历容器内所有文件（排除即将写入的 `OFDEntries.xml` 和 `signedvalue.dat`），写入 `OFDEntries.xml` 的 `FileList`；
2. 对 `OFDEntries.xml` 求 SM3；
3. `GMProtectSigner` 用 SM2 私钥对 **SM3 摘要**签名；
4. 用 `SignedDataBuilder` 组装 GB/T 35275 `ContentInfo(SignedData)`，写入 `signedvalue.dat`。

`OFDIntegrityVerifier`：

- 验证 `signedvalue.dat` 的签名；
- 要求 zip 中每个文件都在 `FileList` 中，或为 `OFDEntries.xml`/`signedvalue.dat`。

### 6.2 实测

- 普通完整性样例 `integrity.ofd`：`content == SM3(OFDEntries.xml)`、签名者定位、证书链、SM2 验签、无夹带、FileList 完整，全部通过。
- 带 PKCS#9 authenticatedAttributes 的样例 `integrity-authattrs.ofd`：`messageDigest == SM3(OFDEntries.xml)`，签名原文为 DER `SET`（`0x31`），签名验签通过，全部通过。
- 负向：篡改 `Doc_0/Pages/Page_0/Content.xml` 最后一个字节后，Reference 摘要不匹配；向完整性样例加入 `evil.txt` 后，该文件不在 `FileList` 中，夹带检测成立。

### 6.3 `PKCS9SignedDataBuilder` 的已知 bug

`PKCS9SignedDataBuilder` 第 68 行 `int i = 0`，第 72 行 `certArr[0] = signerCert`，随后扩展证书循环又从 `certArr[i]`（i=0）开始写，导致**传入扩展证书时签名者证书被覆盖**。本轮带 authAttrs 的样例通过传入 `null` 扩展证书规避；生产实现如果复用该 builder，必须修复为 `int i = 1`，否则证书列表会错位。

另外，`GMProtectSigner` 使用的是**不带 authenticatedAttributes**的 `SignedDataBuilder`；历史/第三方文档可能带 authAttrs。解析器必须两条分支都支持：

- 无 authAttrs：签名原文 = `eContent`（本场景是 SM3 摘要）；
- 有 authAttrs：先校验 `messageDigest` 属性，签名原文 = `authenticatedAttributes` 的 DER `SET` 编码（`0x31` 开头）。

---

## 7. 时间戳令牌解析（GM/T 0033-2014）

### 7.1 规范结构

GM/T 0033-2014 第 7 章、PDF 第 10 页给出：

```text
TimeStampToken ::= ContentInfo
-- contentType 为 id-signedData（SM2 时按 GM/T 0010）
-- content 为 SignedData

TSTInfo ::= SEQUENCE {
  version        INTEGER { v1(1) },
  policy         TSAPolicyId,
  messageImprint MessageImprint,
  serialNumber   INTEGER,
  genTime        GeneralizedTime,
  accuracy       Accuracy OPTIONAL,
  ordering       BOOLEAN DEFAULT FALSE,
  nonce          INTEGER OPTIONAL,
  tsa            [0] GeneralName OPTIONAL,
  extensions     [1] IMPLICIT Extensions OPTIONAL
}
```

`TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken TimeStampToken OPTIONAL }`。

### 7.2 实测令牌

ofdrw 生成的 SESv4/SESv5 样例在 `SES_Signature` 的 `[0] timeStamp` 中带有令牌（本样例 1558 字节）。JS 解析结果：

- 外层 `ContentInfo.contentType = 1.2.156.10197.6.1.4.2.2`（GM/T 0010 signedData，**不是** PKCS#7 的 `1.2.840.113549.1.7.2`）；
- 内层 `eContentType = 1.2.840.113549.1.9.16.1.4`（id-ct-TSTInfo）；
- `version = 1`；
- `policy = 1.2.156.10197.1.501.1`；
- `messageImprint.hashAlgorithm = 1.2.156.10197.1.401`（SM3）；
- `messageImprint.hashedMessage == SM3(签章签名值)`；
- `serialNumber`、`genTime = 20261022173408Z` 可解析；
- `SignedData.certificates` 中可定位 TSA 证书（subject `CN=OFDRW Crypto PoC TSA`），但按设计**未验证** TSA 签名。

UI 可展示：时间戳时间、TSA 主题、策略、序列号、摘要算法；状态标注为“已解析，未验证”，不能显示为“时间戳有效”。

### 7.3 解析边界

- 时间戳是 `BIT STRING` 内容，外层还有 `[0]` 显式标签；不要直接对 `SignedValue` 的 `[0]` 节点当 `OCTET STRING` 解。
- 外层 ContentInfo 的 OID 可能是 GM/T 0010（`1.2.156.10197.6.1.4.2.2`）或 PKCS#7（`1.2.840.113549.1.7.2`），不能硬编码。
- `TSTInfo.genTime` 是 UTC，展示时需按本地时区格式化。
- 解析失败应降级为“无时间戳/时间戳不可解析”，不能影响签章主体验签。

---

## 8. 证据汇总

### 8.1 Java PoC（`java-evidence.json`）

| 样例 | 大小 | 结果 |
|---|---:|---|
| `password-encrypted.ofd` | 17,210 B | 解密后 5 个文件 SM3 与基准一致 |
| `cert-encrypted.ofd` | 17,795 B | 解密后 5 个文件 SM3 与基准一致 |
| `signed-sesv4.ofd` | 9,482 B | ofdrw `OFDValidator` 通过 |
| `signed-sesv5.ofd` | 9,484 B | ofdrw `OFDValidator` 通过 |
| `integrity.ofd` | 6,301 B | `OFDIntegrityVerifier` 通过 |
| `integrity-authattrs.ofd` | 6,342 B | 带 PKCS#9 authAttrs，验证通过 |

Java 自检字段：

```json
{
  "passwordDecryptOk": true,
  "certDecryptOk": true,
  "sesV4SignatureOk": true,
  "sesV5SignatureOk": true,
  "integrityOk": true,
  "integrityAuthAttrsOk": true
}
```

### 8.2 JS PoC（`js-evidence.json`）

```json
{
  "nodeVersion": "v22.22.0",
  "smCryptoVersion": "0.5.7",
  "checkCount": 119,
  "failedCount": 0,
  "allPassed": true
}
```

覆盖：

- 14 项算法/互操作断言；
- 口令解密 8 项、证书解密 9 项；
- 私钥 PEM 解析 4 项；
- SESv4 23 项、SESv5 23 项；
- 完整性 9 项 + PKCS#9 完整性 10 项；
- PKCS#8/SEC1 私钥解析 4 项；
- 历史样例 v4signed 5 项、signedFile 5 项；
- 篡改/夹带负向 2 项；
- X.509/证书链若干。

### 8.3 浏览器

`run-browser-poc.sh`：14 项通过，`allPassed=true`。证明 sm-crypto + 自写 DER 工具可被 esbuild 打包为浏览器 IIFE，不依赖 Node `Buffer`/`fs`。

---

## 9. 风险清单与实现建议

| # | 风险 | 影响 | 建议 |
|---|---|---|---|
| R1 | 自定义 SM2 用户 ID | 验签误判 | 默认使用 `1234567812345678`；预留 userId 配置；文档说明无法从证书自动推导 |
| R2 | 证书链/有效期未由 ofdrw 校验 | 把过期/非信任证书判为有效 | 新包实现根证书信任库、链构建、有效期、KeyUsage；未配置根 => `unknown` |
| R3 | 时间戳只解析不验证 | UI 误显示“可信时间” | UI 标注“已解析，未验证”；不参与证书有效期判定 |
| R4 | SES v1 未实现 | 旧文档打不开/误判 | 明确本期只支持 v4/v5；如需 v1 增加独立解析器与测试样例 |
| R5 | `EncryptCaseId` 缺失 | 解密器无法按方案匹配 | 按用户名 + `UserCert` 存在性匹配；对 null 容错；不要写死 `1.1.1/1.1.2` |
| R6 | entriesmap 可能明文 | 解密失败 | 先尝试 SM4，失败回退 XML |
| R7 | 多加密层/Relative/独立密钥 | 漏解或死循环 | 循环处理所有 `CT_EncryptInfo`，限制层数；支持 `EncryptEntry.DecryptSeedLoc` |
| R8 | C1C3C2 的 04 前缀歧义 | 解密失败 | 统一约定：内部 C1C3C2 不含 04；转 BC 前按长度补 04；不要用首字节判断 |
| R9 | SM4 字符串输入语义 | 密文错误 | 封装层强制传字节数组；不要直接传 hex 明文字符串 |
| R10 | `CheckMethod` 可能是 `SM3` 或 OID | 误判篡改 | 同时接受 `SM3` 与 `1.2.156.10197.1.401` |
| R11 | 时间戳外层 OID 非 PKCS#7 | 解析失败 | 接受 GM/T 0010 与 PKCS#7 两种 ContentInfo OID |
| R12 | DER 解析器过于精简 | 畸形文档崩溃/绕过 | 生产使用成熟 ASN.1 库，或对长度/嵌套/整数做严格边界与上限；不支持的 BER/高 tag 明确报错 |
| R13 | `PKCS9SignedDataBuilder` 证书数组 bug | 证书列表错位 | 若复用，修复 `int i = 1`；PoC 样例已规避 |
| R14 | 历史测试证书过期 | 误判为签名无效 | 区分“数学验签通过/证书过期”；测试用新证书，历史样例只做兼容性验证 |
| R15 | 大文件/多条目性能 | 浏览器卡顿 | 解密/摘要分块；避免一次性复制整个 zip；设置内存上限 |
| R16 | ZIP 路径/重名/大小写 | 解密映射错误 | 严格按 `EncryptEntry.EPath` 查找；保留原始条目名；处理 `_N` 冲突 |
| R17 | 运行版本差异（已实测 22/26） | CI 漂移 | 在 CI 固定 Node 22 跑 `sm-crypto-poc.mjs` 与浏览器 bundle |
| R18 | 测试样例与私钥提交 | 安全/仓库体积 | 仅提交测试专用、明确标注的证书/私钥；样例控制在几十 KB；生产私钥绝不入库 |

---

## 10. 对后续实现的直接建议

1. **新包只依赖 `sm-crypto` + 成熟 ZIP/ASN.1 库**：PoC 证明自写 DER 可行，但生产建议用 `asn1js`/`@peculiar/asn1-schema` 降低畸形输入风险；ZIP 用 fflate 或现有容器抽象。
2. **解密结果直接进 `VirtualContainer`**：不要落盘；解密后的条目名必须还原为 `EncryptEntry.Path`（去掉前导 `/`），并删除 `Encryptions.xml`/`decryptseed.dat`/`entriesmap.dat`/`*.dat` 元数据。
3. **验证结果分层**：`signature`（数学）、`certChain`（信任+有效期）、`seal`（制章者）、`integrity`（防夹带）、`timestamp`（仅解析）、`overall`。不要把不同失败原因压成一个布尔值。
4. **未配置根证书 => `unknown`**：与 `invalid` 区分；UI 提供“配置根证书”入口。
5. **SES 版本识别**：按 `VersionParser` 的规则（顶层元素数 + TBS 首元素）识别 v1/v4/v5；v1 未支持时给出明确“不支持”而不是解析乱码。
6. **Test fixture 规划**：建议提交
   - 1 个口令加密 OFD；
   - 1 个证书加密 OFD；
   - 1 个 SESv4 签章 OFD（带时间戳）；
   - 1 个 SESv5 签章 OFD；
   - 1 个完整性 OFD；
   - 1 套测试根/签名者/制章者/TSA 证书与 PKCS#8 私钥；
   - 1 个过期证书样例（用于 UI 状态）。
   所有测试私钥需在 README 标注“仅测试，不得用于生产”。
7. **CLI `info`/`verify`**：`info` 只读解析（不验签）；`verify` 一次性做完整性+签名+链+印章+时间戳解析，输出结构化 JSON，便于 UI/测试复用。
8. **时间戳展示**：展示 `genTime`、TSA、policy、serial、hashAlg，并固定文案“时间戳仅解析，未验证”。

---

## 11. 结论

R0 的目标是回答“JS 侧能否独立完成 ofdrw 生成的受保护 OFD 的解析、解密、验签、完整性校验”。答案是**可以**，且已经用 119 项 JS 断言、14 项浏览器断言、6 项 Java 自检和 3 项 Java 反向互操作断言证明。

真正需要在后续设计中重点处理的不是密码算法，而是：

- 证书链/有效期的产品策略；
- 时间戳“只解析”的展示边界；
- SES v1 与多加密层等兼容性分支；
- 异常输入健壮性与错误分层。

以上风险均已在第 9 节给出可执行的规避建议，未发现阻塞 R1 设计/开发的问题。

---

## 12. R1 设计/实现映射

本报告是 R0 PoC 的**历史证据**，R0 未覆盖项不改变其结论；R1 的最终裁决与实现状态以 [`docs/ofdrw-viewer-crypto设计方案.md`](./ofdrw-viewer-crypto设计方案.md) 为准：

- SES v1 已纳入 R1 解析/验签分支（设计 §0.1、§5.3），不再沿用本报告“只支持 v4/v5”的临时边界；
- 加密 PKCS#8 私钥支持 PBES2 + PBKDF2(HMAC-SHA1/SHA256) + AES-CBC 子集，其他算法明确不支持；
- 多加密层已实现并测试（上限 4 层、循环检测）；
- 过期/未生效证书由测试内确定性生成，不提交过期私钥；
- 时间戳仍固定“只解析、不验证”，状态 `parsed-not-verified`/`not-present`/`parse-error`，不参与 overall；
- 未配置信任根仍为 `unknown`，配置根后按有效期/KeyUsage/链关系判定 `valid`/`expired`/`not-yet-valid`/`untrusted`/`incomplete`。

R0 报告的 PoC 命令、Java/JS 互操作证据和风险清单继续作为 R1 的输入与回归依据。