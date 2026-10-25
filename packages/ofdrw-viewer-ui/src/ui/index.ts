/**
 * 内置 UI 与阅读器核心的接线。
 *
 * 本模块不直接依赖 `src/viewer.ts`（该文件由核心任务维护），只声明所需的
 * 结构化接口；最终入口在 t9 中调用：
 *
 * ```ts
 * import { registerViewerExtension } from './viewer';
 * import { installUIShell } from './ui';
 * installUIShell(registerViewerExtension);
 * ```
 *
 * 接线职责：
 * - 把工具栏/侧栏命令映射到实例方法；
 * - 监听核心状态/功能/侧栏/查找事件，反向刷新外壳；
 * - 不接管核心的侧栏 hidden 与断点属性，避免双写。
 */
import { createTranslator, type Translator } from '../i18n';
import type { LocalFontsStatus } from '../local-fonts-state';
import type { ViewerState, Rotation, SidebarView, ZoomMode } from '../state';
import type {
  ExportImageOptions,
  ExportImagesOptions,
  ExportOfdOptions,
  PageRange,
  PrintOptions,
  ViewerDocumentInfo,
  ViewerEventHandler,
  ViewerEventName,
} from '../types';
import { getVersions } from '../version';
import { THIRD_PARTY_NOTICES } from '../licenses';
import { UIShell } from './ui-shell';
import type { UIShellElements, UIShellCommand, UIShellViewState } from './types';

/** 内置 UI 所需的最小阅读器接口；`OFDViewer` 结构兼容。 */
export interface UIShellHost {
  /** 核心创建的 DOM 容器。 */
  getElements(): UIShellElements;
  /** 最新状态快照。 */
  getState(): ViewerState;
  /** 订阅事件；返回取消订阅函数。 */
  on<K extends ViewerEventName>(event: K, handler: ViewerEventHandler<K>): () => void;
  /** 切换侧栏。 */
  toggleSidebar(): unknown;
  /** 打开指定侧栏。 */
  openSidebar(view: SidebarView): unknown;
  /** 关闭侧栏。 */
  closeSidebar(): unknown;
  /** 跳转到指定页（1-based）。 */
  goToPage(pageNumber: number): unknown;
  /** 下一页。 */
  nextPage(): unknown;
  /** 上一页。 */
  previousPage(): unknown;
  /** 放大。 */
  zoomIn(): unknown;
  /** 缩小。 */
  zoomOut(): unknown;
  /** 设置实际倍率。 */
  setScale(scale: number): unknown;
  /** 设置缩放模式。 */
  setZoomMode(mode: ZoomMode): unknown;
  /** 顺时针旋转 90°。 */
  rotateClockwise(): unknown;
  /** 执行查找。 */
  find(
    query: string,
    options?: {
      readonly caseSensitive?: boolean;
      readonly wholeWord?: boolean;
      readonly highlightAll?: boolean;
    },
  ): unknown;
  /** 下一个匹配。 */
  findNext(): unknown;
  /** 上一个匹配。 */
  findPrevious(): unknown;
  /** 清除查找结果。 */
  clearFind(): unknown;
  /** 打开打印流程。 */
  print(options?: PrintOptions): unknown;
  /** 导出单页图片。 */
  exportImage(options?: ExportImageOptions): unknown;
  /** 导出多页图片（ZIP）。 */
  exportImages(options?: ExportImagesOptions): unknown;
  /** 导出当前 OFD 原文件。 */
  exportOfd(options?: ExportOfdOptions): unknown;
  /** 进入/退出全屏。 */
  setFullscreen(value: boolean): unknown;
  /** 打开验证面板；未启用密码能力时省略。 */
  openVerificationPanel?(): unknown;
  /** 读取完整文档信息快照；核心未提供时属性对话框退回状态内字段。 */
  getDocumentInfo?(): Promise<ViewerDocumentInfo>;
  /** 读取本地字体状态；未启用该能力时省略。 */
  getLocalFontsStatus?(): LocalFontsStatus;
  /** 设置本地字体开关；核心未提供时「关于」里的开关不注册。 */
  setLocalFontsEnabled?(enabled: boolean): Promise<void>;
  /** 订阅本地字体状态变化。 */
  onLocalFontsStatusChange?(handler: (status: LocalFontsStatus) => void): () => void;
}

/** 扩展注册函数；`registerViewerExtension` 结构兼容。 */
export type UIShellExtensionRegistrar = (
  extension: (viewer: UIShellHost) => void | (() => void),
) => void;

/** 每个阅读器实例对应的 UI 外壳；供缩略图/打印/导出/签章模块挂载面板与对话框。 */
const uiShells = new WeakMap<UIShellHost, UIShell>();

