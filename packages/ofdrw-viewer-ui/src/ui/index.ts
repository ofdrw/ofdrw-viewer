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
import type { ViewerState, Rotation, SidebarView, ZoomMode } from '../state';
import type {
  ExportImageOptions,
  ExportImagesOptions,
  PageRange,
  PrintOptions,
  ViewerEventHandler,
  ViewerEventName,
} from '../types';
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
  /** 进入/退出全屏。 */
  setFullscreen(value: boolean): unknown;
  /** 打开验证面板；未启用密码能力时省略。 */
  openVerificationPanel?(): unknown;
}

/** 扩展注册函数；`registerViewerExtension` 结构兼容。 */
export type UIShellExtensionRegistrar = (
  extension: (viewer: UIShellHost) => void | (() => void),
) => void;

/** 每个阅读器实例对应的 UI 外壳；供缩略图/打印/导出/签章模块挂载面板与对话框。 */
const uiShells = new WeakMap<UIShellHost, UIShell>();

/** 把核心状态投影为外壳所需的最小视图状态。 */
function toShellState(state: ViewerState): UIShellViewState {
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

/**
 * 打开文档属性对话框（纯展示，不修改文档）。
 *
 * @param viewer 阅读器实例。
 * @param shell 当前外壳。
 */
function showDocumentProperties(viewer: UIShellHost, shell: UIShell): void {
  const { document: documentState } = viewer.getState();
  const translator = shell.translatorInstance;
  const doc = shell.elements.root.ownerDocument;
  const metadata = documentState.metadata;

  const list = doc.createElement('dl');
  list.className = 'ofd-properties';
  const rows: readonly (readonly [string, string | undefined])[] = [
    [translator.t('properties.version'), metadata?.version],
    [translator.t('properties.pageCount'), String(documentState.pageCount)],
    [
      translator.t('properties.fileSize'),
      metadata?.packageSize === undefined
        ? undefined
        : `${translator.formatNumber(metadata.packageSize / 1024, {
            maximumFractionDigits: 1,
          })} KB`,
    ],
    [translator.t('properties.title'), metadata?.title],
    [translator.t('properties.author'), metadata?.author],
    [translator.t('properties.subject'), metadata?.subject],
    [translator.t('properties.keywords'), metadata?.keywords?.join(', ')],
    [translator.t('properties.creator'), metadata?.creator],
    [translator.t('properties.creationDate'), metadata?.creationDate],
    [translator.t('properties.modDate'), metadata?.modDate],
    [translator.t('properties.docId'), metadata?.docId],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    const term = doc.createElement('dt');
    term.textContent = label;
    const description = doc.createElement('dd');
    description.textContent = value;
    list.append(term, description);
  }

  shell.openDialog({
    name: 'documentProperties',
    title: translator.t('toolbar.documentProperties'),
    content: list,
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

/**
 * 创建打印/导出共用的页码范围控件。
 *
 * @param doc 对话框所属文档。
 * @param translator 翻译器。
 * @returns 字段元素与读取函数；读取失败时在字段内显示错误。
 */
function createOutputRangeField(
  doc: Document,
  translator: Translator,
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
  const range = createOutputRangeField(doc, translator);

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
 * 打开导出图片选项对话框。
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
  for (const value of ['png', 'jpeg', 'webp']) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = value.toUpperCase();
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

  const updateFormat = (): void => {
    const supportsAlpha = format.value === 'png';
    background.disabled = !supportsAlpha;
    if (!supportsAlpha) background.value = 'white';
    quality.disabled = supportsAlpha;
  };
  format.addEventListener('change', updateFormat);
  updateFormat();

  form.append(
    range.field,
    createOutputField(doc, translator.t('output.format'), format),
    createOutputField(doc, translator.t('output.dpi'), dpi),
    createOutputField(doc, translator.t('output.quality'), quality),
    createOutputField(doc, translator.t('output.background'), background),
    createOutputField(doc, translator.t('output.rotation'), rotation),
  );

  const submit = (): void => {
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
    case 'document.properties':
      showDocumentProperties(viewer, shell);
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

  const sync = (): void => {
    const next = viewer.getState();
    shell.setFeatureStates(next.ui.features);
    shell.update(toShellState(next));
  };
  const offs = [
    viewer.on('statechange', sync),
    viewer.on('featureschange', sync),
    viewer.on('sidebarviewchanged', sync),
    viewer.on('findstart', sync),
    viewer.on('findmatches', sync),
    viewer.on('findcurrent', sync),
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