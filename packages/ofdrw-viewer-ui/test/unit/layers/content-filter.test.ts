/**
 * 图层可见性模型测试（设计方案 §H.1）。
 *
 * 覆盖六项键顺序、布尔 ↔ `PageContentFilter` 映射、与引擎规范化签名的逐一对拍、
 * 每页覆盖表语义与 `layerPanel` 配置解析。签名对拍直接读取引擎源码中的
 * `resolveContentFilter()`：引擎包入口未导出该函数，这里是唯一的允许依赖点。
 */

import { describe, expect, it } from 'vitest';
import type { PageContentFilter } from '@ofdrw/ofdrw-viewer-engine';
import { resolveContentFilter } from '../../../../ofdrw-viewer-engine/src/render/content-filter';
import {
  ALL_LAYERS_KEY,
  annotationTypeProbeCandidates,
  annotationTypesForGroup,
  PageLayerOverrides,
  PAGE_LAYER_KEYS,
  contentFilterKey,
  createDefaultVisibility,
  layerSignature,
  normalizeLayerVisibility,
  resolveLayerPanelOptions,
  selectedAnnotationTypes,
  toPageContentFilter,
  type LayerKey,
  type LayerVisibility,
} from '../../../src/layers/content-filter';

/** 六项全 true 的可见性。 */
const ALL = createDefaultVisibility();

/** 六项全 false 的可见性。 */
const NONE: Readonly<Record<LayerKey, boolean>> = {
  signatures: false,
  annotations: false,
  custom: false,
  foreground: false,
  body: false,
  background: false,
};

/** 六项全部组合（64 种），用于与引擎签名对拍。 */
function allCombinations(): Readonly<Record<LayerKey, boolean>>[] {
  const result: Record<LayerKey, boolean>[] = [];
  for (let mask = 0; mask < 1 << PAGE_LAYER_KEYS.length; mask += 1) {
    const visibility = {} as Record<LayerKey, boolean>;
    PAGE_LAYER_KEYS.forEach((key, index) => {
      visibility[key] = (mask & (1 << index)) === 0;
    });
    result.push(visibility);
  }
  return result;
}

describe('PAGE_LAYER_KEYS', () => {
  it('顺序为签章→注释→自定义→前景→正文→背景', () => {
    expect([...PAGE_LAYER_KEYS]).toEqual([
      'signatures',
      'annotations',
      'custom',
      'foreground',
      'body',
      'background',
    ]);
  });
});

describe('toPageContentFilter / contentFilterKey', () => {
  it('六项全 true 表示全画：不传过滤，签名为 all', () => {
    expect(toPageContentFilter(ALL)).toBeUndefined();
    expect(contentFilterKey(ALL)).toBe(ALL_LAYERS_KEY);
    // 缺失键按 true 处理。
    expect(toPageContentFilter({})).toBeUndefined();
    expect(contentFilterKey({})).toBe('all');
  });

  it('关闭背景只影响 background 层，其余层仍可见', () => {
    const filter = toPageContentFilter({ background: false });
    expect(filter).toStrictEqual({
      layers: {
        background: { page: false, templates: false },
        body: { page: true, templates: true },
        foreground: { page: true, templates: true },
        custom: { page: true, templates: false },
      },
      annotations: true,
      signatures: true,
    });
  });

  it('六项全 false 时返回完整白名单，签名为 none', () => {
    const filter = toPageContentFilter(NONE);
    expect(filter).toStrictEqual({
      layers: {
        background: { page: false, templates: false },
        body: { page: false, templates: false },
        foreground: { page: false, templates: false },
        custom: { page: false, templates: false },
      },
      annotations: false,
      signatures: false,
    });
    expect(contentFilterKey(NONE)).toBe('none');
  });

  it('custom 层的 templates 恒为 0', () => {
    expect(contentFilterKey({ custom: false })).toContain('c:00');
    expect(contentFilterKey({ custom: true, body: false })).toContain('c:10');
  });

  it('与引擎 resolveContentFilter().key 逐一对拍（64 种组合 × 注释开/关）', () => {
    const types = ['Link', 'Path', 'Highlight', 'Stamp', 'Watermark'];
    for (const visibility of allCombinations()) {
      for (const annotations of [true, false]) {
        const target: LayerVisibility = { ...visibility, annotations };
        const filter: PageContentFilter | undefined = toPageContentFilter(target, types);
        expect(resolveContentFilter(filter).key).toBe(contentFilterKey(target, types));
      }
    }
  });

  it('归一化只接受布尔值，非法值按 true', () => {
    const normalized = normalizeLayerVisibility({
      body: false,
      // 运行时非法输入：非布尔值按可见处理。
      background: 'no' as unknown as boolean,
      unknown: false,
    } as LayerVisibility);
    expect(normalized.body).toBe(false);
    expect(normalized.background).toBe(true);
    expect(Object.keys(normalized).sort()).toEqual([...PAGE_LAYER_KEYS].sort());
  });

  it('layerSignature 按页转发签名', () => {
    // 参数名与函数同名，调用的是参数本身而非本函数。
    const keyOf = (index: number): string => `page-${index}`;
    expect(layerSignature(keyOf, 7)).toBe('page-7');
  });
});