/** 把核心状态投影为外壳所需的最小视图状态。 */
function toShellState(
  state: ViewerState,
  localFonts?: LocalFontsStatus,
): UIShellViewState {
  return {
    pageNumber: state.view.pageNumber,
    pageCount: state.document.pageCount,
    scale: state.view.scale,
    zoomMode: state.view.zoomMode,
    rotation: state.view.rotation,
    sidebarView: state.view.sidebarView,
    fullscreen: state.view.fullscreen,
    find: state.view.findState,
    theme: state.ui.theme,
    locale: state.ui.locale,
    documentStatus: state.document.status,
    documentTitle: state.document.metadata?.title,
    ...(localFonts ? { localFonts } : {}),
  };
}

/**
 * 读取某个阅读器实例的 UI 外壳。
 *
 * @param viewer 阅读器实例。
 * @returns 外壳；未挂载时返回 undefined。
 */
export function getUIShell(viewer: UIShellHost): UIShell | undefined {
  return uiShells.get(viewer);
}

/**
 * 执行返回 Promise 的核心方法并上报失败，避免未处理的 rejection。
 *
 * @param result 核心方法返回值。
 * @param shell 当前外壳，用于错误 Toast。
 */
function settle(result: unknown, shell: UIShell): void {
  if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return;
  void Promise.resolve(result).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    shell.showToast(message, { level: 'error', id: 'ofd-ui-command-error' });
  });
}

/** 属性对话框中的一行；值为空时该行不渲染。 */
type PropertyRow = readonly [label: string, value: string | undefined];

/** 属性对话框中的一个分组。 */
interface PropertyGroup {
  /** 分组标题。 */
  readonly title: string;
  /** 分组内各行，按展示顺序排列。 */
  readonly rows: readonly PropertyRow[];
}

/**
 * 格式化字节数为 KB/MB 文本。
 *
 * @param translator 翻译器。
 * @param bytes 字节数，单位 byte。
 * @returns 例如 `12.3 KB`；非法值返回 undefined。
 */
function formatBytes(translator: Translator, bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  const kb = bytes / 1024;
  if (kb < 1024) {
    return translator.t('properties.sizeKb', {
      value: translator.formatNumber(kb, { maximumFractionDigits: 1 }),
    });
  }
  return translator.t('properties.sizeMb', {
    value: translator.formatNumber(kb / 1024, { maximumFractionDigits: 2 }),
  });
}

/**
 * 格式化页面区矩形。
 *
 * @param translator 翻译器。
 * @param box 矩形，几何单位 mm。
 * @returns 例如 `210 × 297 mm（原点 0, 0 mm）`；缺失或非法时 undefined。
 */
function formatBox(
  translator: Translator,
  box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined,
): string | undefined {
  if (!box) return undefined;
  if (![box.x, box.y, box.w, box.h].every((value) => Number.isFinite(value))) return undefined;
  return translator.t('properties.boxValue', {
    width: translator.formatNumber(box.w, { maximumFractionDigits: 2 }),
    height: translator.formatNumber(box.h, { maximumFractionDigits: 2 }),
    x: translator.formatNumber(box.x, { maximumFractionDigits: 2 }),
    y: translator.formatNumber(box.y, { maximumFractionDigits: 2 }),
  });
}

/**
 * 把包内路径数组拼成一行文本。
 *
 * OFD 允许同一类资源声明多个路径；逐行展示会破坏键值布局，因此用换行符分隔，
 * 由 CSS 的 `white-space: pre-line` 渲染为多行。
 *
 * @param paths 包内路径列表。
 * @returns 以换行分隔的文本；空数组或缺失时返回 undefined。
 */
function joinPaths(paths: readonly string[] | undefined): string | undefined {
  if (!paths || paths.length === 0) return undefined;
  return paths.join('\n');
}

/**
 * 数字转为文本。
 *
 * @param value 数字；可为 undefined。
 * @returns 文本；非有限数字返回 undefined。
 */
function toStringOrUndefined(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return String(value);
}

/**
 * 构造权限一行的文本。
 *
 * @param translator 翻译器。
 * @param allowed 是否允许。
 * @returns “允许”/“不允许”。
 */
function formatPermission(translator: Translator, allowed: boolean): string {
  return allowed ? translator.t('properties.allowed') : translator.t('properties.denied');
}

/**
 * 收集文档属性对话框的六个分组（设计方案 §6.3）。
 *
 * 分组顺序与设计一致；任一分组内全部字段缺失时由 `createPropertySections` 隐藏。
 * 权限与附件来自 `getDocumentInfo()` 快照（不在 `ViewerState` 中）；快照不可用时
 * 这两项返回空，其余字段继续展示。
 *
 * @param viewer 阅读器实例。
 * @param translator 翻译器。
 * @param info 文档信息快照；读取失败时为 undefined。
 * @returns 分组列表。
 */
