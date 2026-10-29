/**
 * 选区文本抽取缺陷回归用例（D3~D5）与 D1/D2 行为保持。
 *
 * 依据设计文档 `docs/选区高亮块状渲染设计.md` §6.1 缺陷表与 §6.7 目标行为。修复后
 * 抽取路径为：`buildSelectionModel()` 逐字符用 `Range.comparePoint()` 求真实区间，
 * 用 `(itemIndex, charIndex)` 反查 `TextRow.id`，按 rowId 差异插入换行，不使用任何
 * 字号/距离阈值。
 *
 * 缺陷认定（经 t1 诊断与设计文档修订）：
 * - D3、D4、D5 是可翻转缺陷：紧排行距丢换行、混排字号被并为一行、行判定阈值不一致；
 * - D1、D2 不是缺陷：斜向拖选中间行整段计入与同字号基线差 10px 判两行，均与
 *   `buildTextRows()` 的行划分一致，本文件锁定其既定行为，修复后必须保持。
 *
 * 观测口径（单位均为 96 DPI CSS px）：
 * - 文本层 span 的 `data-y` 是**文本框上边**，等于 `baseline - fontSize`；
 * - `buildTextRows()` 的行带归并阈值为 `0.5 × max(span 高度)`，且以行带首个 span 为锚。
 *
 * 夹具沿用 `helpers.ts` 的 `makeItem / makeContent / makeFakeHost / makePageView`；
 * 文本层 span 由 `buildTextLayerSpecs()` + `createTextSpan()` 渲染，字符几何与行归属
 * 由 `makeTextLayerQuery()` 提供（与 `TextLayerService` 共用行划分与查表实现）。
 */

import { replaceChildren } from '../../../src/compat';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TextContent } from '@ofdrw/ofdrw-viewer-engine';
import { buildTextLayerSpecs, buildTextRows } from '../../../src/text/geometry';
import { createTextSpan } from '../../../src/text/text-layer';
import { SelectionManager } from '../../../src/text/selection';
import { createViewerBridge } from '../../../src/text/viewer-bridge';
import { makeContent, makeFakeHost, makeItem, makePageView, makeTextLayerQuery } from './helpers';

type FakeHost = ReturnType<typeof makeFakeHost>;

/** 建立单页夹具：页视图挂到 body 内的根节点上。 */
function setup(): FakeHost {
  const view = makePageView(1);
  const root = document.createElement('div');
  root.className = 'ofd-viewer';
  document.body.appendChild(root);
  root.appendChild(view.element);
  return makeFakeHost({
    pageCount: 1,
    contents: new Map([[1, makeContent([])]]),
    pageViews: new Map([[1, view]]),
    root,
  });
}

/** 把文本内容渲染为页文本层 span（与生产路径一致）。 */
function renderPage(host: FakeHost, content: TextContent): void {
  const view = host.getPageView(1)!;
  const { spans } = buildTextLayerSpecs(content);
  const fragment = document.createDocumentFragment();
  for (const spec of spans) {
    fragment.appendChild(createTextSpan(document, spec, 1, true));
  }
  replaceChildren(view.textLayer, fragment);
}

/** 创建选区管理器；字符几何与行归属由给定内容查表得到。 */
function makeManager(host: FakeHost, content: TextContent): SelectionManager {
  return new SelectionManager(
    host,
    createViewerBridge(host),
    makeTextLayerQuery(new Map([[1, content]])),
  );
}

/** 读取页内全部文本层 span 的文本节点，顺序与 DOM 顺序一致。 */
function textNodesOf(host: FakeHost): Text[] {
  return [
    ...host
      .getPageView(1)!
      .textLayer.querySelectorAll<HTMLElement>('.ofd-text-item, .ofd-text-char'),
  ].map((span) => span.firstChild as Text);
}

/** 读取页内全部文本层 span 的 `data-y`（文本框上边，单位 px）。 */
function topsOf(host: FakeHost): number[] {
  return [
    ...host
      .getPageView(1)!
      .textLayer.querySelectorAll<HTMLElement>('.ofd-text-item, .ofd-text-char'),
  ].map((span) => Number(span.dataset.y));
}