describe('PageLayerOverrides', () => {
  it('默认值下 filterAt 为 undefined、keyAt 为 all', () => {
    const overrides = new PageLayerOverrides();
    expect(overrides.defaultKey).toBe('all');
    expect(overrides.filterAt(0)).toBeUndefined();
    expect(overrides.keyAt(3)).toBe('all');
    expect(overrides.indices()).toEqual([]);
  });

  it('自定义默认值成为未覆盖页的共同签名', () => {
    const overrides = new PageLayerOverrides({ background: false });
    expect(overrides.defaultKey).toBe(contentFilterKey({ background: false }));
    expect(overrides.keyAt(2)).toBe(overrides.defaultKey);
    expect(overrides.filterAt(2)).toStrictEqual(toPageContentFilter({ background: false }));
  });

  it('set 只报告签名变化，改回默认值的页被删除', () => {
    const overrides = new PageLayerOverrides();
    expect(overrides.set(2, { body: false })).toBe(true);
    expect(overrides.indices()).toEqual([2]);
    // 重复写入相同值：签名未变。
    expect(overrides.set(2, { body: false })).toBe(false);
    expect(overrides.set(2, { body: true })).toBe(true);
    expect(overrides.indices()).toEqual([]);
    expect(overrides.keyAt(2)).toBe('all');
  });

  it('setDefaults 删除与默认值一致的覆盖页，其余页保留差异', () => {
    const overrides = new PageLayerOverrides();
    overrides.set(1, { body: false });
    overrides.set(2, { background: false });
    expect(overrides.setDefaults({ body: false })).toBe(true);
    expect(overrides.indices()).toEqual([2]);
    expect(overrides.visibilityAt(2).body).toBe(true);
    expect(overrides.visibilityAt(2).background).toBe(false);
    // 相同默认值不产生变化。
    expect(overrides.setDefaults({ body: false })).toBe(false);
  });

  it('indicesWhereKeyDiffers 只返回签名不同的覆盖页', () => {
    const overrides = new PageLayerOverrides();
    overrides.set(0, NONE);
    overrides.set(1, { body: false });
    expect(overrides.indicesWhereKeyDiffers('all')).toEqual([0, 1]);
    expect(overrides.indicesWhereKeyDiffers(contentFilterKey(NONE))).toEqual([1]);
  });

  it('delete / clear 报告变化', () => {
    const overrides = new PageLayerOverrides();
    expect(overrides.clear()).toBe(false);
    overrides.set(0, { annotations: false });
    expect(overrides.delete(0)).toBe(true);
    expect(overrides.delete(0)).toBe(false);
    overrides.set(0, { annotations: false });
    expect(overrides.clear()).toBe(true);
    expect(overrides.indices()).toEqual([]);
  });

  it('clone 生成冻结的深拷贝快照', () => {
    const overrides = new PageLayerOverrides();
    overrides.set(1, { foreground: false });
    const snapshot = overrides.clone(3);
    expect(snapshot.sessionId).toBe(3);
    expect(snapshot.defaults).toEqual(createDefaultVisibility());
    expect(snapshot.pages[1]).toEqual({ ...createDefaultVisibility(), foreground: false });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pages)).toBe(true);
    expect(Object.isFrozen(snapshot.pages[1])).toBe(true);
    // 修改快照不影响内部状态。
    overrides.set(1, { foreground: true });
    expect(snapshot.pages[1]!.foreground).toBe(false);
  });
});

