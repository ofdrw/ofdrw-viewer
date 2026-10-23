/**
 * 公开 API 文档同步检查。
 *
 * 读取包根 `src/index.ts` 的全部导出名，断言每个名字都出现在
 * `packages/ofdrw-viewer-engine/skills/API.md` 附录中；防止新增/改名导出后文档漏更。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 从 index.ts 文本提取所有 `export { ... } from` / `export type { ... } from` 的名字。 */
function exportedNames(source: string): string[] {
  const names: string[] = [];
  const pattern = /export\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
  for (const match of source.matchAll(pattern)) {
    const body = match[1] ?? '';
    for (const raw of body.split(',')) {
      const name = raw.trim();
      if (name) names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

describe('公开 API 文档同步', () => {
  it('src/index.ts 的每个导出都出现在 skills/API.md', () => {
    const indexPath = fileURLToPath(
      new URL('../../packages/ofdrw-viewer-engine/src/index.ts', import.meta.url),
    );
    const docPath = fileURLToPath(
      new URL('../../packages/ofdrw-viewer-engine/skills/API.md', import.meta.url),
    );
    const names = exportedNames(readFileSync(indexPath, 'utf8'));
    const doc = readFileSync(docPath, 'utf8');
    const missing = names.filter((name) => !doc.includes(`\`${name}\``));

    expect(names.length).toBeGreaterThan(0);
    expect(missing, `公开 API 文档缺少导出：${missing.join(', ')}`).toEqual([]);
  });
});