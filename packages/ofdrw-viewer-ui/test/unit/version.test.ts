/**
 * 阅读器版本导出：UI 版本与 package.json 一致，且与 engine/crypto 版本组合正确。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION as ENGINE_VERSION } from '@ofdrw/ofdrw-viewer-engine';
import { VERSION as CRYPTO_VERSION } from '@ofdrw/ofdrw-viewer-crypto';
import { VERSION, getVersions } from '../../src/version';

/** 读取包版本。 */
function readVersion(relativePath: string): string {
  const pkg = JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

describe('版本', () => {
  it('VERSION 与 package.json 一致', () => {
    expect(VERSION).toBe(readVersion('../../package.json'));
  });

  it('getVersions 组合 UI、engine 与 crypto 版本', () => {
    expect(getVersions()).toEqual({
      ui: VERSION,
      engine: ENGINE_VERSION,
      crypto: CRYPTO_VERSION,
    });
  });

  it('engine 与 crypto 版本与各自 package.json 一致', () => {
    expect(ENGINE_VERSION).toBe(readVersion('../../../ofdrw-viewer-engine/package.json'));
    expect(CRYPTO_VERSION).toBe(readVersion('../../../ofdrw-viewer-crypto/package.json'));
  });
});