function collectPropertyGroups(
  viewer: UIShellHost,
  translator: Translator,
  info: ViewerDocumentInfo | undefined,
): readonly PropertyGroup[] {
  const { document: documentState } = viewer.getState();
  const metadata = info?.metadata ?? documentState.metadata;
  const header = metadata?.documentHeader;
  const packageInfo = metadata?.packageInfo;
  const commonData = metadata?.commonData;
  // 页面区优先取 Document.xml 头部声明，其次 CommonData。
  const pageArea = header?.pageArea ?? commonData?.pageArea;
  const permissions = info?.permissions;
  const printPermission = permissions?.print;
  const attachments = info?.attachments ?? [];
  const t = translator.t.bind(translator);

  const documentRows: PropertyRow[] = [
    [t('properties.title'), metadata?.title],
    [t('properties.author'), metadata?.author],
    [t('properties.subject'), metadata?.subject],
    [t('properties.abstract'), metadata?.abstract],
    [t('properties.keywords'), metadata?.keywords?.join(', ')],
    [t('properties.docUsage'), metadata?.docUsage ?? header?.docUsage],
    [t('properties.docId'), metadata?.docId ?? header?.docId],
    [t('properties.creationDate'), metadata?.creationDate],
    [t('properties.modDate'), metadata?.modDate],
    [t('properties.creator'), metadata?.creator],
    [t('properties.creatorVersion'), metadata?.creatorVersion],
  ];

  const packageRows: PropertyRow[] = [
    [t('properties.version'), metadata?.version],
    [t('properties.docType'), metadata?.docType],
    [t('properties.docRoot'), packageInfo?.docRoot],
    [t('properties.maxUnitId'), toStringOrUndefined(packageInfo?.maxUnitId)],
    [t('properties.docBodyCount'), toStringOrUndefined(packageInfo?.docBodyCount)],
    [t('properties.pageCount'), String(documentState.pageCount)],
    [t('properties.fileSize'), formatBytes(translator, metadata?.packageSize)],
  ];

  const pageRows: PropertyRow[] = [
    [t('properties.physicalBox'), formatBox(translator, pageArea?.physicalBox)],
    [t('properties.applicationBox'), formatBox(translator, pageArea?.applicationBox)],
    [t('properties.bleedBox'), formatBox(translator, pageArea?.bleedBox)],
  ];

  const resourceRows: PropertyRow[] = [
    [t('properties.defaultColorSpace'), header?.defaultCs ?? commonData?.defaultColorSpaceId],
    [t('properties.publicRes'), joinPaths(header?.publicRes)],
    [t('properties.documentRes'), joinPaths(header?.documentRes)],
    [t('properties.templatePageRes'), joinPaths(header?.templatePageRes)],
    [t('properties.dataDir'), commonData?.dataDir],
  ];

  // 权限 6 项逐项展示；打印与份数仅在文档声明 Print 时出现。
  const permissionRows: PropertyRow[] = permissions
    ? [
        [t('properties.permission.edit'), formatPermission(translator, permissions.edit)],
        [t('properties.permission.annot'), formatPermission(translator, permissions.annot)],
        [t('properties.permission.export'), formatPermission(translator, permissions.export)],
        [t('properties.permission.signature'), formatPermission(translator, permissions.signature)],
        [t('properties.permission.watermark'), formatPermission(translator, permissions.watermark)],
        [t('properties.permission.printScreen'), formatPermission(translator, permissions.printScreen)],
        [
          t('properties.permission.print'),
          printPermission ? formatPermission(translator, printPermission.printable) : undefined,
        ],
        [
          t('properties.permission.printCopies'),
          printPermission?.copies === undefined
            ? undefined
            : t('properties.copies', { count: printPermission.copies }),
        ],
      ]
    : [];

  const securityRows: PropertyRow[] = [
    ...permissionRows,
    [t('properties.signatureCount'), toStringOrUndefined(documentState.signaturesSummary?.length)],
    [t('properties.attachmentCount'), String(attachments.length)],
    [t('properties.outlineCount'), toStringOrUndefined(documentState.outline?.length)],
    [t('properties.bookmarkCount'), toStringOrUndefined(documentState.bookmarks?.length)],
  ];

  // 附件清单只读：名称作标签，格式/大小/日期合并为一列。
  const attachmentRows: PropertyRow[] = attachments.map((item) => [
    item.name,
    [
      item.format ?? t('properties.missing'),
      formatBytes(translator, item.size) ?? t('properties.missing'),
      item.modDate ?? item.creationDate ?? t('properties.missing'),
    ].join(' · '),
  ]);

  return [
    { title: t('properties.groupDocument'), rows: documentRows },
    { title: t('properties.groupPackage'), rows: packageRows },
    { title: t('properties.groupPageSettings'), rows: pageRows },
    { title: t('properties.groupResources'), rows: resourceRows },
    { title: t('properties.groupSecurity'), rows: securityRows },
    { title: t('properties.groupAttachments'), rows: attachmentRows },
  ];
}

