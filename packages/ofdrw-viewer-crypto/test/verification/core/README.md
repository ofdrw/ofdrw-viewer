# V-CORE 独立验证：SM 算法、ASN.1 与证书基础层

本目录是 `t11 V-CORE` 的独立验收测试。测试只从包根公共入口
`@ofdrw/ofdrw-viewer-crypto` 调用，不依赖实现者单测结论；期望值来自
GB/T 标准向量、OpenSSL 3 CLI、ofdrw 2.4.0 Java PoC 与仓库 fixture。

## 文件

| 文件 | 覆盖 |
| --- | --- |
| `sm-openssl.verify.test.ts` | SM3 标准向量 + OpenSSL；SM4-CBC/PKCS#7/no-padding + OpenSSL；KDF GB/T 32918.3（OpenSSL SM3 独立构造、Java 向量）；错误/边界 |
| `sm2-openssl.verify.test.ts` | OpenSSL 生成 SM2 密钥；签名/验签双向互操作（默认/自定义 userId）；SM2 加解密双向互操作；SM2Cipher ASN.1/C1C3C2；曲线/结构/密钥错误 |
| `cert-openssl.verify.test.ts` | 5 张证书字段与 OpenSSL 逐项对照；签名链；PEM/DER/CER/Base64；data/pem/der 三态 loader；URL/path/filePath 由 UI 适配；去重/限制/取消/畸形输入 |
| `support.ts` | OpenSSL 调用、临时目录、fixture 读取、证书字段解析等独立工具 |

## 验证命令与结果

```bash
pnpm -C packages/ofdrw-viewer-crypto typecheck
# → exit 0

pnpm -C packages/ofdrw-viewer-crypto exec vitest run \
  test/verification/core test/core test/cert --passWithNoTests
# → 17 files / 165 tests 全部通过
#   其中独立验证 3 files / 32 tests

pnpm -C packages/ofdrw-viewer-crypto build
# → exit 0；dist/index.js、index.cjs、index.d.ts、index.d.cts
```

补充的浏览器验证（真实 Chromium，非 jsdom）：

```text
HeadlessChrome/145.0.0.0
esbuild --bundle --platform=browser 产物在页面内导入成功，结果：
sm3("abc") = 66c7f0f4...ba8e0
SM4 标准分组 = 681edf34d206965e86b3e94f536e4246
KDF("PocPass123",16) = b5d32da4c15e9b9dcc960d91d9c69e6c
签名证书指纹 = e425cc9a...6c6fd3
证书链 SM2 验签 = true
SM2 签名验签 = true
SM2 加解密回环 = "browser"
运行时导出 = 139
```

## 独立向量与交叉来源

- **SM3**：GB/T 32905 的 `""`、`"abc"`、`"abcd"×16`、100 万字节 `"a"` 向量；
  另用 `openssl dgst -sm3 -binary` 对空、中文/emoji、1024 byte 二进制、1 MB 输入实时复算。
- **SM4**：GB/T 32907 单分组标准向量；`openssl enc -sm4-cbc`（固定 key/IV、
  `-nosalt`，PKCS#7 与 `-nopad`）对长度 0/1/15/16/17/31/32/33/100/255/256/1024
  逐字节对照，并双向解密。
- **KDF**：ofdrw Java PoC 的 `PocPass123 → b5d32da4...`；用 OpenSSL SM3 按
  `Ha_i = SM3(Z || I2OSP(i,4))` 独立构造，覆盖 klen 1/15/16/31/32/33/47/48/100/255，
  4096 上限用已独立验证的 SM3 逐块复算；UTF-8 不归一化。
- **SM2**：OpenSSL `genpkey` 生成 sm2p256v1 PKCS#8；`pkeyutl -sign/-verify -rawin -digest sm3`
  双向互操作；默认 userId `1234567812345678`、自定义 userId 均覆盖；`pkeyutl -encrypt/-decrypt`
  双向互操作；SM2Cipher DER 与 C1C3C2 往返逐字节一致。
- **证书**：OpenSSL `x509` 输出主体/颁发者（`-nameopt sep_comma_plus`）、序列号、有效期、
  SHA-256 指纹、BasicConstraints、KeyUsage、ExtendedKeyUsage、SKI/AKI、公钥点；
  5 张 fixture 证书（root/signer/seal/encrypt/tsa）逐项一致；链签名由 OpenSSL
  `verify -vfyopt distid:1234567812345678` 与包内 `sm2Verify` 双重验证。

## OpenSSL 注意事项

OpenSSL 3 `pkeyutl` 未显式指定 `distid` 时使用**空 ID**，而 GB/T 32918 与本包默认
userId 是 `1234567812345678`。因此 SM2 签名/验签与证书链验证都必须显式传
`-pkeyopt distid:1234567812345678`（`verify` 用 `-vfyopt`），否则会出现
“OpenSSL 自己验签成功、与包互操作失败”的假象。本验证已覆盖该语义差异。

## 边界与错误

- SM3/SM4/KDF 的非字节输入、空口令、非法 klen、非法 key/IV 长度、非整块密文、
  坏 PKCS#7 填充、错误 key/IV 均返回 `CRYPTO_INVALID_ARGUMENT` / `CRYPTO_DECRYPT_FAILED` /
  `CRYPTO_CREDENTIALS_REQUIRED`，不泄漏密钥/明文。
- SM2 私钥标量 0/n、非曲线公钥、错误前缀/长度、签名格式错误、错误私钥解密、
  空密文均明确拒绝；SM2Cipher 的空 DER、字段数错误、C3 长度、空 C2、负整数、
  非最小整数、非曲线点均返回 `CRYPTO_ASN1_INVALID`。
- 证书空输入、截断 DER、错误 tag、PKCS#8 私钥、坏 PEM/Base64、超 `maxBytes`、
  超 `maxCertificates`、取消、输入形状冲突、缺少 loader、loader 异常均被拒绝；
  `skipInvalid` 路径产生 `W_CRYPTO_CERT_SOURCE_UNSUPPORTED` warning 并继续。

## 已知边界（非阻断）

- `sm2Encrypt` 的 JSDoc 允许空明文，但空明文产生的 C2 为空，既不能被
  `parseSm2Cipher` 解析，也不能被 `sm2Decrypt` 解回；OFD 业务只对非空 FEK
  使用 SM2，因此本任务不作为验收失败项，建议实现方后续把空明文改为
  `CRYPTO_INVALID_ARGUMENT` 或支持空 C2 以满足自身文档。
- 当前机器只有 Node v26.10.0，Node 22 兼容性由 t5 的 Node 22.22.0 验证与
  `target: es2022` 保证；ESM/CJS/browser 导入已由上面的手工浏览器验证与
  `pnpm build`+`check-compat` 覆盖，常驻构建产物用例已按测试精简移除。