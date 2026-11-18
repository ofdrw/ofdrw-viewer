/**
 * 生成 `ofd_pdf_match/gb-12-media.ofd`：GB/T 33190—2016 视频与音频条款样例。
 *
 * 同一个 OFD 文件包含两页，各放一个可点击播放的媒体图元：
 *
 * - 第 1 页「视频」——第 12 章：
 *   - 视频数据在资源中定义（7.9）：`MultiMedia Type="Video"` 指向 `Res/video.mp4`；
 *   - 通过页面图元触发播放时，选择视频中某一静态帧制作为图像对象，并为其定义边框和
 *     `Movie` 动作：`ImageObject` + `Border` + `Actions/Action Event="CLICK"/Movie`；
 *   - 图元外观区域（`Boundary`）即嵌入式播放窗口；
 *   - 14.6 表 58：省略 `Operator`，放映端按默认值 `Play` 处理。
 * - 第 2 页「音频」——7.9 资源 与 14.5 播放音频动作：
 *   - 音频数据在资源中定义（7.9）：`MultiMedia Type="Audio"` 指向 `Res/audio.mp3`；
 *   - 14.5 表 57：`Sound` 动作播放一段音频，只写出必选的 `ResourceID`，
 *     `Volume`/`Repeat`/`Synchronous` 按默认值处理；
 *   - 音频没有可视内容，用一个 `PathObject` 绘制播放按钮外观并挂 `Sound` 动作。
 *
 * 两页都只用表 52 规定的图元事件 `CLICK`，不设置页面级 `PO` 或文档级 `DO` 动作，
 * 因此打开文档不会自动播放。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildOfdPackage, readPngSize, type MultiMediaSpec, type PageSpec } from './gb-standard-ofd';
import { formatArray, formatNumber, type XmlElement } from './gb-standard-xml';

/** RGB 颜色三元组，取值范围 0~255。 */
type Rgb = [number, number, number];

/** 页面区域，单位 mm。 */
type Box = [number, number, number, number];

/** 视频资源 ID（`ST_RefID`）。 */
const VIDEO_RES_ID = 10;

/** 静态帧图像资源 ID（`ST_RefID`）。 */
const FRAME_RES_ID = 11;

/** 音频资源 ID（`ST_RefID`）。 */
const AUDIO_RES_ID = 12;

/** 字型资源 ID。 */
const FONT_ID = 1;

/** 内嵌字体路径：文泉驿微米黑，覆盖中文与拉丁字形。 */
const FONT_PATH = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc';

/** 字型族名。 */
const FONT_FAMILY = 'WenQuanYi Micro Hei';

/** 页面尺寸，单位 mm（A4 横向）。 */
const PAGE = { width: 297, height: 210 };

/** 标注字号，单位 mm。 */
const LABEL_SIZE = 2.8;

/** 标题字号，单位 mm。 */
const TITLE_SIZE = 4.5;

/** 播放按钮文字字号，单位 mm。 */
const BUTTON_TEXT_SIZE = 5;

/** 深灰色，说明文字。 */
const DARK_GRAY: Rgb = [80, 80, 80];

/** 按钮主色。 */
const BUTTON_BLUE: Rgb = [30, 90, 190];

/** 白色。 */
const WHITE: Rgb = [255, 255, 255];

/** 图元 ID 计数器；先占位再自增。 */
let nextObjectId = 200;

/**
 * 分配新的图元 ID（`ST_ID`，文档内唯一）。
 *
 * @returns 新的图元 ID。
 */
function allocId(): number {
  nextObjectId += 1;
  return nextObjectId;
}

/**
 * 生成纯色颜色节点。
 *
 * @param name 节点名，例如 `ofd:FillColor`。
 * @param color RGB 颜色。
 * @returns 颜色节点。
 */
function colorNode(name: string, color: Rgb): XmlElement {
  return { name, attrs: { Value: formatArray(color) } };
}

/**
 * 生成单段文字对象。
 *
 * @param options 文字参数。
 * @returns `TextObject` 元素描述。
 */
function buildText(options: {
  /** 页面绝对外接矩形 `x y w h`，单位 mm。 */
  box: Box;
  /** 文字内容。 */
  text: string;
  /** 字号，单位 mm。 */
  size: number;
  /** 文字颜色。 */
  color?: Rgb;
  /** 是否加粗（仅改 `Weight`，字型仍为同一内嵌字型）。 */
  bold?: boolean;
}): XmlElement {
  const [x, y, w, h] = options.box;
  const chars = [...options.text];
  const attrs: Record<string, string | number> = {
    ID: allocId(),
    Boundary: formatArray([x, y, w, h]),
    Font: FONT_ID,
    Size: formatNumber(options.size),
    Fill: 'true',
    Stroke: 'false',
  };
  if (options.bold) attrs.Weight = 700;
  const codeAttrs: Record<string, string | number> = {
    X: 0,
    Y: formatNumber(options.size),
  };
  if (chars.length > 1) {
    // 表 46：逐字偏移队列每项是后一个字相对前一个字的位移，长度 = 字符数 - 1。
    codeAttrs.DeltaX = formatArray(Array.from({ length: chars.length - 1 }, () => options.size));
  }
  return {
    name: 'ofd:TextObject',
    attrs,
    children: [
      colorNode('ofd:FillColor', options.color ?? [20, 20, 20]),
      { name: 'ofd:TextCode', attrs: codeAttrs, children: [options.text] },
    ],
  };
}

