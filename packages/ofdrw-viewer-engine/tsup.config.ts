import { defineConfig } from 'tsup';

/**
 * 引擎包构建配置。
 *
 * - 同时产出 ESM（dist/index.js）与 CJS（dist/index.cjs），并生成类型声明；
 * - 三方依赖保持 external，由宿主打包器/Node 解析，避免重复打包 fontkit/saxes/fflate；
 * - `platform: 'neutral'` 保证构建产物不注入 DOM/Node 专用 shim。
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
  external: ['fontkit', 'saxes', 'fflate'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});