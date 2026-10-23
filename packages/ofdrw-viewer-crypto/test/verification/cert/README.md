# V-CERT 独立验证：证书 DER 输入与入口转换

> 执行者：cert-qa（t66）；只读验证，不修改实现。
> 目标：证明 crypto 公共证书接口只接收 DER `Uint8Array`、`certificatesToDer`
> 覆盖设计约定的全部格式，且 UI/CLI 的根证书入口与既有验签/解密结果不回归。

## 1. 文件

| 文件 | 覆盖 |
| --- | --- |
| `cert-der-boundary.verify.test.ts` | 接口边界（类型/运行时/源码与 `dist/index.d.ts` 无 `CertificateInput`）；`certificatesToDer` 的 PEM 单/多证书、CRLF/BOM、X509/TRUSTED CERTIFICATE、CER/DER 拼接、Base64、空/非法/非证书块、`maxBytes`/`maxCertificates` |
| `cert-der-regression.verify.test.ts` | 12 个受保护夹具的 `inspect`/`verifyOfd` 在 arraybuffer 与 byte-source 下逐字段一致；PEM 转换根 = DER 根的链结果一致；3 个加密夹具解密与 Java 基准逐文件 SHA-256 一致；时间戳固定“已解析，未验证” |
| `hashes.json` | 记录验证时 crypto/UI/CLI `src/**/*.ts` 聚合哈希、关键文件哈希与全部夹具文件哈希 |

UI/CLI 的独立用例分别位于：

- `packages/ofdrw-viewer-ui/test/verification/cert-der-root.verify.test.ts`：
  data/url/path/filePath 四态、`rootCertificates` 构造入口、多证书 PEM、
  错误根/URL 失败/loader 抛错/缺 loader/私钥 PEM 的 warning 与错误码；
- `packages/ofdrw-viewer-cli/test/verification/cert-der-root.verify.test.ts`：
  `--root` 的 PEM/CER/DER/Base64/CRLF/BOM/多证书/重复根，valid=0、
  unknown/invalid/非法证书=5、文件缺失/不可读=1。

## 2. 运行

```bash
pnpm -C packages/ofdrw-viewer-crypto exec vitest run test/verification/cert
pnpm -C packages/ofdrw-viewer-ui exec vitest run test/verification/cert-der-root.verify.test.ts
pnpm -C packages/ofdrw-viewer-cli exec vitest run test/verification/cert-der-root.verify.test.ts
```

完整门禁见任务 t66 的 6 条 verify 命令。

## 3. 哈希记录

`hashes.json` 的 `packageSrcAggregate` 按包内 `src/**/*.ts` 路径排序，对每个文件
累计 `"path\0sha256(file)\n"` 后再取 SHA-256；`fixtures` 为逐个夹具文件的 SHA-256。
`fixtureManifestSha256` 与 crypto 夹具 `manifest.sha256` 一致
（`71d80c1527cf2985bc22323a0469cc47ee30efcbeee58d2c716d2dc7fcf4885e`）。

## 4. 当前结果（2026-10-23，t66）

- crypto：V-CERT 2 文件 / 30 用例通过；全包 40 文件 / 426 用例通过；typecheck、build 通过。
- UI：V-CERT 1 文件 / 11 用例通过；全包 41 文件 / 296 用例通过；typecheck、build 通过。
- CLI：V-CERT 1 文件 / 8 用例通过；全包 19 文件 / 287 用例通过；typecheck、build 通过。
- 12 个夹具的 `manifest.sha256` 逐文件校验一致；arraybuffer 与 byte-source 的
  `inspect`/`verifyOfd` 报告（除绝对时间）逐字段一致；3 个加密夹具解密条目与
  Java `java-expected.json` 逐文件 SHA-256 一致。
- UI 文件只替换 `inspect`/`verifyOfd`：jsdom 与 crypto 模块的 `Uint8Array` realm
  不同，真实 `verifyOfd` 在 jsdom 下会把容器读取结果误判为非 Uint8Array；证书转换
  链路仍为真实实现，真实验签由 crypto V-CERT 与既有引擎/CLI/E2E 覆盖。
- 验证前后 crypto/UI/CLI 的 `src/**/*.ts` 聚合哈希与 `hashes.json` 一致，未修改实现。