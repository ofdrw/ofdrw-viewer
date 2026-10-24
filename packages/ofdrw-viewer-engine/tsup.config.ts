import { defineConfig } from 'tsup';

/**
 * 引擎包构建配置。
 *
 * - 同时产出 ESM（dist/index.js）与 CJS（dist/index.cjs），并生成类型声明；
 * - 三方依赖保持 external，由宿主打包器/Node 解析，避免重复打包 fontkit/saxes/fflate；
 * - `platform: 'neutral'` 保证构建产物不注入 DOM/Node 专用 shim；
 * - `target: 'chrome67'` 把可选链/空值合并/类字段等降级到 Chrome 67 可解析的语法，
 *   同时保留 Chrome 67 已支持的 BigInt 字面量（ZIP64 依赖 `getBigUint64`）；
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
  external: ['fontkit', 'saxes', 'fflate'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});