/**
 * 生成 `Movie` 动作（表 58）。
 *
 * @param resourceId 视频资源 ID。
 * @returns `Action` 元素描述；`Operator` 省略，放映端按默认值 `Play` 处理。
 */
function buildMovieAction(resourceId: number): XmlElement {
  return {
    name: 'ofd:Action',
    // 表 34：图元动作事件类型应为 CLICK；不写 Region 时以所在图元外接矩形为启动区域。
    attrs: { Event: 'CLICK' },
    children: [{ name: 'ofd:Movie', attrs: { ResourceID: resourceId } }],
  };
}

/**
 * 生成 `Sound` 动作（表 57）。
 *
 * @param resourceId 音频资源 ID。
 * @returns `Action` 元素描述；`Volume`/`Repeat`/`Synchronous` 省略，按表 57 默认值处理。
 */
function buildSoundAction(resourceId: number): XmlElement {
  return {
    name: 'ofd:Action',
    // 表 34：图元动作事件类型应为 CLICK；不写 Region 时以所在图元外接矩形为启动区域。
    attrs: { Event: 'CLICK' },
    children: [{ name: 'ofd:Sound', attrs: { ResourceID: resourceId } }],
  };
}

/**
 * 生成视频图元：静态帧图像 + 边框 + CLICK 事件触发的 `Movie` 动作（第 12 章、表 43）。
 *
 * @param options 图元参数。
 * @returns `ImageObject` 元素描述。
 */
function buildVideoObject(options: {
  /** 页面绝对外接矩形，单位 mm；同时作为嵌入式播放窗口。 */
  box: Box;
  /** 静态帧资源 ID。 */
  frameResId: number;
  /** 视频资源 ID。 */
  videoResId: number;
}): XmlElement {
  const [x, y, w, h] = options.box;
  return {
    name: 'ofd:ImageObject',
    attrs: {
      ID: allocId(),
      Boundary: formatArray([x, y, w, h]),
      // 图像在对象空间以单位正方形描述，CTM 把单位正方形放大到 Boundary 尺寸。
      // 缺 CTM 时渲染端按单位矩阵处理，图像会缩成一个点。
      CTM: formatArray([w, 0, 0, h, 0, 0]),
      ResourceID: options.frameResId,
      Name: '视频播放图元',
    },
    children: [
      {
        name: 'ofd:Border',
        attrs: { LineWidth: 0.6, HorizontalCornerRadius: 2, VerticalCornerRadius: 2 },
        children: [colorNode('ofd:BorderColor', [30, 30, 30])],
      },
      { name: 'ofd:Actions', children: [buildMovieAction(options.videoResId)] },
    ],
  };
}

/**
 * 生成音频播放按钮图元：蓝色矩形，并挂 `Sound` 动作。
 *
 * @param options 按钮参数。
 * @returns `PathObject` 元素描述。
 */
function buildAudioButton(options: {
  /** 页面绝对外接矩形，单位 mm。 */
  box: Box;
  /** 音频资源 ID。 */
  audioResId: number;
}): XmlElement {
  const [x, y, w, h] = options.box;
  return {
    name: 'ofd:PathObject',
    attrs: {
      ID: allocId(),
      Boundary: formatArray([x, y, w, h]),
      Fill: 'true',
      Stroke: 'false',
      Name: '音频播放按钮',
    },
    children: [
      colorNode('ofd:FillColor', BUTTON_BLUE),
      {
        name: 'ofd:AbbreviatedData',
        children: [`M 0 0 L ${formatNumber(w)} 0 L ${formatNumber(w)} ${formatNumber(h)} L 0 ${formatNumber(h)} C`],
      },
      // 表 34：图元动作事件类型应为 CLICK。
      { name: 'ofd:Actions', children: [buildSoundAction(options.audioResId)] },
    ],
  };
}

/**
 * 生成第 1 页：视频。
 *
 * @param frameAspect 静态帧的高宽比。
 * @returns 层内容元素。
 */
