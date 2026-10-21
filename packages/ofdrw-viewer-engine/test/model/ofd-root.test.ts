import { describe, expect, it } from 'vitest';
import { decodeOfdRoot } from '../../src/model/decode';
import { leaf, node } from './xml';

describe('decodeOfdRoot', () => {
  it('解析版本与多个 DocBody/DocRoot', () => {
    const root = node('OFD', { Version: '1.1' }, [
      node('DocBody', {}, [leaf('DocRoot', 'Doc_0')]),
      node('DocBody', {}, [leaf('DocRoot', '/Doc_1/')]),
    ]);
    const info = decodeOfdRoot(root);
    expect(info.version).toBe('1.1');
    expect(info.docRoots).toEqual(['Doc_0', 'Doc_1']);
    expect(info.docRootIndex).toBe(0);
  });

  it('兼容根节点直接放 DocRoot，并拒绝 .. 路径', () => {
    const root = node('OFD', {}, [leaf('DocRoot', '../Doc_0'), leaf('DocRoot', 'Doc_2')]);
    const info = decodeOfdRoot(root);
    expect(info.docRoots).toEqual(['Doc_2']);
    expect(info.version).toBe('1.0');
  });
});