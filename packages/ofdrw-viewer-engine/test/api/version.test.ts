/**
 * 引擎版本导出：公共入口的 VERSION/getVersion 必须与 package.json 一致。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION, getVersion } from '../../src/index';
import { VERSION as VERSION_FROM_MODULE, getVersion as getVersionFromModule } from '../../src/version';

describe('版本', () => {
  it('VERSION 与 package.json 一致', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(VERSION_FROM_MODULE).toBe(pkg.version);
  });

  it('getVersion 返回版本常量', () => {
    expect(getVersion()).toBe(VERSION);
    expect(getVersionFromModule()).toBe(VERSION);
  });
});