/**
 * 内置解密凭据弹窗（设计 §6.3）。
 *
 * 只收集用户名与口令/私钥，不把凭据写入阅读器状态、存储或日志；关闭时清空
 * 输入引用与文件字节。解密失败保留弹窗与用户选择，允许重试或取消。
 */

import type { CryptoCredential, OfdInspection } from '@ofdrw/ofdrw-viewer-crypto';
import type { UIShell } from '../ui/ui-shell';
import { describeCredentialError } from './service';
import type { CryptoText } from './text';

/** 弹窗选项。 */
export interface CredentialDialogOptions {
  /** 内置 UI 外壳。 */
  readonly shell: UIShell;
  /** 检测结果，用于列出用户。 */
  readonly inspection: OfdInspection;
  /** 文案。 */
  readonly text: CryptoText;
  /** 提交凭据；抛错时弹窗显示错误并允许重试。 */
  readonly onSubmit: (credential: CryptoCredential) => Promise<void>;
  /** 取消/关闭。 */
  readonly onCancel: () => void;
}

/** 凭据模式。 */
type CredentialMode = 'password' | 'private-key';

/** 弹窗实例序号，用于生成同一文档内稳定且唯一的控件 id。 */
let credentialDialogSequence = 0;

/**
 * 解密凭据弹窗。
 */
export class CredentialDialog {
  private readonly doc: Document;
  private readonly idPrefix: string;
  private dialog: HTMLElement | null = null;
  private userSelect: HTMLSelectElement | null = null;
  private passwordInput: HTMLInputElement | null = null;
  private keyInput: HTMLInputElement | null = null;
  private passphraseInput: HTMLInputElement | null = null;
  private modeRadios: readonly [HTMLInputElement, HTMLInputElement] | null = null;
  private fieldsContainer: HTMLElement | null = null;
  private errorBox: HTMLElement | null = null;
  private statusBox: HTMLElement | null = null;
  private submitButton: HTMLButtonElement | null = null;
  private mode: CredentialMode = 'password';
  private keyBytes: Uint8Array | null = null;
  private keyName = '';
  private loading = false;
  private closed = false;

  /**
   * @param options 宿主、检测结果与回调。
   */
  constructor(private readonly options: CredentialDialogOptions) {
    this.doc = options.shell.root.ownerDocument;
    credentialDialogSequence += 1;
    this.idPrefix = `ofd-credential-${credentialDialogSequence}`;
  }

  /** 打开弹窗。 */
  open(): void {
    const { shell, text } = this.options;
    if (this.closed) return;
    const body = this.buildBody();
    this.dialog = shell.openDialog({
      name: 'credential',
      title: text.credentialTitle,
      description: text.credentialDescription,
      content: body,
      actions: [
        {
          label: text.credentialCancel,
          onClick: () => {
            // 关闭动作由对话框管理器完成；onClose 统一走取消。
          },
        },
        {
          label: text.credentialSubmit,
          primary: true,
          closeOnClick: false,
          onClick: () => {
            void this.submit();
          },
        },
      ],
      onClose: () => this.handleClose(),
    });
    this.submitButton = this.dialog.querySelector<HTMLButtonElement>(
      '.ofd-dialog__action--primary',
    );
    this.updateSubmitState();
    this.userSelect?.focus();
  }

  /**
   * 显示错误。
   *
   * @param message 面向用户的错误文本。
   */
  showError(message: string): void {
    if (!this.errorBox) return;
    this.errorBox.textContent = message;
    this.errorBox.hidden = false;
  }