function buildVideoPage(frameAspect: number): XmlElement[] {
  const margin = 8;
  const layer: XmlElement[] = [];

  layer.push(
    buildText({
      box: [margin, margin, 220, TITLE_SIZE * 1.4],
      text: 'GB/T 33190—2016 第 12 章 视频',
      size: TITLE_SIZE,
    }),
  );
  // 播放窗口按视频宽高比取尺寸，避免静态帧被拉伸变形。
  const videoW = 160;
  const videoH = videoW * frameAspect;
  const videoX = (PAGE.width - videoW) / 2;
  const videoY = margin + 26;

  layer.push(
    buildVideoObject({
      box: [videoX, videoY, videoW, videoH],
      frameResId: FRAME_RES_ID,
      videoResId: VIDEO_RES_ID,
    }),
  );

  layer.push(
    buildText({
      box: [videoX, videoY + videoH + 4, videoW, 4],
      text: '▶ 点击画面播放',
      size: LABEL_SIZE,
      color: DARK_GRAY,
    }),
  );

  return layer;
}

/**
 * 生成第 2 页：音频。
 *
 * @returns 层内容元素。
 */
function buildAudioPage(): XmlElement[] {
  const margin = 8;
  const layer: XmlElement[] = [];

  layer.push(
    buildText({
      box: [margin, margin, 220, TITLE_SIZE * 1.4],
      text: 'GB/T 33190—2016 音频',
      size: TITLE_SIZE,
    }),
  );
  // 播放按钮：居中摆放。
  const buttonW = 90;
  const buttonH = 22;
  const buttonX = (PAGE.width - buttonW) / 2;
  const buttonY = margin + 26;

  layer.push(
    buildAudioButton({
      box: [buttonX, buttonY, buttonW, buttonH],
      audioResId: AUDIO_RES_ID,
    }),
  );

  // 按钮内的白色播放三角（对象空间相对按钮左上角）。
  const iconW = 7;
  const iconH = 8;
  const iconX = 18;
  const iconY = (buttonH - iconH) / 2;
  layer.push({
    name: 'ofd:PathObject',
    attrs: {
      ID: allocId(),
      Boundary: formatArray([buttonX + iconX, buttonY + iconY, iconW, iconH]),
      Fill: 'true',
      Stroke: 'false',
    },
    children: [
      colorNode('ofd:FillColor', WHITE),
      {
        name: 'ofd:AbbreviatedData',
        children: [`M 0 0 L ${formatNumber(iconW)} ${formatNumber(iconH / 2)} L 0 ${formatNumber(iconH)} C`],
      },
    ],
  });

  // 按钮文字。
  layer.push(
    buildText({
      box: [buttonX + iconX + iconW + 4, buttonY + (buttonH - BUTTON_TEXT_SIZE) / 2, buttonW, BUTTON_TEXT_SIZE],
      text: '播放音频',
      size: BUTTON_TEXT_SIZE,
      color: WHITE,
      bold: true,
    }),
  );

  // 按钮下方的简短说明。
  layer.push(
    buildText({
      box: [buttonX, buttonY + buttonH + 5, buttonW, 4],
      text: 'MP3｜44.1 kHz｜双声道',
      size: LABEL_SIZE,
      color: DARK_GRAY,
    }),
  );

  return layer;
}

/**
 * 生成 `gb-12-media.ofd`。
 *
 * @param outputPath 输出路径。
 * @param videoPath 视频文件路径（MP4）；静态帧取其同目录下的 `frame.png`。
 * @param audioPath 音频文件路径（MP3）。
 * @returns 写入的字节数。
 */
export function writeMediaSample(outputPath: string, videoPath: string, audioPath: string): number {
  nextObjectId = 200;
  const fontData = new Uint8Array(readFileSync(FONT_PATH));
  const videoData = new Uint8Array(readFileSync(videoPath));
  const frameData = new Uint8Array(readFileSync(`${dirname(videoPath)}/frame.png`));
  const audioData = new Uint8Array(readFileSync(audioPath));
  const frameSize = readPngSize(frameData);

  const multiMedias: MultiMediaSpec[] = [
    { id: VIDEO_RES_ID, type: 'Video', format: 'MP4', fileName: 'video.mp4', data: videoData },
    { id: FRAME_RES_ID, type: 'Image', format: 'PNG', fileName: 'frame.png', data: frameData },
    { id: AUDIO_RES_ID, type: 'Audio', format: 'MP3', fileName: 'audio.mp3', data: audioData },
  ];

  const pages: PageSpec[] = [
    { layers: [{ id: 1, children: buildVideoPage(frameSize.height / frameSize.width) }] },
    { layers: [{ id: 1, children: buildAudioPage() }] },
  ];

  const bytes = buildOfdPackage({
    docId: '1b7c9d3e4f20615a8b2c3d4e5f60718a',
    title: 'GB/T 33190-2016 视频与音频条款样例',
    page: PAGE,
    font: { id: FONT_ID, familyName: FONT_FAMILY, fileName: 'font.ttf', data: fontData },
    multiMedias,
    pages,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes);
  return bytes.length;
}