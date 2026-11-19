/**
 * Document.xml 声明补全（GB/T 33190-2016 §7.5 表 8/表 9）。
 *
 * 覆盖：视图首选项解码与应用值换算、权限声明缺省语义与 `Copies` 边界、有效期、
 * XML 解析健壮性（命名空间前缀/注释/DOCTYPE 拒绝/非法字段降级）、真实 OFD 包读取。
 */
import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import {
  declarationSourceOf,
  readDeclarationsFromRoot,
  readDocumentDeclarations,
  readPermissions,
  resolveDocumentPolicy,
} from '../../../src/document/declarations';
import {
  readViewPreferences,
  resolvePermissionEffects,
  resolveViewPreferenceIntents,
} from '../../../src/document/view-preferences';
import { parseDocumentXml } from '../../../src/document/xml-parse';

/** 解析 XML 文本为声明节点。 */
function parse(xml: string) {
  return parseDocumentXml(new TextEncoder().encode(xml));
}

/** 把 XML 文本包成 OFD 风格的 Document 根。 */
function documentXml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData>
  ${inner}
</ofd:Document>`;
}

/** 压缩生成最小 OFD 包；`document` 为 Document.xml 文本。 */
function buildOfd(document: string): Uint8Array {
  return zipSync({
    'OFD.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.0" DocType="OFD">' +
        '<ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>',
    ),
    'Doc_0/Document.xml': strToU8(document),
  });
}

/** 把字节包装为引擎 ArrayBuffer 来源。 */
function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('视图首选项解码（表 9）', () => {
  it('按标准字段解码全部取值', () => {
    const node = parse(
      `<VPreferences>
        <PageMode>UseOutlines</PageMode>
        <PageLayout>TwoPageL</PageLayout>
        <TabDisplay>DocTitle</TabDisplay>
        <HideToolbar>true</HideToolbar>
        <HideMenubar>1</HideMenubar>
        <HideWindowUI>false</HideWindowUI>
        <ZoomMode>FitWidth</ZoomMode>
        <Zoom>1.5</Zoom>
      </VPreferences>`,
    );
    expect(readViewPreferences(node)).toEqual({
      pageMode: 'UseOutlines',
      pageLayout: 'TwoPageL',
      tabDisplay: 'DocTitle',
      hideToolbar: true,
      hideMenuBar: true,
      hideWindowUI: false,
      zoomMode: 'FitWidth',
      zoom: 1.5,
    });
  });

  it('兼容命名空间前缀与 HideMenuBar 拼写，枚举大小写不敏感', () => {
    const node = parse(
      `<ofd:VPreferences><ofd:PageMode>useTHUMBS</ofd:PageMode><ofd:HideMenuBar>true</ofd:HideMenuBar></ofd:VPreferences>`,
    );
    expect(readViewPreferences(node)).toEqual({ pageMode: 'UseThumbs', hideMenuBar: true });
  });

  it('非法取值上报 warning 后忽略，不影响其余字段', () => {
    const onWarning = vi.fn();
    const node = parse(
      `<VPreferences><PageMode>Unknown</PageMode><Zoom>-2</Zoom><TabDisplay>DocTitle</TabDisplay></VPreferences>`,
    );
    const result = readViewPreferences(node, { onWarning });
    expect(result).toEqual({ tabDisplay: 'DocTitle' });
    expect(onWarning).toHaveBeenCalledTimes(2);
  });

  it('没有可识别字段时返回 undefined', () => {
    expect(readViewPreferences(parse('<VPreferences></VPreferences>'))).toBeUndefined();
    expect(readViewPreferences(undefined)).toBeUndefined();
  });
});

describe('视图首选项换算为初始视图', () => {
  it('ZoomMode 映射到阅读器缩放模式', () => {
    expect(resolveViewPreferenceIntents({ zoomMode: 'FitWidth' }, false).zoomMode).toBe(
      'page-width',
    );
    expect(resolveViewPreferenceIntents({ zoomMode: 'FitHeight' }, false).zoomMode).toBe(
      'page-fit',
    );
    expect(resolveViewPreferenceIntents({ zoomMode: 'FitRect' }, false).zoomMode).toBe(
      'page-fit',
    );
  });

  it('Zoom 仅在 ZoomMode 为 Default 或未声明时生效，并按 0.25–10 夹取', () => {
    expect(resolveViewPreferenceIntents({ zoomMode: 'Default', zoom: 1.5 }, false).zoom).toBe(1.5);
    expect(resolveViewPreferenceIntents({ zoom: 20 }, false).zoom).toBe(10);
    expect(resolveViewPreferenceIntents({ zoom: 0.1 }, false).zoom).toBe(0.25);
    expect(resolveViewPreferenceIntents({ zoomMode: 'FitWidth', zoom: 1.5 }, false).zoom).toBe(
      undefined,
    );
  });

  it('PageMode 映射到侧栏与全屏；None/UseCustomTags 不施加要求', () => {
    const cases: Array<[string, string | undefined]> = [
      ['UseOutlines', 'outline'],
      ['UseThumbs', 'thumbnails'],
      ['UseBookmarks', 'bookmarks'],
      ['UseAttaches', 'attachments'],
      ['UseLayers', 'layers'],
      ['UseCustomTags', undefined],
      ['None', undefined],
    ];
    for (const [pageMode, sidebar] of cases) {
      const intents = resolveViewPreferenceIntents(
        { pageMode: pageMode as never },
        false,
      );
      expect(intents.sidebar).toBe(sidebar);
      expect(intents.fullscreen).toBeUndefined();
    }
    expect(resolveViewPreferenceIntents({ pageMode: 'FullScreen' }, false).fullscreen).toBe(true);
  });

  it('TabDisplay=DocTitle 仅在文档有标题时生效', () => {
    expect(resolveViewPreferenceIntents({ tabDisplay: 'DocTitle' }, true).useDocumentTitle).toBe(
      true,
    );
    expect(
      resolveViewPreferenceIntents({ tabDisplay: 'DocTitle' }, false).useDocumentTitle,
    ).toBeUndefined();
    expect(
      resolveViewPreferenceIntents({ tabDisplay: 'FileName' }, true).useDocumentTitle,
    ).toBeUndefined();
  });
});

describe('权限声明解码（表 8）', () => {
  it('缺失字段按标准默认值：六项允许、Print 允许且份数不限', () => {
    const permissions = readPermissions(parse('<Permissions></Permissions>'));
    expect(permissions).toEqual({
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
    });
  });

  it('解码六项布尔、Print@Printable/Copies 与 ValidPeriod', () => {
    const permissions = readPermissions(
      parse(
        `<Permissions>
          <Edit>false</Edit><Annot>0</Annot><Export>false</Export>
          <Signature>no</Signature><Watermark>false</Watermark><PrintScreen>false</PrintScreen>
          <Print Printable="false" Copies="3"/>
          <ValidPeriod StartDate="2024-01-01T00:00:00Z" EndDate="2099-12-31T23:59:59Z"/>
        </Permissions>`,
      ),
    );
    expect(permissions).toMatchObject({
      edit: false,
      annot: false,
      export: false,
      signature: false,
      watermark: false,
      printScreen: false,
      print: { printable: false, copies: 3 },
      validPeriod: { start: '2024-01-01T00:00:00Z', end: '2099-12-31T23:59:59Z' },
    });
  });

  it('Copies 负数为不限、0 表示不允许打印', () => {
    expect(readPermissions(parse('<Permissions><Print Copies="-1"/></Permissions>'))?.print).toEqual(
      { printable: true },
    );
    expect(readPermissions(parse('<Permissions><Print Copies="0"/></Permissions>'))?.print).toEqual({
      printable: true,
      copies: 0,
    });
  });

  it('非法字段上报 warning 后按默认值处理', () => {
    const onWarning = vi.fn();
    const permissions = readPermissions(
      parse('<Permissions><Edit>maybe</Edit><Print Copies="abc"/></Permissions>'),
      { onWarning },
    );
    expect(permissions?.edit).toBe(true);
    expect(permissions?.print).toEqual({ printable: true });
    expect(onWarning).toHaveBeenCalledTimes(2);
  });
});

describe('权限生效判定', () => {
  it('无声明时全部允许', () => {
    expect(resolvePermissionEffects(undefined)).toEqual({
      printBlocked: false,
      allowCopy: true,
      allowSignature: true,
      allowWatermark: true,
      expired: false,
    });
  });

  it('Printable=false 或 Copies=0 时禁止打印；正数份数透出', () => {
    expect(resolvePermissionEffects({ print: { printable: false } }).printBlocked).toBe(true);
    expect(resolvePermissionEffects({ print: { printable: true, copies: 0 } }).printBlocked).toBe(
      true,
    );
    expect(resolvePermissionEffects({ print: { printable: true, copies: 5 } }).printCopies).toBe(5);
    expect(resolvePermissionEffects({ print: { printable: true } }).printCopies).toBeUndefined();
  });

  it('PrintScreen/Signature/Watermark=false 时禁止对应入口', () => {
    const effects = resolvePermissionEffects({
      printScreen: false,
      signature: false,
      watermark: false,
    });
    expect(effects).toMatchObject({
      allowCopy: false,
      allowSignature: false,
      allowWatermark: false,
    });
  });

  it('有效期已过或未到时按 EndDate 判定，纯日期含当天', () => {
    const now = Date.parse('2024-06-01T00:00:00Z');
    expect(resolvePermissionEffects({ validPeriod: { end: '2024-05-31T00:00:00Z' } }, now).expired).toBe(
      true,
    );
    expect(resolvePermissionEffects({ validPeriod: { end: '2024-06-01' } }, now).expired).toBe(false);
    expect(resolvePermissionEffects({ validPeriod: { end: '无法解析' } }, now).expired).toBe(false);
  });
});

describe('Document.xml 读取', () => {
  it('从 Document 根读出视图首选项、权限与页面区', () => {
    const root = parse(
      documentXml(
        `<ofd:VPreferences><ofd:PageMode>UseThumbs</ofd:PageMode></ofd:VPreferences>
         <ofd:Permissions><ofd:Export>false</ofd:Export></ofd:Permissions>`,
      ),
    );
    const declarations = readDeclarationsFromRoot(root);
    expect(declarations.viewPreferences).toEqual({ pageMode: 'UseThumbs' });
    expect(declarations.permissions?.export).toBe(false);
    // 210mm × 297mm 按 96 DPI 换算为 CSS px。
    expect(declarations.pageAreaPx?.width).toBeCloseTo(793.7, 1);
    expect(declarations.pageAreaPx?.height).toBeCloseTo(1122.52, 1);
  });

  it('没有 VPreferences/Permissions 时返回空声明', () => {
    expect(readDeclarationsFromRoot(parse(documentXml('')))).toEqual({
      pageAreaPx: expect.any(Object),
    });
  });

  it('宿主关闭视图首选项应用时换算结果为空', () => {
    const declarations = readDeclarationsFromRoot(
      parse(documentXml('<VPreferences><PageMode>UseOutlines</PageMode></VPreferences>')),
    );
    expect(
      resolveDocumentPolicy(declarations, { hasTitle: false, applyViewPreferences: false }).intents,
    ).toEqual({});
    expect(
      resolveDocumentPolicy(declarations, { hasTitle: false }).intents.sidebar,
    ).toBe('outline');
  });

  it('宿主关闭权限门控时结论统一为允许', () => {
    const declarations = readDeclarationsFromRoot(
      parse(documentXml('<Permissions><PrintScreen>false</PrintScreen></Permissions>')),
    );
    const policy = resolveDocumentPolicy(declarations, {
      hasTitle: false,
      applyPermissions: false,
    });
    expect(policy.applyPermissions).toBe(false);
    // 原文保留供展示，门控结论由阅读器按 applyPermissions 忽略。
    expect(policy.permissions?.printScreen).toBe(false);
  });

  it('从真实 OFD 包字节读出 Document.xml 声明', async () => {
    const bytes = buildOfd(
      documentXml(
        `<ofd:VPreferences><ofd:ZoomMode>FitWidth</ofd:ZoomMode></ofd:VPreferences>
         <ofd:Permissions><ofd:PrintScreen>false</ofd:PrintScreen><ofd:Print Copies="2"/></ofd:Permissions>`,
      ),
    );
    const declarations = await readDocumentDeclarations(
      declarationSourceOf({ kind: 'arraybuffer', data: ab(bytes) }),
    );
    expect(declarations.viewPreferences).toEqual({ zoomMode: 'FitWidth' });
    expect(declarations.permissions).toMatchObject({
      printScreen: false,
      print: { printable: true, copies: 2 },
    });
    expect(declarations.pageAreaPx?.width).toBeCloseTo(793.7, 1);
  });

  it('非 ZIP 输入降级为空声明且不产生诊断', async () => {
    const onWarning = vi.fn();
    const declarations = await readDocumentDeclarations(
      declarationSourceOf({ kind: 'arraybuffer', data: new ArrayBuffer(8) }),
      { onWarning },
    );
    expect(declarations).toEqual({});
    // 非法包由引擎在打开阶段报告，声明读取不重复诊断。
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('已打开的容器可复用，且不会被声明读取关闭', async () => {
    const bytes = buildOfd(documentXml('<Permissions><Export>false</Export></Permissions>'));
    const container = await openZipVirtualContainer({ kind: 'arraybuffer', data: ab(bytes) });
    try {
      const declarations = await readDocumentDeclarations({ kind: 'container', container });
      expect(declarations.permissions?.export).toBe(false);
      // 容器仍可继续读取，说明声明读取没有关闭它。
      const xml = await container.read('Doc_0/Document.xml');
      expect(Object.prototype.toString.call(xml)).toBe('[object Uint8Array]');
    } finally {
      await container.close();
    }
  });
});

describe('XML 解析', () => {
  it('支持引号内的 >、自闭合与实体', () => {
    const node = parse('<a b="x>y"><c/><d>&lt;e&gt;</d></a>');
    expect(node.attrs.b).toBe('x>y');
    expect(node.children.map((child) => child.name)).toEqual(['c', 'd']);
    expect(node.children[1]?.text).toBe('<e>');
  });

  it('忽略注释与处理指令', () => {
    const node = parse('<?xml version="1.0"?><!-- c --><VPreferences><!--x--><Zoom>2</Zoom></VPreferences>');
    expect(readViewPreferences(node)).toEqual({ zoom: 2 });
  });

  it('拒绝 DOCTYPE（XXE 防护）', () => {
    expect(() => parse('<!DOCTYPE x><a/>')).toThrow(/DOCTYPE/);
  });

  it('标签不匹配时抛错', () => {
    expect(() => parse('<a><b></a></b>')).toThrow();
  });
});
