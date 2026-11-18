import { describe, expect, it, vi } from 'vitest';
import { decodePageResources } from '../../src/model/decode';
import type { OFDWarning } from '../../src/warnings';
import { leaf, node } from './xml';

/** 收集 warning 码。 */
function codes(onWarning: ReturnType<typeof vi.fn>): string[] {
  return onWarning.mock.calls.map((call) => (call[0] as OFDWarning).code);
}

describe('MultiMedias 按 Type 分派', () => {
  it('Image 进 images、Audio/Video 进 media，且不产生 warning', () => {
    const onWarning = vi.fn();
    const root = node('Res', { BaseLoc: 'Res' }, [
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '10', Type: 'Video', Format: 'MP4' }, [leaf('MediaFile', 'video.mp4')]),
        node('MultiMedia', { ID: '11', Type: 'Image', Format: 'PNG' }, [leaf('MediaFile', 'frame.png')]),
        node('MultiMedia', { ID: '12', Type: 'Audio', Format: 'MP3' }, [leaf('MediaFile', 'audio.mp3')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Doc_0/PageRes.xml', { onWarning });
    expect(set.images.map((image) => image.id)).toEqual(['11']);
    expect(set.media.map((media) => media.id)).toEqual(['10', '12']);
    expect(set.media[0]).toEqual({
      id: '10',
      kind: 'video',
      mediaFile: 'Doc_0/Res/video.mp4',
      mimeType: 'video/mp4',
      format: 'MP4',
      scope: 'page',
      declaredIn: 'Doc_0/PageRes.xml',
    });
    expect(set.media[1]?.kind).toBe('audio');
    expect(set.media[1]?.mimeType).toBe('audio/mpeg');
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('既有口径：Type=Audio 的条目不在 images、无 warning', () => {
    const onWarning = vi.fn();
    const root = node('Res', {}, [
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '3', Type: 'Audio' }, [leaf('MediaFile', 'a.mp3')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Doc_0/PageRes.xml', { onWarning });
    expect(set.images).toHaveLength(0);
    expect(set.media.map((media) => media.id)).toEqual(['3']);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('Type 大小写不敏感，缺 Type 按 Image 处理并报 W_MEDIA_FORMAT', () => {
    const onWarning = vi.fn();
    const root = node('Res', {}, [
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '1', Type: 'VIDEO' }, [leaf('MediaFile', 'v.mp4')]),
        node('MultiMedia', { ID: '2' }, [leaf('MediaFile', 'a.png')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Res.xml', { onWarning });
    expect(set.media.map((media) => media.id)).toEqual(['1']);
    expect(set.images.map((image) => image.id)).toEqual(['2']);
    expect(codes(onWarning)).toEqual(['W_MEDIA_FORMAT']);
  });

  it('Type 非法时跳过该条并报 W_MEDIA_FORMAT', () => {
    const onWarning = vi.fn();
    const root = node('Res', {}, [
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '1', Type: 'Flash' }, [leaf('MediaFile', 'a.swf')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Res.xml', { onWarning });
    expect(set.images).toHaveLength(0);
    expect(set.media).toHaveLength(0);
    expect(codes(onWarning)).toEqual(['W_MEDIA_FORMAT']);
  });

  it('缺 MediaFile 或路径非法时跳过并报 W_MEDIA_RESOURCE', () => {
    const onWarning = vi.fn();
    const root = node('Res', { BaseLoc: 'Res' }, [
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '1', Type: 'Video' }, []),
        node('MultiMedia', { ID: '2', Type: 'Audio' }, [leaf('MediaFile', '../../../../escape.mp3')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Doc_0/PageRes.xml', { onWarning });
    expect(set.media).toHaveLength(0);
    expect(codes(onWarning).filter((code) => code === 'W_MEDIA_RESOURCE')).toHaveLength(2);
  });

  it('扩展名优先，Format 为 MIME 时兜底，无法判定报 W_MEDIA_FORMAT', () => {
    const onWarning = vi.fn();
    const root = node('Res', {}, [
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '1', Type: 'Video', Format: 'MP4' }, [leaf('MediaFile', 'a.webm')]),
        node('MultiMedia', { ID: '2', Type: 'Audio', Format: 'audio/x-custom' }, [leaf('MediaFile', 'a.dat')]),
        node('MultiMedia', { ID: '3', Type: 'Audio' }, [leaf('MediaFile', 'a')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Res.xml', { onWarning });
    expect(set.media.map((media) => media.mimeType)).toEqual([
      'video/webm',
      'audio/x-custom',
      'application/octet-stream',
    ]);
    expect(codes(onWarning)).toEqual(['W_MEDIA_FORMAT']);
  });

  it('同作用域内音视频 ID 重复时保留先出现者并报 W_DUPLICATE_RESOURCE', () => {
    const onWarning = vi.fn();
    const root = node('Res', {}, [
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '1', Type: 'Audio' }, [leaf('MediaFile', 'first.mp3')]),
        node('MultiMedia', { ID: '#1', Type: 'Audio' }, [leaf('MediaFile', 'second.mp3')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Res.xml', { onWarning });
    expect(set.media).toHaveLength(1);
    expect(set.media[0]?.mediaFile).toBe('first.mp3');
    expect(codes(onWarning)).toEqual(['W_DUPLICATE_RESOURCE']);
  });
});