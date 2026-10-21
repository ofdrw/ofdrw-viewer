import { describe, expect, it } from 'vitest';
import {
  assertSafePackagePath,
  dirnameOf,
  normalizePackagePath,
  resolvePackagePath,
} from '../../src/container/path';
import { OFDError } from '../../src/errors';

describe('container/path', () => {
  it('规范化前导斜杠、反斜杠、点段与重复斜杠', () => {
    expect(normalizePackagePath('/Doc_0/Pages/Page_0/Content.xml')).toBe(
      'Doc_0/Pages/Page_0/Content.xml',
    );
    expect(normalizePackagePath('Doc_0\\Pages\\Page_0.xml')).toBe('Doc_0/Pages/Page_0.xml');
    expect(normalizePackagePath('./Doc_0/./Res//image.png')).toBe('Doc_0/Res/image.png');
    expect(normalizePackagePath('Doc_0/a/../b.xml')).toBe('Doc_0/b.xml');
    expect(normalizePackagePath('/')).toBe('');
    expect(normalizePackagePath('')).toBe('');
  });

  it('拒绝逃出包根、盘符、UNC 与控制字符', () => {
    for (const path of ['../evil', 'a/../../evil', '..', '/../x']) {
      expect(() => normalizePackagePath(path)).toThrow(OFDError);
    }
    for (const path of ['C:/Windows/system32', 'file:///etc/passwd', '//server/share/x', 'a\u0000b']) {
      expect(() => normalizePackagePath(path)).toThrow(OFDError);
    }
  });

  it('resolvePackagePath 处理相对路径与包内绝对路径', () => {
    expect(resolvePackagePath('Doc_0/Pages', 'Page_0/Content.xml')).toBe(
      'Doc_0/Pages/Page_0/Content.xml',
    );
    expect(resolvePackagePath('Doc_0', '/Doc_0/Res/a.png')).toBe('Doc_0/Res/a.png');
    expect(resolvePackagePath('Doc_0/Res', '../Res/b.png')).toBe('Doc_0/Res/b.png');
    expect(resolvePackagePath('Doc_0', '/')).toBe('');
    expect(resolvePackagePath('', 'OFD.xml')).toBe('OFD.xml');
    expect(() => resolvePackagePath('Doc_0', '../../../etc/passwd')).toThrow(OFDError);
  });

  it('BaseLoc="/" 解析为包根', () => {
    // 资源 XML 位于 Doc_0/PublicRes.xml，BaseLoc="/" 时 MediaFile="/Doc_0/Res/2.gif"。
    const baseDir = resolvePackagePath('Doc_0', '/');
    expect(baseDir).toBe('');
    expect(resolvePackagePath(baseDir, '/Doc_0/Res/2.gif')).toBe('Doc_0/Res/2.gif');
  });

  it('dirnameOf 返回父目录', () => {
    expect(dirnameOf('Doc_0/Pages/Page_0/Content.xml')).toBe('Doc_0/Pages/Page_0');
    expect(dirnameOf('Doc_0/Document.xml')).toBe('Doc_0');
    expect(dirnameOf('OFD.xml')).toBe('');
    expect(dirnameOf('/OFD.xml')).toBe('');
  });

  it('assertSafePackagePath 对安全路径不抛错', () => {
    expect(() => assertSafePackagePath('Doc_0/Res/a.png')).not.toThrow();
    expect(() => assertSafePackagePath('../../x')).toThrow(OFDError);
  });
});