/**
 * 把分组渲染为 `<section>`；分组内全部字段缺失时跳过该分组。
 *
 * @param doc 对话框所属文档。
 * @param groups 分组列表。
 * @returns 容器元素；所有分组都为空时返回空容器。
 */
function createPropertySections(doc: Document, groups: readonly PropertyGroup[]): HTMLElement {
  const container = doc.createElement('div');
  container.className = 'ofd-properties__groups';
  for (const group of groups) {
    const visibleRows = group.rows.filter(([, value]) => Boolean(value));
    if (visibleRows.length === 0) continue;
    const section = doc.createElement('section');
    section.className = 'ofd-properties__group';
    const heading = doc.createElement('h3');
    heading.className = 'ofd-properties__heading';
    heading.textContent = group.title;
    const list = doc.createElement('dl');
    list.className = 'ofd-properties';
    for (const [label, value] of visibleRows) {
      if (!value) continue;
      const term = doc.createElement('dt');
      term.textContent = label;
      const description = doc.createElement('dd');
      description.textContent = value;
      list.append(term, description);
    }
    section.append(heading, list);
    container.append(section);
  }
  return container;
}

/**
 * 打开文档属性对话框（纯展示，不修改文档）。
 *
 * 按设计方案 §6.3 分六个分组展示；分组内全部字段缺失时隐藏该分组。权限与附件
 * 清单通过 `getDocumentInfo()` 按需读取（不铺进 `ViewerState`），附件清单只读，
 * 下载入口在附件侧栏。读取失败时退回状态中已有字段，不阻断对话框。
 *
 * @param viewer 阅读器实例。
 * @param shell 当前外壳。
 */
function showDocumentProperties(viewer: UIShellHost, shell: UIShell): void {
  const translator = shell.translatorInstance;
  const doc = shell.elements.root.ownerDocument;
  const render = (info: ViewerDocumentInfo | undefined): void => {
    const groups = collectPropertyGroups(viewer, translator, info);
    shell.openDialog({
      name: 'documentProperties',
      title: translator.t('toolbar.documentProperties'),
      content: createPropertySections(doc, groups),
      actions: [{ label: translator.t('dialog.closeAction'), primary: true }],
    });
  };
  if (typeof viewer.getDocumentInfo !== 'function') {
    render(undefined);
    return;
  }
  void viewer
    .getDocumentInfo()
    .then((info) => render(info))
    .catch(() => render(undefined));
}

/**
 * 打开“关于”对话框，展示阅读器各组成包版本与浏览器标识，供故障排查。
 *
 * @param shell 当前外壳。
 */
function showAboutDialog(shell: UIShell, viewer: UIShellHost): void {
  const translator = shell.translatorInstance;
  const doc = shell.elements.root.ownerDocument;
  const versions = getVersions();
  const userAgent = doc.defaultView?.navigator.userAgent;

  const list = doc.createElement('dl');
  list.className = 'ofd-properties';
  const rows: readonly (readonly [string, string | undefined])[] = [
    [translator.t('about.uiVersion'), versions.ui],
    [translator.t('about.engineVersion'), versions.engine],
    [translator.t('about.cryptoVersion'), versions.crypto],
    [translator.t('about.userAgent'), userAgent],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    const term = doc.createElement('dt');
    term.textContent = label;
    const description = doc.createElement('dd');
    description.textContent = value;
    list.append(term, description);
  }

  const licenseTerm = doc.createElement('dt');
  licenseTerm.textContent = translator.t('about.license');
  const licenseDescription = doc.createElement('dd');
  const licenseLink = doc.createElement('a');
  licenseLink.href = '#';
  licenseLink.className = 'ofd-properties__link';
  licenseLink.textContent = translator.t('about.licenseOpen');
  licenseLink.addEventListener('click', (event) => {
    event.preventDefault();
    showLicensesDialog(shell);
  });
  licenseDescription.append(licenseLink);
  list.append(licenseTerm, licenseDescription);

  // 本机字体开关放在「关于」里：它属于环境能力设置而非阅读操作，且只在浏览器支持
  // 且宿主显式启用时才出现（`visible === false` 时整行不渲染）。
  const localFontsRow = createAboutLocalFontsRow(shell, viewer);
  if (localFontsRow) list.append(localFontsRow);

  shell.openDialog({
    name: 'about',
    title: translator.t('about.title'),
    content: list,
    actions: [{ label: translator.t('dialog.closeAction'), primary: true }],
  });
}

/**
 * 构造「关于」对话框里的本机字体开关行。
 *
 * @param shell 当前外壳。
 * @returns `dt`/`dd` 片段；能力不可见时返回 null。
 */