  /** 关闭弹窗。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.shell.closeDialog(false);
    this.clearSecrets();
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  /** 构建弹窗主体。 */
  private buildBody(): HTMLElement {
    const { text, inspection } = this.options;
    const root = this.doc.createElement('form');
    root.className = 'ofd-credential-form';
    root.setAttribute('aria-label', text.credentialTitle);
    root.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });

    const users = inspection.users;
    if (users.length > 1) {
      const userId = `${this.idPrefix}-user`;
      const field = this.createField(text.credentialUser, userId);
      this.userSelect = this.doc.createElement('select');
      this.userSelect.id = userId;
      this.userSelect.className = 'ofd-select';
      this.userSelect.dataset.ofdControl = 'crypto-credential-user';
      const placeholder = this.doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = text.credentialUserPlaceholder;
      placeholder.disabled = true;
      placeholder.selected = true;
      this.userSelect.appendChild(placeholder);
      for (const user of users) {
        const option = this.doc.createElement('option');
        option.value = user.userName;
        option.textContent = `${user.userName}（${this.methodLabel(user.method)}）`;
        this.userSelect.appendChild(option);
      }
      this.userSelect.addEventListener('change', () => this.handleUserChange());
      field.append(this.userSelect);
      root.appendChild(field);
    } else if (users.length === 1) {
      const field = this.createField(text.credentialUser);
      const name = this.doc.createElement('p');
      name.className = 'ofd-credential-form__user';
      name.dataset.ofdControl = 'crypto-credential-user-name';
      name.textContent = users[0]!.userName;
      field.append(name);
      root.appendChild(field);
      this.mode = users[0]!.method === 'certificate' ? 'private-key' : 'password';
    } else {
      this.mode = 'password';
    }

    const hasPassword = users.length === 0 || users.some((user) => user.method !== 'certificate');
    const hasPrivateKey = users.length === 0 || users.some((user) => user.method !== 'password');

    if (hasPassword && hasPrivateKey) {
      const modes = this.createField(text.credentialMode);
      const groupLabel = modes.querySelector<HTMLElement>('.ofd-credential-form__label')!;
      groupLabel.id = `${this.idPrefix}-mode-label`;
      const wrap = this.doc.createElement('div');
      wrap.className = 'ofd-credential-form__modes';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-labelledby', groupLabel.id);
      const passwordRadio = this.createRadio('password');
      const keyRadio = this.createRadio('private-key');
      passwordRadio.checked = this.mode === 'password';
      keyRadio.checked = this.mode === 'private-key';
      const sync = (): void => {
        this.mode = keyRadio.checked ? 'private-key' : 'password';
        this.clearInputs();
        this.renderFields();
      };
      passwordRadio.addEventListener('change', sync);
      keyRadio.addEventListener('change', sync);
      const passwordLabel = this.doc.createElement('label');
      passwordLabel.className = 'ofd-credential-form__mode';
      passwordLabel.htmlFor = passwordRadio.id;
      passwordLabel.textContent = text.credentialPassword;
      const keyLabel = this.doc.createElement('label');
      keyLabel.className = 'ofd-credential-form__mode';
      keyLabel.htmlFor = keyRadio.id;
      keyLabel.textContent = text.credentialPrivateKey;
      wrap.append(passwordRadio, passwordLabel, keyRadio, keyLabel);
      this.modeRadios = [passwordRadio, keyRadio];
      modes.append(wrap);
      root.appendChild(modes);
    }

    const fields = this.doc.createElement('div');
    fields.className = 'ofd-credential-form__fields';
    root.appendChild(fields);
    this.fieldsContainer = fields;

    const error = this.doc.createElement('p');
    error.className = 'ofd-credential-form__error';
    error.dataset.ofdControl = 'crypto-credential-error';
    error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'assertive');
    error.hidden = true;
    root.appendChild(error);
    this.errorBox = error;

    const status = this.doc.createElement('p');
    status.className = 'ofd-credential-form__status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    root.appendChild(status);
    this.statusBox = status;

    this.renderFields();
    return root;
  }

  /** 按当前模式渲染字段。 */
  private renderFields(): void {
    const fields =
      this.fieldsContainer ??
      this.dialog?.querySelector<HTMLElement>('.ofd-credential-form__fields') ??
      null;
    if (!fields) return;
    this.fieldsContainer = fields;
    this.populateFields(fields);
  }

  /** 填充字段。 */
  private populateFields(fields: HTMLElement): void {
    const { text } = this.options;
    fields.replaceChildren();
    this.passwordInput = null;
    this.keyInput = null;
    this.passphraseInput = null;
    if (this.mode === 'password') {
      const passwordId = `${this.idPrefix}-password`;
      const field = this.createField(text.credentialPassword, passwordId);
      const input = this.doc.createElement('input');
      input.id = passwordId;
      input.type = 'password';
      input.className = 'ofd-input';
      input.autocomplete = 'off';
      input.dataset.ofdControl = 'crypto-credential-password';
      input.addEventListener('input', () => this.updateSubmitState());
      field.append(input);
      fields.appendChild(field);
      this.passwordInput = input;
    } else {
      const keyId = `${this.idPrefix}-key`;
      const field = this.createField(text.credentialPrivateKey, keyId);
      const input = this.doc.createElement('input');
      input.id = keyId;
      input.type = 'file';
      input.className = 'ofd-input';
      input.accept = '.pem,.der,.key,.pk8';
      input.dataset.ofdControl = 'crypto-credential-key';
      input.addEventListener('change', () => {
        void this.handleKeyFile(input);
      });
      const hint = this.doc.createElement('p');
      hint.id = `${this.idPrefix}-key-hint`;
      hint.className = 'ofd-credential-form__hint';
      hint.textContent = text.credentialPrivateKeyHint;
      input.setAttribute('aria-describedby', hint.id);
      field.append(input, hint);
      fields.appendChild(field);
      this.keyInput = input;

      const passphraseId = `${this.idPrefix}-passphrase`;
      const passField = this.createField(text.credentialPassphrase, passphraseId);
      const passphrase = this.doc.createElement('input');
      passphrase.id = passphraseId;
      passphrase.type = 'password';
      passphrase.className = 'ofd-input';
      passphrase.autocomplete = 'off';
      passphrase.dataset.ofdControl = 'crypto-credential-passphrase';
      passField.append(passphrase);
      fields.appendChild(passField);
      this.passphraseInput = passphrase;
    }
    this.updateSubmitState();
  }

  /**
   * 创建字段容器。
   *
   * 有对应控件时使用 `<label htmlFor>` 建立显式关联；纯分组标题使用
   * `<span>`，避免出现未关联控件的空 label。
   *
   * @param labelText 字段标题。
   * @param controlId 控件 id；省略时按分组标题渲染。
   * @returns 字段容器。
   */
  private createField(labelText: string, controlId?: string): HTMLElement {
    const field = this.doc.createElement('div');
    field.className = 'ofd-credential-form__field';
    const label = this.doc.createElement(controlId ? 'label' : 'span');
    label.className = 'ofd-credential-form__label';
    label.textContent = labelText;
    if (controlId) label.setAttribute('for', controlId);
    field.appendChild(label);
    return field;
  }

  /** 创建单选项。 */
  private createRadio(value: CredentialMode): HTMLInputElement {
    const radio = this.doc.createElement('input');
    radio.id = `${this.idPrefix}-mode-${value}`;
    radio.type = 'radio';
    radio.name = 'ofd-credential-mode';
    radio.value = value;
    radio.dataset.ofdControl = `crypto-credential-mode-${value}`;
    radio.addEventListener('change', () => this.updateSubmitState());
    return radio;
  }

  /** 用户切换时清空凭据。 */
  private handleUserChange(): void {
    this.clearInputs();
    this.hideError();
    const user = this.options.inspection.users.find(
      (candidate) => candidate.userName === this.userSelect?.value,
    );
    if (user) this.mode = user.method === 'certificate' ? 'private-key' : 'password';
    if (this.modeRadios) {
      this.modeRadios[0].checked = this.mode === 'password';
      this.modeRadios[1].checked = this.mode === 'private-key';
    }
    this.renderFields();
  }

  /** 读取私钥文件；只在本次弹窗内保存字节。 */
  private async handleKeyFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    this.keyBytes = null;
    this.keyName = '';
    this.hideError();
    if (!file) {
      this.updateSubmitState();
      return;
    }
    if (!/\.(pem|der|key|pk8)$/i.test(file.name)) {
      this.showError(this.options.text.credentialKeyRequired);
      input.value = '';
      this.updateSubmitState();
      return;
    }
    try {
      this.keyBytes = new Uint8Array(await file.arrayBuffer());
      this.keyName = file.name;
    } catch {
      this.showError(this.options.text.credentialPrivateKeyInvalid);
      input.value = '';
    }
    this.updateSubmitState();
  }

  /** 提交。 */
  private async submit(): Promise<void> {
    if (this.loading || this.closed) return;
    const credential = this.collect();
    if (!credential) {
      this.updateSubmitState(true);
      return;
    }
    this.hideError();
    this.setLoading(true);
    try {
      await this.options.onSubmit(credential);
    } catch (error) {
      if (!this.closed) this.showError(describeCredentialError(error, this.options.text));
    } finally {
      if (!this.closed) this.setLoading(false);
    }
  }

  /** 读取并校验当前输入。 */
  private collect(): CryptoCredential | null {
    const { text, inspection } = this.options;
    const users = inspection.users;
    let userName: string | undefined;
    if (users.length > 1) {
      const value = this.userSelect?.value ?? '';
      if (!value) {
        this.showError(text.credentialUserRequired);
        return null;
      }
      userName = value;
    } else if (users.length === 1) {
      userName = users[0]!.userName;
    }

    if (this.mode === 'password') {
      const password = this.passwordInput?.value ?? '';
      if (password.length === 0) {
        this.showError(text.credentialPasswordRequired);
        return null;
      }
      return { kind: 'password', ...(userName ? { userName } : {}), password };
    }

    if (!this.keyBytes) {
      this.showError(text.credentialKeyRequired);
      return null;
    }
    const passphrase = this.passphraseInput?.value ?? '';
    // `.key`/`.pk8` 既可能是 PEM 也可能是 DER，按内容而不是扩展名判断。
    const key = isPemBytes(this.keyBytes)
      ? { pem: new TextDecoder().decode(this.keyBytes) }
      : { der: this.keyBytes };
    return {
      kind: 'private-key',
      ...(userName ? { userName } : {}),
      privateKey: { ...key, ...(passphrase ? { passphrase } : {}) },
    };
  }

  /** 更新提交按钮可用状态。 */
  private updateSubmitState(forceValidation = false): void {
    if (!this.submitButton) return;
    const users = this.options.inspection.users;
    const hasUser = users.length !== 1 || Boolean(users[0]?.userName);
    const hasSecret =
      this.mode === 'password'
        ? Boolean(this.passwordInput?.value)
        : Boolean(this.keyBytes);
    const disabled = this.loading || !hasUser || !hasSecret;
    this.submitButton.disabled = disabled;
    if (forceValidation && !hasUser) this.showError(this.options.text.credentialUserRequired);
  }

  /** 设置 loading 状态。 */
  private setLoading(loading: boolean): void {
    this.loading = loading;
    const disabled = loading;
    for (const element of [
      this.userSelect,
      this.passwordInput,
      this.keyInput,
      this.passphraseInput,
    ]) {
      if (element) element.disabled = disabled;
    }
    for (const radio of this.modeRadios ?? []) radio.disabled = disabled;
    if (this.submitButton) {
      this.submitButton.textContent = loading
        ? this.options.text.credentialLoading
        : this.options.text.credentialSubmit;
      if (loading) this.submitButton.disabled = true;
    }
    if (this.statusBox) {
      this.statusBox.textContent = loading ? this.options.text.credentialLoading : '';
      this.statusBox.hidden = !loading;
    }
    this.dialog?.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (!loading) this.updateSubmitState();
  }

  /** 隐藏错误。 */
  private hideError(): void {
    if (!this.errorBox) return;
    this.errorBox.textContent = '';
    this.errorBox.hidden = true;
  }

  /** 关闭回调。 */
  private handleClose(): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.clearSecrets();
    if (!wasClosed) this.options.onCancel();
  }

  /** 清空输入引用与文件字节。 */
  private clearSecrets(): void {
    this.passwordInput?.remove?.();
    if (this.passwordInput) this.passwordInput.value = '';
    if (this.passphraseInput) this.passphraseInput.value = '';
    if (this.keyInput) this.keyInput.value = '';
    this.keyBytes = null;
    this.keyName = '';
    this.passwordInput = null;
    this.passphraseInput = null;
    this.keyInput = null;
    this.userSelect = null;
    this.modeRadios = null;
    this.errorBox = null;
    this.statusBox = null;
    this.submitButton = null;
    this.dialog = null;
  }

  /** 清空当前输入，保留字段结构。 */
  private clearInputs(): void {
    if (this.passwordInput) this.passwordInput.value = '';
    if (this.passphraseInput) this.passphraseInput.value = '';
    if (this.keyInput) this.keyInput.value = '';
    this.keyBytes = null;
    this.keyName = '';
    this.updateSubmitState();
  }

  /** 凭据方式文案。 */
  private methodLabel(method: 'password' | 'certificate' | 'unknown'): string {
    const { text } = this.options;
    if (method === 'password') return text.methodPassword;
    if (method === 'certificate') return text.methodCertificate;
    return text.methodUnknown;
  }
}
/**
 * 判断私钥字节是否为 PEM 文本。
 *
 * @param bytes 私钥文件字节。
 * @returns 以 `-----BEGIN` 开头时为 true。
 */
function isPemBytes(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart();
  return head.startsWith('-----BEGIN ');
}
