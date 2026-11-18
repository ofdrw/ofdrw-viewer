import { describe, expect, it, vi } from 'vitest';
import { decodePageResources } from '../../src/model/decode';
import { leaf, node } from './xml';

describe('MediaResource 的 scope/declaredIn 标注', () => {
  it('按资源文件名区分 public/document/page', () => {
    const root = node('Res', {}, [
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '1', Type: 'Video' }, [leaf('MediaFile', 'a.mp4')]),
        node('MultiMedia', { ID: '2', Type: 'Audio' }, [leaf('MediaFile', 'b.mp3')]),
        node('MultiMedia', { ID: '3', Type: 'Audio' }, [leaf('MediaFile', 'c.wav')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Doc_0/PageRes.xml');
    expect(set.media.map((item) => `${item.scope}:${item.declaredIn}`)).toEqual([
      'page:Doc_0/PageRes.xml',
      'page:Doc_0/PageRes.xml',
      'page:Doc_0/PageRes.xml',
    ]);
    const documentSet = decodePageResources(root, 'Doc_0/DocumentRes.xml');
    expect(documentSet.media.every((item) => item.scope === 'document')).toBe(true);
    const publicSet = decodePageResources(root, 'Doc_0/PublicRes.xml');
    expect(publicSet.media.every((item) => item.scope === 'public')).toBe(true);
  });

  it('scope 写入 ResourceIndex 并在 createPageScope 合并后保留最新层', () => {
    const onWarning = vi.fn();
    const root = node('Res', {}, [
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '1', Type: 'Audio' }, [leaf('MediaFile', 'b.mp3')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Doc_0/PageRes.xml', { onWarning });
    expect(set.media[0]?.kind).toBe('audio');
    expect(onWarning).not.toHaveBeenCalled();
  });
});