function createAboutLocalFontsRow(shell: UIShell, viewer: UIShellHost): DocumentFragment | null {
  const status = shell.getState().localFonts;
  if (!status || !status.visible) return null;
  const translator = shell.translatorInstance;
  const doc = shell.elements.root.ownerDocument;
  const fragment = doc.createDocumentFragment();

  const term = doc.createElement('dt');
  term.textContent = translator.t('localFonts.toggle');
  const description = doc.createElement('dd');
  description.className = 'ofd-properties__local-fonts';

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.className = 'ofd-switch';
  toggle.setAttribute('aria-checked', status.enabled ? 'true' : 'false');
  toggle.setAttribute('aria-label', translator.t('localFonts.toggle'));
  toggle.disabled = status.loading;
  toggle.dataset.enabled = status.enabled ? 'true' : 'false';

  const hint = doc.createElement('span');
  hint.className = 'ofd-properties__hint';
  hint.textContent = aboutLocalFontsText(shell, status);

  // 只在浏览器不支持时禁用开关（其余状态都可操作）。
  if (!status.supported) {
    toggle.disabled = true;
    toggle.hidden = true;
  }
  // 点击立即生效并刷新同一对话框里的文案；权限申请需用户手势，故直接调用核心方法。
  // 注意取反的依据是「用户授权开关」而非 `enabled`：`enabled` 已按浏览器授权收敛
  // （未授权时恒为 false），用它取反会让「关闭」永远算成「打开」。
  toggle.addEventListener('click', () => {
    const current = shell.getState().localFonts;
    const next = !(current?.userState === 'on');
    // 先乐观更新界面：开关状态反映「用户意向」，点下去就应立刻动，不必等授权往返。
    // 授权失败时核心会回滚意向并广播状态，下面的 sync 会用真实状态覆盖本地的乐观值。
    setToggleVisual(toggle, next);
    hint.textContent = translator.t('localFonts.status.loading');
    void viewer.setLocalFontsEnabled?.(next).then(() => {
      const latest = shell.getState().localFonts;
      if (!latest || !toggle.isConnected) return;
      setToggleVisual(toggle, latest.userState === 'on');
      hint.textContent = aboutLocalFontsText(shell, latest);
    });
  });

  description.append(toggle, hint);
  fragment.append(term, description);
  return fragment;
}

/** 更新开关的可视状态（`aria-checked` 与 `data-enabled`）。 */
function setToggleVisual(toggle: HTMLButtonElement, enabled: boolean): void {
  toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  toggle.dataset.enabled = enabled ? 'true' : 'false';
}

/**
 * 计算「关于」里本机字体行的状态文案。
 *
 * @param shell 当前外壳。
 * @param status 本地字体状态。
 * @returns 面向用户的一句话。
 */
function aboutLocalFontsText(shell: UIShell, status: LocalFontsStatus): string {
  const translator = shell.translatorInstance;
  if (!status.supported) return translator.t('localFonts.status.unsupported');
  if (status.enabled) return translator.t('localFonts.status.enabled');
  if (status.permission === 'denied') return translator.t('localFonts.status.denied');
  return translator.t('localFonts.status.prompt');
}

/**
 * 打开“开源软件许可”对话框，展示固定的第三方许可文本。
 *
 * @param shell 当前外壳。
 */
function showLicensesDialog(shell: UIShell): void {
  const translator = shell.translatorInstance;
  const doc = shell.elements.root.ownerDocument;
  const content = doc.createElement('pre');
  content.className = 'ofd-licenses';
  content.textContent = THIRD_PARTY_NOTICES;

  shell.openDialog({
    name: 'licenses',
    title: translator.t('about.license'),
    content,
    actions: [{ label: translator.t('dialog.closeAction'), primary: true }],
  });
}

/** 输出对话框字段 ID 序号；仅用于 DOM label 关联。 */
let outputFieldSequence = 0;

/**
 * 解析自定义页码范围文本，例如 `1-3,5`。
 *
 * @param text 用户输入；页码 1-based。
 * @param pageCount 文档总页数。
 * @returns 升序去重的页码数组；格式或边界非法时返回 null。
 */
function parseCustomPageRange(text: string, pageCount: number): number[] | null {
  if (pageCount < 1) return null;
  const pages = new Set<number>();
  for (const raw of text.split(',')) {
    const token = raw.trim();
    if (!token) return null;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to < from || to > pageCount) return null;
    for (let page = from; page <= to; page += 1) pages.add(page);
  }
  return pages.size > 0 ? [...pages].sort((a, b) => a - b) : null;
}

/** 页码范围默认值；打印默认全部页，导出默认当前页。 */
type OutputRangeDefault = 'current' | 'all';

/**
 * 创建打印/导出共用的页码范围控件。
 *
 * @param doc 对话框所属文档。
 * @param translator 翻译器。
 * @param defaultRange 打开对话框时的默认范围；默认当前页。
 * @returns 字段元素与读取函数；读取失败时在字段内显示错误。
 */
