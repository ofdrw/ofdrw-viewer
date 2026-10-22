import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 动态 chunk 的静态守护。
 *
 * 通过源码断言确保 `format.ts` 不静态 import 解码器；构建后 `format.js` 只保留
 * `import('./gif')`/`import('./jbig2')`/`import('./tiff')` 三个动态入口，解码表进入独立 chunk。
 */
describe('图片解码动态 chunk', () => {
  it('format.ts 只通过 import() 加载解码器', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/image/format.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"]\.\/jbig2['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\/tiff['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\/gif['"]/);
    expect(source).toContain("import('./jbig2')");
    expect(source).toContain("import('./tiff')");
    expect(source).toContain("import('./gif')");
  });

  it('解码器源码不含 WASM/Node 内置依赖', () => {
    for (const name of ['gif.ts', 'jbig2.ts', 'tiff.ts', 'format.ts']) {
      const source = readFileSync(
        fileURLToPath(new URL(`../../src/image/${name}`, import.meta.url)),
        'utf8',
      );
      expect(source).not.toMatch(/\.wasm|WebAssembly|node:|from\s+['"]fs['"]/);
    }
  });
});