describe('resolveLayerPanelOptions', () => {
  it('缺省为可见、可用、六项全可见', () => {
    expect(resolveLayerPanelOptions()).toEqual({
      enabled: true,
      disabled: false,
      defaultVisibility: createDefaultVisibility(),
    });
  });

  it('enabled=false 关闭渲染；disabled=true 保留但禁用', () => {
    expect(resolveLayerPanelOptions({ enabled: false }).enabled).toBe(false);
    const disabled = resolveLayerPanelOptions({ disabled: true });
    expect(disabled.enabled).toBe(true);
    expect(disabled.disabled).toBe(true);
  });

  it('非布尔值回落默认；enabled 与 disabled 同时为 true 时 disabled 优先', () => {
    const resolved = resolveLayerPanelOptions({
      enabled: 'no' as unknown as boolean,
      disabled: 'yes' as unknown as boolean,
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.disabled).toBe(false);

    const both = resolveLayerPanelOptions({ enabled: true, disabled: true });
    expect(both.enabled).toBe(true);
    expect(both.disabled).toBe(true);
  });

  it('defaultVisibility 只接受六项布尔，其余回落 true', () => {
    const resolved = resolveLayerPanelOptions({
      defaultVisibility: {
        body: 'no' as unknown as boolean,
        background: false,
        unknown: false,
      } as LayerVisibility,
    });
    expect(resolved.defaultVisibility).toEqual({ ...createDefaultVisibility(), background: false });
    expect(resolveLayerPanelOptions({ defaultVisibility: 'x' as unknown as LayerVisibility }))
      .toEqual({
        enabled: true,
        disabled: false,
        defaultVisibility: createDefaultVisibility(),
      });
  });
});

describe('注释类型扩展（设计方案 §H.7 · §I）', () => {
  const KNOWN = ['Link', 'Path', 'Highlight', 'Stamp', 'Watermark'];
  const KNOWN_PLUS_EXTRA = [...KNOWN, 'Signature'];
  /** 候选全集（常见五类 + 探测常量），白名单顺序同此。 */
  const CANDIDATES = annotationTypeProbeCandidates();
  /**
   * 期望白名单：只排除明确取消的类型，未列出的候选类型保持可见（§I.4.2）。
   *
   * @param unchecked 被显式取消的类型。
   * @returns 期望的白名单顺序。
   */
  function expectedWhitelist(unchecked: readonly string[]): string[] {
    return CANDIDATES.filter((type) => unchecked.indexOf(type) < 0);
  }

  it('T1/T2/T3 归一化：布尔与对象两种写法、总开关关闭时保留类型表', () => {
    expect(normalizeLayerVisibility({ annotations: false }).annotations).toEqual({
      enabled: false,
      types: {},
    });
    expect(normalizeLayerVisibility({ annotations: true }).annotations).toEqual({
      enabled: true,
      types: {},
    });
    expect(normalizeLayerVisibility({}).annotations).toEqual({ enabled: true, types: {} });
    const normalized = normalizeLayerVisibility({
      annotations: {
        types: { Link: false, X: 'no' as unknown as boolean, '': true },
      },
    });
    expect(normalized.annotations).toEqual({ enabled: true, types: { Link: false } });
    // 总开关关闭时类型表保留，重新打开即恢复。
    const kept = normalizeLayerVisibility({
      annotations: { enabled: false, types: { Link: false } },
    });
    expect(kept.annotations.types).toEqual({ Link: false });
    expect(selectedAnnotationTypes({ enabled: true, types: kept.annotations.types }, ['Link'])).toEqual([]);
  });

  it('T4/T5 全勾不写白名单；总开关关闭只写 annotations:false', () => {
    expect(toPageContentFilter(ALL, KNOWN)).toBeUndefined();
    expect(contentFilterKey(ALL, KNOWN)).toBe('all');
    const filter = toPageContentFilter({ annotations: false }, KNOWN);
    expect(filter?.annotations).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(filter, 'annotationTypes')).toBe(false);
    expect(contentFilterKey({ annotations: false }, KNOWN)).not.toBe('all');
  });

  it('T6/T7 部分勾选写白名单；零勾选固定为 annotations:false 且不写 annotationTypes', () => {
    const partial = toPageContentFilter({ annotations: { types: { Watermark: false } } }, KNOWN);
    expect(partial?.annotations).toBe(true);
    // 白名单只排除明确取消的类型；未列出的候选类型并入白名单（§I.4.2）。
    expect(partial?.annotationTypes).toEqual(expectedWhitelist(['Watermark']));
    expect(partial?.annotationTypes).not.toContain('Watermark');
    expect(contentFilterKey({ annotations: { types: { Watermark: false } } }, KNOWN)).toContain(
      'types=Link,Path,Highlight,Stamp,Signature',
    );
    expect(contentFilterKey({ annotations: { types: { Watermark: false } } }, KNOWN)).not.toContain(
      'Watermark',
    );

    const types: Record<string, boolean> = {};
    for (const type of KNOWN) types[type] = false;
    const zero = toPageContentFilter({ annotations: { types } }, KNOWN);
    expect(zero?.annotations).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(zero, 'annotationTypes')).toBe(false);
    // 与“关闭总开关”得到同一签名。
    expect(contentFilterKey({ annotations: { types } }, KNOWN)).toBe(
      contentFilterKey({ annotations: false }, KNOWN),
    );
    // 禁止 `annotationTypes: []` 表达零勾选。
    expect(zero?.annotationTypes).not.toEqual([]);
  });

  it('T8/T9 追加类型：白名单只由“显式取消”决定，列出的追加类型不改变签名', () => {
    const draft = { annotations: { types: { Watermark: false } } };
    const partialKnown = toPageContentFilter(draft, KNOWN);
    const partialExtra = toPageContentFilter(draft, KNOWN_PLUS_EXTRA);
    // 探测到追加类型且仍勾选：白名单与签名都不变（不产生额外重绘）。
    expect(partialExtra?.annotationTypes).toEqual(partialKnown?.annotationTypes);
    expect(partialExtra?.annotationTypes).toContain('Signature');
    expect(contentFilterKey(draft, KNOWN_PLUS_EXTRA)).toBe(contentFilterKey(draft, KNOWN));

    // 显式取消追加类型 → 从白名单移除。
    const uncheckedExtra = { annotations: { types: { Signature: false, Watermark: false } } };
    expect(toPageContentFilter(uncheckedExtra, KNOWN_PLUS_EXTRA)?.annotationTypes).not.toContain(
      'Signature',
    );
    // 全勾（含追加）仍是全画。
    expect(toPageContentFilter(ALL, KNOWN_PLUS_EXTRA)).toBeUndefined();
    expect(contentFilterKey(ALL, KNOWN_PLUS_EXTRA)).toBe('all');
  });

  it('T10 与引擎逐一对拍：默认/全勾/部分/零勾/关闭 均一致', () => {
    const cases: LayerVisibility[] = [
      ALL,
      { annotations: false },
      { annotations: { enabled: false } },
      { annotations: { types: { Watermark: false } } },
      { annotations: { types: { Link: false, Path: false, Highlight: false, Stamp: false, Watermark: false } } },
      { annotations: { enabled: false, types: { Watermark: false } } },
      { custom: false, annotations: { types: { Watermark: false } } },
    ];
    for (const types of [[], KNOWN, KNOWN_PLUS_EXTRA] as const) {
      for (const target of cases) {
        const filter = toPageContentFilter(target, types);
        expect(resolveContentFilter(filter).key).toBe(contentFilterKey(target, types));
      }
    }
    expect(resolveContentFilter(undefined).key).toBe('all');
  });

  it('T11 覆盖表只存差异：改回默认后删除覆盖', () => {
    const overrides = new PageLayerOverrides();
    expect(overrides.set(0, { annotations: { types: { Link: false } } }, KNOWN)).toBe(true);
    expect(overrides.indices()).toEqual([0]);
    // 显式把该类型勾回（`true` 表示从表中删除键）后覆盖被删除。
    expect(overrides.set(0, { annotations: { types: { Link: true } } }, KNOWN)).toBe(true);
    expect(overrides.indices()).toEqual([]);
  });

  it('T12 追加类型不改变签名：白名单只由显式取消决定', () => {
    const overrides = new PageLayerOverrides();
    expect(overrides.keyWith(0, KNOWN)).toBe('all');
    expect(overrides.keyWith(0, KNOWN_PLUS_EXTRA)).toBe('all');
    overrides.set(0, { annotations: { types: { Watermark: false } } }, KNOWN);
    // 探测到追加类型不会让已勾选状态下的签名变化。
    expect(overrides.keyAt(0, KNOWN)).toBe(overrides.keyAt(0, KNOWN_PLUS_EXTRA));
    expect(overrides.filterAt(0, KNOWN_PLUS_EXTRA)?.annotationTypes).toContain('Signature');
    // 取消追加类型后，白名单随之变化。
    overrides.set(0, { annotations: { types: { Signature: false } } }, KNOWN_PLUS_EXTRA);
    expect(overrides.filterAt(0, KNOWN_PLUS_EXTRA)?.annotationTypes).not.toContain('Signature');
  });

  it('T13 defaultVisibility.annotations 解析：布尔与对象等价', () => {
    const resolved = resolveLayerPanelOptions({
      defaultVisibility: { annotations: { types: { Watermark: false } } },
    });
    expect(resolved.defaultVisibility.annotations).toEqual({
      enabled: true,
      types: { Watermark: false },
    });
    expect(
      resolveLayerPanelOptions({ defaultVisibility: { annotations: false } }).defaultVisibility
        .annotations,
    ).toEqual({ enabled: false, types: {} });
    expect(
      resolveLayerPanelOptions({ defaultVisibility: { annotations: true } }).defaultVisibility
        .annotations,
    ).toEqual({ enabled: true, types: {} });
    for (const invalid of ['x', [], null] as unknown[]) {
      expect(
        resolveLayerPanelOptions({
          defaultVisibility: { annotations: invalid } as unknown as LayerVisibility,
        }).defaultVisibility.annotations,
      ).toEqual({ enabled: true, types: {} });
    }
  });

  it('T14 类型列表：常见五类顺序固定，追加类型字典序（UTF-16 码元序、区分大小写）', () => {
    expect(annotationTypesForGroup(['Signature', 'Note', 'Check'])).toEqual([
      ...KNOWN,
      'Check',
      'Note',
      'Signature',
    ]);
    expect(annotationTypesForGroup(['Note', 'anchor', 'Check'])).toEqual([
      ...KNOWN,
      'Check',
      'Note',
      'anchor',
    ]);
    // 与常见五类同名去重。
    expect(annotationTypesForGroup(['Link', 'Link', 'Signature'])).toEqual([
      ...KNOWN,
      'Signature',
    ]);
  });
});
