/**
 * 公共类型导出检查：`FontInputLoader` 可被宿主 `import type` 使用。
 *
 * 类型在运行时擦除，这里通过编译期赋值 + `OFDOpenOptions.loadInput` 的结构
 * 兼容性，防止 `src/index.ts` 漏导出。
 */

import { describe, expect, it } from 'vitest';
import type {
  FontInput,
  FontInputLoader,
  OFDOpenOptions,
} from '@ofdrw/ofdrw-viewer-engine';

describe('FontInputLoader 公共类型', () => {
  it('可从包根 import type，并赋给 OFDOpenOptions.loadInput', () => {
    const loader: FontInputLoader = async (input: FontInput) => {
      if ('data' in input) return input.data;
      return null;
    };
    const options: Pick<OFDOpenOptions, 'loadInput'> = { loadInput: loader };
    expect(options.loadInput).toBe(loader);
  });
});