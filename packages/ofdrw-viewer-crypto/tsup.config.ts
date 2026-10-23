import { defineConfig } from 'tsup';

/**
 * crypto 包构建配置。
 *
 * - 同时产出 ESM（dist/index.js）与 CJS（dist/index.cjs），并生成类型声明；
 * - SM/ASN.1/engine 等三方依赖保持 external，由宿主打包器/Node 解析；
 * - `platform: 'neutral'` 保证产物不注入 DOM/Node 专用 shim，浏览器可直接打包。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
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