import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const srcStyle = fileURLToPath(new URL('./src/style.css', import.meta.url));
const distStyle = fileURLToPath(new URL('./dist/style.css', import.meta.url));
const distDir = fileURLToPath(new URL('./dist', import.meta.url));

/**
 * `ofdrw-viewer-ui` 构建配置。
 *
 * - 单包多入口：核心 `.`、React `./react`、Vue `./vue`、Web Component `./element`；
 * - 同时产出 ESM/CJS 与 `.d.ts`，目标语法 ES2020；
 * - `@ofdrw/ofdrw-viewer-engine`、React/Vue、签章 ASN.1 库与 `fflate` 保持 external：
 *   核心产物不打包框架，签章解析仍可在宿主侧按需动态加载；
 * - CSS 不经过 JS 注入，单独复制为 `dist/style.css`，由 `./style.css` 导出。
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react/index.ts',
    vue: 'src/vue/index.ts',
    element: 'src/component/ofd-viewer-element.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  platform: 'browser',
  treeshake: true,
  splitting: true,
  external: [
    '@ofdrw/ofdrw-viewer-engine',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'vue',
    'asn1js',
    '@peculiar/asn1-schema',
    '@peculiar/asn1-x509',
    'fflate',
  ],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
  async onSuccess() {
    await mkdir(distDir, { recursive: true });
    await copyFile(srcStyle, distStyle);
  },
});