/** 建立原生选区。 */
function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  selection.addRange(range);
}

describe('选区文本抽取缺陷回归（D3~D5）与 D1/D2 行为保持', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getSelection()?.removeAllRanges();
  });

  it('D1：斜向拖选时首尾行只计入真实选中部分，行序与阅读顺序一致', () => {
    // 斜向拖选：起点位于第 1 行「中间 span」（乙乙）内部偏移 1，终点位于第 3 行偏移 2。
    // 第 1 行 3 个 item span，第 2、3 行各 1 个 item span；行间距 30px。
    //
    // 修复后行为：
    // - 起点所在 span 只计入起点之后的字符「乙」；
    // - 第 2 行是完整落在选区内的非端点节点，整行 4 个字符全部计入（语义正确）；
    // - 终点所在 span 只计入终点之前的字符「戊戊」；
    // - 片段按 (页码, 行法向序号, 行内 flow 位置) 排序，与视觉阅读顺序一致。
    const host = setup();
    const content = makeContent([
      makeItem({ text: '甲甲', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: '乙乙', x: 50, y: 100, size: 16, order: 1 }),
      makeItem({ text: '丙丙', x: 90, y: 100, size: 16, order: 2 }),
      makeItem({ text: '丁丁丁丁', x: 10, y: 130, size: 16, order: 3 }),
      makeItem({ text: '戊戊戊戊', x: 10, y: 160, size: 16, order: 4 }),
    ]);
    renderPage(host, content);
    const nodes = textNodesOf(host);
    select(nodes[1]!, 1, nodes[4]!, 2);
    const manager = makeManager(host, content);
    const model = manager.buildSelectionModel(document.getSelection()!.getRangeAt(0));
    expect(model.mode).toBe('vector');
    const selected = manager.getSelectedText();

    // 第 1 行从中间 span 的偏移 1 起算：「乙」+「丙丙」，中文不插空格。
    expect(selected).toBe('乙丙丙\n丁丁丁丁\n戊戊');
    // 完整落在选区内的第 2 行整段计入。
    expect(selected.split('\n')[1]).toBe('丁丁丁丁');
    manager.destroy();
  });

  it('D2：同行片段按 TextRow 查表，抽取结论与行划分一致', () => {
    // 两个 item 的 data-y 相差 10px（字号 16px）。旧逻辑阈值 = 0.6 × 16 = 9.6px
    // > … 10px，插入换行；但文本层行划分阈值 = 0.5 × 16 = 8px，10px 同样超出，
    // 因此该几何在 `buildTextRows()` 中确为两行——按设计 §6.2「同一 TextRow 即同一行」
    // 的权威口径，抽取结果必须与行划分一致（换行），此处不能再按旧阈值“判同一行”。
    // 该用例由此验证 D5 的行判定一致性，而不是 D2 旧阈值的可复现场景。
    const host = setup();
    const content = makeContent([
      makeItem({ text: '一二', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: '三四', x: 50, y: 110, size: 16, order: 1 }),
    ]);
    renderPage(host, content);
    const nodes = textNodesOf(host);
    select(nodes[0]!, 0, nodes[1]!, 2);
    const manager = makeManager(host, content);

    // 基线数据：data-y 相差 10px；行划分判定为 2 行（0.5 × 16 = 8px 阈值）。
    const tops = topsOf(host);
    expect(tops[1]! - tops[0]!).toBe(10);
    expect(buildTextRows(content).rows.length).toBe(2);

    // 抽取与行划分一致：换行数与行数一致。
    const selected = manager.getSelectedText();
    expect(selected).toBe('一二\n三四');
    expect(selected.split('\n')).toHaveLength(2);
    manager.destroy();
  });

  it('D3：行距 9px 时按 TextRow 保留换行，不黏连', () => {
    // 紧排行距：两行基线仅差 9px（小于字号 16px），但文本层行划分认为是两行。
    // 修复后行归属查表与行划分一致，换行恢复。
    const host = setup();
    const content = makeContent([
      makeItem({ text: '一二', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: '三四', x: 10, y: 109, size: 16, order: 1 }),
    ]);
    renderPage(host, content);
    const nodes = textNodesOf(host);
    select(nodes[0]!, 0, nodes[1]!, 2);
    const manager = makeManager(host, content);

    const tops = topsOf(host);
    expect(tops[1]! - tops[0]!).toBe(9);
    expect(buildTextRows(content).rows.length).toBe(2);

    expect(manager.getSelectedText()).toBe('一二\n三四');
    manager.destroy();
  });

  it('D4：32px 标题紧邻 10px 正文时按 TextRow 分行', () => {
    // 混排字号 + 紧邻两行：10px 正文行（基线 72，文本框 62..72）与 32px 标题行
    // （基线 112，文本框 80..112），两行文本框间距 8px，视觉上是清晰的两行。
    // 旧逻辑阈值 = 0.6 × max(10, 32) = 19.2px ≥ 18px，误并为一行；修复后按行查表。
    const host = setup();
    const content = makeContent([
      makeItem({ text: '正文', x: 10, y: 72, size: 10, order: 0 }),
      makeItem({ text: '标题', x: 10, y: 112, size: 32, order: 1 }),
    ]);
    renderPage(host, content);
    const nodes = textNodesOf(host);
    select(nodes[0]!, 0, nodes[1]!, 2);
    const manager = makeManager(host, content);

    const tops = topsOf(host);
    expect(tops[1]! - tops[0]!).toBe(18);
    expect(buildTextRows(content).rows.length).toBe(2);

    expect(manager.getSelectedText()).toBe('正文\n标题');
    manager.destroy();
  });

  it('D4 补充：文档字面场景（标题在上、基线差 12px）仍分行', () => {
    // 设计文档 D4 写的是「32px 标题紧邻 10px 正文、行距 12px」。32px 标题（基线 100，
    // 文本框 68..100）在上、10px 正文（基线 112，文本框 102..112）在下，data-y 之差
    // = 34px。修复后行划分与抽取一致，输出「标题\n正文」。
    const host = setup();
    const content = makeContent([
      makeItem({ text: '标题', x: 10, y: 100, size: 32, order: 0 }),
      makeItem({ text: '正文', x: 10, y: 112, size: 10, order: 1 }),
    ]);
    renderPage(host, content);
    const nodes = textNodesOf(host);
    select(nodes[0]!, 0, nodes[1]!, 2);
    const manager = makeManager(host, content);

    const tops = topsOf(host);
    expect(tops[1]! - tops[0]!).toBe(34);
    expect(manager.getSelectedText()).toBe('标题\n正文');
    manager.destroy();
  });

  it('D5：抽取的换行与 buildTextRows 行划分一致', () => {
    // 同一份内容（字号 20px、相邻片段 data-y 相差 11px）：
    // - 文本层行划分 `buildTextRows()`：阈值 0.5 × 20 = 10px < 11px → 2 行；
    // - 旧抽取逻辑阈值 0.6 × 20 = 12px ≥ 11px → 同一行，两者结论不一致。
    // 修复后抽取按 rowId 查表，结果为 2 行，与行划分一致。
    const host = setup();
    const content = makeContent([
      makeItem({ text: '一二三', x: 10, y: 100, size: 20, order: 0 }),
      makeItem({ text: '四五六', x: 10, y: 111, size: 20, order: 1 }),
    ]);
    renderPage(host, content);
    const nodes = textNodesOf(host);
    select(nodes[0]!, 0, nodes[1]!, 3);
    const manager = makeManager(host, content);
    const selected = manager.getSelectedText();

    const layout = buildTextRows(content);
    expect(layout.rows.length).toBe(2);
    const tops = topsOf(host);
    expect(tops[1]! - tops[0]!).toBe(11);

    // 抽取结论与行划分一致：插入 1 个换行。
    expect(selected).toBe('一二三\n四五六');
    expect(selected.split('\n')).toHaveLength(2);
    manager.destroy();
  });
});