function createOutputRangeField(
  doc: Document,
  translator: Translator,
  defaultRange: OutputRangeDefault = 'current',
): { readonly field: HTMLElement; read(pageCount: number): PageRange | null } {
  const id = `ofd-output-range-${++outputFieldSequence}`;
  const field = doc.createElement('div');
  field.className = 'ofd-output-field';
  const label = doc.createElement('label');
  label.htmlFor = id;
  label.textContent = translator.t('output.range');
  const select = doc.createElement('select');
  select.id = id;
  select.className = 'ofd-select';
  for (const [value, text] of [
    ['current', translator.t('output.rangeCurrent')],
    ['all', translator.t('output.rangeAll')],
    ['custom', translator.t('output.rangeCustom')],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = defaultRange;
  const custom = doc.createElement('input');
  custom.className = 'ofd-input';
  custom.type = 'text';
  custom.placeholder = translator.t('output.rangePlaceholder');
  custom.setAttribute('aria-label', translator.t('output.range'));
  custom.hidden = true;
  custom.setAttribute('aria-describedby', `${id}-error`);
  const error = doc.createElement('p');
  error.className = 'ofd-output-error';
  error.id = `${id}-error`;
  error.setAttribute('role', 'alert');
  error.hidden = true;
  error.textContent = translator.t('output.rangeInvalid');
  select.addEventListener('change', () => {
    custom.hidden = select.value !== 'custom';
    if (!custom.hidden) custom.focus();
  });
  field.append(label, select, custom, error);

  return {
    field,
    read(pageCount: number): PageRange | null {
      if (select.value === 'current') return 'current';
      if (select.value === 'all') return 'all';
      const pages = parseCustomPageRange(custom.value, pageCount);
      const invalid = pages === null;
      error.hidden = !invalid;
      custom.setAttribute('aria-invalid', invalid ? 'true' : 'false');
      if (invalid) custom.focus();
      return pages;
    },
  };
}

/** 创建带 `<label for>` 关联的字段容器。 */
function createOutputField(doc: Document, text: string, ...controls: HTMLElement[]): HTMLElement {
  const field = doc.createElement('div');
  field.className = 'ofd-output-field';
  const id = `ofd-output-field-${++outputFieldSequence}`;
  const label = doc.createElement('label');
  label.className = 'ofd-output-field__label';
  label.textContent = text;
  const [first, ...rest] = controls;
  if (first) {
    if (!first.id) first.id = id;
    label.htmlFor = first.id;
  }
  for (const [index, control] of rest.entries()) {
    if (!control.id) control.id = `${id}-${index + 2}`;
    if (!control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby')) {
      control.setAttribute('aria-label', text);
    }
  }
  field.append(label, ...controls);
  return field;
}

/**
 * 打开打印选项对话框。
 *
 * @param viewer 阅读器实例。
 * @param shell 当前外壳。
 */
function openPrintDialog(viewer: UIShellHost, shell: UIShell): void {
  const doc = shell.root.ownerDocument;
  const translator = createTranslator(viewer.getState().ui.locale);
  const form = doc.createElement('form');
  form.className = 'ofd-output-form';
  form.setAttribute('aria-label', translator.t('output.printTitle'));
  // 打印默认覆盖全部页；用户仍可切换当前页或自定义范围。
  const range = createOutputRangeField(doc, translator, 'all');

  const dpi = doc.createElement('select');
  dpi.className = 'ofd-select';
  for (const [value, text] of [
    ['auto', translator.t('output.dpiAuto')],
    ['72', '72'],
    ['150', '150'],
    ['200', '200'],
    ['300', '300'],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    dpi.append(option);
  }

  const background = doc.createElement('input');
  background.type = 'checkbox';
  const backgroundLabel = doc.createElement('label');
  backgroundLabel.className = 'ofd-output-check';
  backgroundLabel.append(background, doc.createTextNode(translator.t('output.backgroundWhite')));

  const rotation = doc.createElement('select');
  rotation.className = 'ofd-select';
  for (const [value, text] of [
    ['current', translator.t('output.rotationCurrent')],
    ['0', '0°'],
    ['90', '90°'],
    ['180', '180°'],
    ['270', '270°'],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    rotation.append(option);
  }

  form.append(
    range.field,
    createOutputField(doc, translator.t('output.dpi'), dpi),
    backgroundLabel,
    createOutputField(doc, translator.t('output.rotation'), rotation),
  );

  const submit = (): void => {
    const pages = range.read(viewer.getState().document.pageCount);
    if (pages === null) return;
    shell.closeDialog(false);
    settle(
      viewer.print({
        pages,
        dpi: dpi.value === 'auto' ? 'auto' : Number(dpi.value),
        includeBackground: background.checked,
        rotation:
          rotation.value === 'current'
            ? 'current'
            : (Number(rotation.value) as Rotation),
      }),
      shell,
    );
  };
  // 表单内 Enter 与点击主按钮一致；必须阻止默认提交，避免页面导航丢文档。
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  shell.openDialog({
    name: 'print',
    title: translator.t('output.printTitle'),
    content: form,
    actions: [
      { label: translator.t('output.cancel') },
      {
        label: translator.t('toolbar.print'),
        primary: true,
        closeOnClick: false,
        onClick: submit,
      },
    ],
  });
}

/**
 * 打开导出选项对话框（图片或 OFD 原文件）。
 *
 * @param viewer 阅读器实例。
 * @param shell 当前外壳。
 */
function openExportDialog(viewer: UIShellHost, shell: UIShell): void {
  const doc = shell.root.ownerDocument;
  const translator = createTranslator(viewer.getState().ui.locale);
  const form = doc.createElement('form');
  form.className = 'ofd-output-form';
  form.setAttribute('aria-label', translator.t('output.exportTitle'));
  const range = createOutputRangeField(doc, translator);

  const format = doc.createElement('select');
  format.className = 'ofd-select';
  format.dataset.ofdControl = 'output-format';
  for (const value of ['png', 'jpeg', 'webp', 'ofd']) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent =
      value === 'ofd' ? translator.t('output.ofdFormat') : value.toUpperCase();
    format.append(option);
  }

  const dpi = doc.createElement('select');
  dpi.className = 'ofd-select';
  for (const [value, text] of [
    ['auto', translator.t('output.dpiAuto')],
    ['72', '72'],
    ['150', '150'],
    ['200', '200'],
    ['300', '300'],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    dpi.append(option);
  }

  const quality = doc.createElement('input');
  quality.type = 'range';
  quality.min = '0.1';
  quality.max = '1';
  quality.step = '0.01';
  quality.value = '0.92';
  quality.className = 'ofd-output-quality';

  const background = doc.createElement('select');
  background.className = 'ofd-select';
  for (const [value, text] of [
    ['transparent', translator.t('output.backgroundTransparent')],
    ['white', translator.t('output.backgroundWhite')],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    background.append(option);
  }

  const rotation = doc.createElement('select');
  rotation.className = 'ofd-select';
  for (const [value, text] of [
    ['0', '0°'],
    ['90', '90°'],
    ['180', '180°'],
    ['270', '270°'],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    rotation.append(option);
  }

  const dpiField = createOutputField(doc, translator.t('output.dpi'), dpi);
  const qualityField = createOutputField(doc, translator.t('output.quality'), quality);
  const backgroundField = createOutputField(doc, translator.t('output.background'), background);
  const rotationField = createOutputField(doc, translator.t('output.rotation'), rotation);
  const imageFields = [range.field, dpiField, qualityField, backgroundField, rotationField];
  const ofdNote = doc.createElement('p');
  ofdNote.className = 'ofd-output-note';
  ofdNote.dataset.ofdControl = 'output-ofd-note';
  ofdNote.hidden = true;
  ofdNote.textContent = translator.t('output.ofdHint');

  const updateFormat = (): void => {
    const ofd = format.value === 'ofd';
    for (const field of imageFields) {
      field.hidden = ofd;
      for (const control of field.querySelectorAll<HTMLElement>('select,input')) {
        (control as HTMLSelectElement | HTMLInputElement).disabled = ofd;
      }
    }
    ofdNote.hidden = !ofd;
    if (ofd) return;
    const supportsAlpha = format.value === 'png';
    background.disabled = !supportsAlpha;
    if (!supportsAlpha) background.value = 'white';
    quality.disabled = supportsAlpha;
  };
  format.addEventListener('change', updateFormat);

  form.append(
    range.field,
    createOutputField(doc, translator.t('output.format'), format),
    ofdNote,
    dpiField,
    qualityField,
    backgroundField,
    rotationField,
  );
  updateFormat();

  const submit = (): void => {
    if (format.value === 'ofd') {
      shell.closeDialog(false);
      settle(viewer.exportOfd({}), shell);
      return;
    }
    const pages = range.read(viewer.getState().document.pageCount);
    if (pages === null) return;
    const options: ExportImageOptions = {
      format: format.value as ExportImageOptions['format'],
      dpi: dpi.value === 'auto' ? 'auto' : Number(dpi.value),
      quality: Number(quality.value),
      background: background.value === 'transparent' ? null : '#ffffff',
      rotation: Number(rotation.value) as Rotation,
    };
    shell.closeDialog(false);
    if (pages === 'current') {
      settle(viewer.exportImage(options), shell);
    } else {
      settle(viewer.exportImages({ ...options, pages }), shell);
    }
  };
  // 与打印一致：Enter 触发 submit 时阻止默认导航，执行导出确认动作。
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  shell.openDialog({
    name: 'export',
    title: translator.t('output.exportTitle'),
    content: form,
    actions: [
      { label: translator.t('output.cancel') },
      {
        label: translator.t('toolbar.export'),
        primary: true,
        closeOnClick: false,
        onClick: submit,
      },
    ],
  });
}

/**
 * 将外壳命令映射到核心公开方法。
 *
 * @param viewer 阅读器实例。
 * @param shell 当前外壳。
 * @param command 外壳命令。
 */
function dispatchCommand(
  viewer: UIShellHost,
  shell: UIShell,
  command: UIShellCommand,
): void {
  switch (command.type) {
    case 'sidebar.toggle':
      settle(viewer.toggleSidebar(), shell);
      return;
    case 'sidebar.open':
      settle(viewer.openSidebar(command.view), shell);
      return;
    case 'sidebar.close':
      settle(viewer.closeSidebar(), shell);
      return;
    case 'page.go':
      settle(viewer.goToPage(command.page), shell);
      return;
    case 'page.next':
      settle(viewer.nextPage(), shell);
      return;
    case 'page.previous':
      settle(viewer.previousPage(), shell);
      return;
    case 'zoom.in':
      settle(viewer.zoomIn(), shell);
      return;
    case 'zoom.out':
      settle(viewer.zoomOut(), shell);
      return;
    case 'zoom.set':
      settle(
        typeof command.scale === 'number'
          ? viewer.setScale(command.scale)
          : viewer.setZoomMode(command.scale),
        shell,
      );
      return;
    case 'rotate.clockwise':
      settle(viewer.rotateClockwise(), shell);
      return;
    case 'find.open':
    case 'find.close':
      // 查找栏开关由外壳处理，核心无需感知。
      return;
    case 'find.query':
      if (command.query.length > 0) {
        settle(
          viewer.find(command.query, {
            caseSensitive: command.caseSensitive,
            wholeWord: command.wholeWord,
            highlightAll: command.highlightAll,
          }),
          shell,
        );
      } else {
        settle(viewer.clearFind(), shell);
      }
      return;
    case 'find.next':
      settle(viewer.findNext(), shell);
      return;
    case 'find.previous':
      settle(viewer.findPrevious(), shell);
      return;
    case 'find.clear':
      settle(viewer.clearFind(), shell);
      return;
    case 'print.open':
      openPrintDialog(viewer, shell);
      return;
    case 'export.open':
      openExportDialog(viewer, shell);
      return;
    case 'signatures.open':
      settle(viewer.openSidebar('signatures'), shell);
      return;
    case 'verification.open':
      settle(viewer.openVerificationPanel?.(), shell);
      return;
    case 'fullscreen.set':
      settle(viewer.setFullscreen(command.value), shell);
      return;
    case 'localFonts.set':
      if (viewer.setLocalFontsEnabled) settle(viewer.setLocalFontsEnabled(command.value), shell);
      return;
    case 'document.properties':
      showDocumentProperties(viewer, shell);
      return;
    case 'about.open':
      showAboutDialog(shell, viewer);
      return;
  }
}

/**
 * 为单个阅读器实例挂载内置 UI。
 *
 * @param viewer 阅读器实例。
 * @returns 清理函数；阅读器销毁时调用。
 */
export function attachUIShell(viewer: UIShellHost): () => void {
  const elements = viewer.getElements();
  const state = viewer.getState();
  let shell!: UIShell;
  shell = new UIShell({
    root: elements.root,
    elements,
    locale: state.ui.locale,
    theme: state.ui.theme,
    featureStates: state.ui.features,
    sidebarView: state.view.sidebarView,
    state: toShellState(state),
    manageViewport: false,
    manageSidebarVisibility: false,
    onCommand: (command) => dispatchCommand(viewer, shell, command),
  });
  uiShells.set(viewer, shell);

  /** 本地字体状态：由核心同源提供，面板与外壳共用一份（设计 §5.3）。 */
  let localFonts = viewer.getLocalFontsStatus?.();
  const sync = (): void => {
    const next = viewer.getState();
    shell.setFeatureStates(next.ui.features);
    shell.update(toShellState(next, localFonts));
  };


  const offs = [
    viewer.on('statechange', sync),
    viewer.on('featureschange', sync),
    viewer.on('sidebarviewchanged', sync),
    viewer.on('findstart', sync),
    viewer.on('findmatches', sync),
    viewer.on('findcurrent', sync),
    viewer.onLocalFontsStatusChange?.((status) => {
      localFonts = status;
      shell.update(toShellState(viewer.getState(), status));
    }) ?? (() => undefined),
  ];

  return () => {
    for (const off of offs) off();
    uiShells.delete(viewer);
    shell.destroy();
  };
}

/**
 * 注册内置 UI 扩展；最终入口在 t9 中调用一次。
 *
 * @param register 核心的扩展注册函数（`registerViewerExtension`）。
 */
export function installUIShell(register: UIShellExtensionRegistrar): void {
  register(attachUIShell);
}

export { UIShell } from './ui-shell';
export type { UIShellCommand, UIShellOptions, UIShellViewState } from './types';