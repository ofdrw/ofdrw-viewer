import { defineConfig } from 'tsup';

/**
 * crypto 包构建配置。
 *
 * - 同时产出 ESM（dist/index.js）与 CJS（dist/index.cjs），并生成类型声明；
 * - SM/ASN.1/engine 等三方依赖保持 external，由宿主打包器/Node 解析；
 * - `platform: 'neutral'` 保证产物不注入 DOM/Node 专用 shim，浏览器可直接打包；
 * - `target: 'chrome67'` 把可选链/空值合并/类字段等降级到 Chrome 67 可解析的语法；
 *   Chrome 67 原生支持 BigInt，`chrome67` 会保留源码中的 BigInt 字面量；
 * - `compat` 是独立入口，供宿主/Worker 通过子路径提前安装兼容补丁。
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/compat.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'chrome67',
  platform: 'neutral',
  treeshake: true,
  external: [
    '@ofdrw/ofdrw-viewer-engine',
    '@peculiar/asn1-schema',
    '@peculiar/asn1-x509',
    'asn1js',
    'fflate',
    'saxes',
    'sm-crypto',
  ],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});