import { describe, expect, it } from 'vitest';
import { decodeOfdRoot } from '../../src/model/decode';
import type { OFDWarning } from '../../src/warnings';
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

  it('OFD@DocType 取值；缺失或空白时省略该键', () => {
    expect(decodeOfdRoot(node('OFD', { DocType: 'Render' })).docType).toBe('Render');
    const blanks: Array<Record<string, string>> = [{}, { DocType: '' }, { DocType: '   ' }];
    for (const attrs of blanks) {
      expect(decodeOfdRoot(node('OFD', attrs))).not.toHaveProperty('docType');
    }
  });

  it('maxUnitIds 与 docRoots 下标对齐，docBodyCount 统计全部 DocBody 节点', () => {
    const root = node('OFD', { DocType: 'OFD' }, [
      node('DocBody', { MaxUnitID: '512' }, [leaf('DocRoot', 'Doc_0')]),
      // 无 DocRoot：计入 docBodyCount，但不进入 docRoots/maxUnitIds。
      node('DocBody', { MaxUnitID: '9' }, []),
      node('DocBody', {}, [leaf('DocRoot', 'Doc_1')]),
      node('DocBody', { MaxUnitID: '7' }, [leaf('DocRoot', '../bad')]),
    ]);
    const info = decodeOfdRoot(root);
    expect(info.docRoots).toEqual(['Doc_0', 'Doc_1']);
    expect(info.maxUnitIds).toEqual([512, undefined]);
    expect(info.maxUnitIds).toHaveLength(info.docRoots.length);
    expect(info.docBodyCount).toBe(4);
  });

  it('DocBody@MaxUnitID 非法时省略并上报 W_METADATA_FIELD', () => {
    const warnings: OFDWarning[] = [];
    const root = node('OFD', {}, [
      node('DocBody', { MaxUnitID: 'abc' }, [leaf('DocRoot', 'Doc_0')]),
      node('DocBody', { MaxUnitID: '-3' }, [leaf('DocRoot', 'Doc_1')]),
      node('DocBody', { MaxUnitID: '1.5' }, [leaf('DocRoot', 'Doc_2')]),
    ]);
    const info = decodeOfdRoot(root, { onWarning: (warning) => warnings.push(warning) });
    expect(info.maxUnitIds).toEqual([undefined, undefined, undefined]);
    expect(warnings.filter((warning) => warning.code === 'W_METADATA_FIELD')).toHaveLength(3);
  });

  it('无 DocBody 时 docBodyCount 为 0，根节点直挂 DocRoot 不计入', () => {
    const info = decodeOfdRoot(node('OFD', {}, [leaf('DocRoot', 'Doc_0')]));
    expect(info.docBodyCount).toBe(0);
    expect(info.docRoots).toEqual(['Doc_0']);
    expect(info.maxUnitIds).toEqual([]);
  });
});