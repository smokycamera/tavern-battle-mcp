import { randomId } from '../../host/src/browser-compat.js';

export interface McpUiOptions {
  roots(): HTMLElement[];
  context(): string;
  busy(): boolean;
  help(): unknown;
  prepare(input: Record<string, unknown>): unknown;
  game?: { handle(operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>> };
}
export interface McpCommand {
  id: string;
  operation: string;
  args: Record<string, unknown>;
  expiresAt: number;
}
const controls = 'button,[data-action],input,select,textarea,summary,a[href],[role="button"],[tabindex="0"]';
const secretActions = new Set(['llm-settings-backup']);
const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Reflect only the rendered player surface. Never serialize HTML, stores or engine objects. */
export class McpPlayerUi {
  private ids = new WeakMap<Element, string>();
  private elements = new Map<string, HTMLElement>();
  private signature = '';
  private viewId = randomId();
  private running = false;
  constructor(private options: McpUiOptions) {}

  private visible(el: Element): boolean {
    if (!el.isConnected || el.closest('[data-mcp-private],script,style,template,input[type="hidden"]')) return false;
    const win = el.ownerDocument.defaultView;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false;
      const style = win?.getComputedStyle(node);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      if (node.tagName === 'DETAILS' && !node.hasAttribute('open')) {
        const summary = node.querySelector(':scope > summary');
        if (!summary?.contains(el)) return false;
      }
    }
    return true;
  }
  private text(root: HTMLElement): string {
    const parts: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === 3) { if (node.textContent?.trim()) parts.push(node.textContent); return; }
      if (node.nodeType !== 1) return;
      const el = node as HTMLElement;
      if (!this.visible(el) || ['INPUT', 'TEXTAREA', 'SELECT', 'SVG'].includes(el.tagName) || secretActions.has(el.dataset.action ?? '')) return;
      for (const child of el.childNodes) walk(child);
    };
    walk(root);
    return compact(parts.join(' '));
  }
  private id(el: HTMLElement): string {
    let id = this.ids.get(el);
    if (!id) { id = 'c-' + randomId(); this.ids.set(el, id); }
    return id;
  }
  private disabled(el: HTMLElement): boolean {
    return el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset[disabled]');
  }
  private describe(el: HTMLElement) {
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const sensitive = tag === 'input' && input.type === 'password';
    const labels = (input.labels ? Array.from(input.labels) : []).map(label => {
      // A wrapping label may contain an entire select or a large editor.
      return compact(Array.from(label.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' '));
    }).filter(Boolean).join(' ');
    const label = el.getAttribute('aria-label') || labels || this.text(el) || el.getAttribute('title') || input.placeholder || tag;
    const dataKeys = ['action','role','id','unit','target','cell','tab','mode','node','index','j','i','section','field','entry'] as const;
    const data = Object.fromEntries(dataKeys.flatMap(key => el.dataset[key] === undefined ? [] : [[key, el.dataset[key]]])) as Partial<Record<typeof dataKeys[number], string>>;
    return {
      controlId: this.id(el), tag, label: label.slice(0, 600), ...data,
      ...(el.dataset.unitIds !== undefined ? { unitIds: JSON.parse(el.dataset.unitIds) as string[], acting: el.dataset.acting === 'true', selected: el.dataset.selected === 'true', coordinate: el.dataset.coordinate } : {}),
      ...(el.title ? { title: el.title.slice(0, 1200) } : {}),
      disabled: this.disabled(el),
      ...(tag === 'input' ? { type: input.type, readOnly: input.readOnly, ...(sensitive ? { value: '[redacted]' } : { value: input.value }), ...(['checkbox','radio'].includes(input.type) ? { checked: input.checked } : {}), ...(input.min ? { min: input.min } : {}), ...(input.max ? { max: input.max } : {}), ...(input.step ? { step: input.step } : {}) } : {}),
      ...(tag === 'textarea' ? { value: input.value, readOnly: input.readOnly } : {}),
      ...(tag === 'select' ? { value: (el as HTMLSelectElement).multiple ? Array.from((el as HTMLSelectElement).options).filter(o => o.selected).map(o => o.value) : input.value, multiple: (el as HTMLSelectElement).multiple, options: Array.from((el as HTMLSelectElement).options, o => ({ value: o.value, label: o.text, disabled: o.disabled || o.parentElement?.matches('optgroup:disabled') === true })) } : {}),
      ...(tag === 'summary' ? { expanded: el.parentElement?.hasAttribute('open') } : {}),
    };
  }
  observe(args: Record<string, unknown> = {}) {
    const roots = this.options.roots();
    const visible = roots.flatMap(root => [...(root.matches(controls) ? [root] : []), ...root.querySelectorAll<HTMLElement>(controls)]).filter(el => this.visible(el) && !secretActions.has(el.dataset.action ?? ''));
    const all = [...new Set(visible)].map(el => { this.elements.set(this.id(el), el); return this.describe(el); });
    const liveIds = new Set(all.map(el => el.controlId));
    for (const id of this.elements.keys()) if (!liveIds.has(id)) this.elements.delete(id);
    const text = roots.map(root => this.text(root)).filter(Boolean).join('\n');
    const current = roots.flatMap(root => [...root.querySelectorAll<HTMLElement>('[data-current-unit]')]).find(el => this.visible(el));
    const activeUnit = current ? { id: current.dataset.currentUnit, pos: Number(current.dataset.currentPosition), cell: current.dataset.currentCoordinate } : undefined;
    const panelVisible = roots.some(root => root.id === 'app');
    const toast = document.querySelector<HTMLElement>('#toast');
    const feedback = panelVisible && toast && this.visible(toast) ? toast.textContent ?? '' : '';
    const saveStatus = panelVisible ? document.querySelector<HTMLElement>('[data-role="save-status"]')?.textContent ?? '' : '';
    const busy = this.options.busy();
    const signature = JSON.stringify([this.options.context(), text, all, busy, saveStatus]);
    if (signature !== this.signature) { this.signature = signature; this.viewId = randomId(); }
    const offset = Number.isInteger(args.offset) ? Math.max(0, Number(args.offset)) : 0;
    const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(500, Number(args.limit))) : 200;
    const textOffset = Number.isInteger(args.textOffset) ? Math.max(0, Number(args.textOffset)) : 0;
    return { viewId: this.viewId, perspective: 'player', activeUnit, busy, saveStatus, feedback, text: text.slice(textOffset, textOffset + 20000), textLength: text.length,
      textOffset, nextTextOffset: textOffset + 20000 < text.length ? textOffset + 20000 : null,
      controls: all.slice(offset, offset + limit), totalControls: all.length, offset, nextOffset: offset + limit < all.length ? offset + limit : null };
  }
  private guard(args: Record<string, unknown>, operation: string): void {
    const current = this.observe();
    if (args.viewId !== current.viewId) throw Error('界面或聊天已变化，请重新 battle_observe 后再操作');
    const el = this.elements.get(String(args.controlId));
    const navigation = operation === 'click' && ['workspace-tab','llm-stop','ai-scan-cancel','modal-stop'].includes(el?.dataset.action ?? '');
    const pauseAuto = el?.dataset.role === 'full-auto-battle' && (el as HTMLInputElement).checked && (operation === 'click' || operation === 'fill' && args.value === false);
    if (current.busy && !navigation && !pauseAuto) throw Error('本体正在处理操作，请稍后重新观察');
  }
  private target(args: Record<string, unknown>): HTMLElement {
    const el = this.elements.get(String(args.controlId));
    if (!el || !this.visible(el)) throw Error('控件不再可见，请重新观察');
    if (this.disabled(el)) throw Error('此控件当前禁用，请遵守界面规则');
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'password') throw Error('凭证由玩家在本地设置');
    return el;
  }
  private event(el: HTMLElement, type: string): void {
    const win = el.ownerDocument.defaultView!;
    el.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event(type, { bubbles: true }));
  }
  private fill(el: HTMLElement, value: unknown): void {
    if (!['INPUT','SELECT','TEXTAREA'].includes(el.tagName)) throw Error('请选择表单控件');
    const input = el as HTMLInputElement;
    if (input.readOnly) throw Error('此字段只读');
    if (el.tagName === 'SELECT') {
      const select = el as HTMLSelectElement;
      if (!(typeof value === 'string' || select.multiple && Array.isArray(value) && value.every(v => typeof v === 'string'))) throw Error('选择值必须为字符串，多选可以用数组');
      const values = Array.isArray(value) ? value : [value];
      if (values.some(v => !Array.from(select.options).some(o => o.value === v && !o.disabled && !o.parentElement?.matches('optgroup:disabled')))) throw Error('不存在或禁用的选项');
      for (const option of select.options) option.selected = values.includes(option.value);
      this.event(el, 'input'); this.event(el, 'change'); return;
    }
    if (['checkbox','radio'].includes(input.type)) {
      if (typeof value !== 'boolean') throw Error('勾选值必须为布尔');
      if (input.type === 'radio' && !value) throw Error('请选择另一个单选项');
      if (input.checked !== value) input.click();
      return;
    }
    if (['file','button','submit','reset','image','hidden','password'].includes(input.type)) throw Error('不支持此输入类型');
    if (typeof value !== 'string' || value.length > 100000) throw Error('文本须为不超过100000字符的字符串');
    const previous = input.value; input.value = value;
    if (input.type === 'number' && value !== '' && (input.value === '' || !Number.isFinite(Number(value))) || !input.checkValidity()) {
      input.value = previous; throw Error('输入不符合字段的类型、范围或格式要求');
    }
    this.event(el, 'input');
    // Input handlers can rerender the form. Never dispatch into a detached, obsolete form.
    if (el.isConnected) this.event(el, 'change');
  }
  private click(el: HTMLElement): void {
    if (['INPUT','SELECT','TEXTAREA'].includes(el.tagName) && !['checkbox','radio','button','submit'].includes((el as HTMLInputElement).type)) throw Error('请使用 battle_fill 填写字段');
    if (el.tagName === 'A') throw Error('此链接需要在浏览器打开；MCP 只操作插件控件');
    el.click();
  }
  private upload(el: HTMLElement, args: Record<string, unknown>): void {
    if (el.tagName !== 'INPUT' || (el as HTMLInputElement).type !== 'file') throw Error('请选择当前可见的文件输入控件');
    if (typeof args.content !== 'string' || args.content.length > 1000000 || typeof args.filename !== 'string' || !/^[^\\/\x00-\x1f]{1,120}\.json$/i.test(args.filename)) throw Error('仅接受不超过1000000字符的 JSON 文件，文件名不能包含路径');
    JSON.parse(args.content);
    const win = el.ownerDocument.defaultView! as unknown as { DataTransfer: typeof DataTransfer; File: typeof File };
    const transfer = new win.DataTransfer();
    transfer.items.add(new win.File([args.content], args.filename, { type: 'application/json' }));
    (el as HTMLInputElement).files = transfer.files;
    this.event(el, 'change');
  }
  private key(el: HTMLElement, key: string, shift: boolean): void {
    const supported = ['Enter',' ','Escape','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'];
    if (!supported.includes(key)) throw Error('不支持此按键');
    el.focus();
    const win = el.ownerDocument.defaultView! as unknown as { KeyboardEvent: typeof KeyboardEvent };
    const accepted = el.dispatchEvent(new win.KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }));
    if (accepted) {
      if ((key === 'Enter' || key === ' ') && el.matches('button,summary,[role="button"],input[type="checkbox"],input[type="radio"]')) this.click(el);
      else if (key === 'Tab') {
        const list = [...this.elements.values()].filter(e => !this.disabled(e));
        const index = list.indexOf(el), next = (index + (shift ? -1 : 1) + list.length) % list.length;
        list[next]?.focus();
      } else if (el.tagName === 'SELECT' && ['ArrowUp','ArrowDown','Home','End'].includes(key)) {
        const select = el as HTMLSelectElement, choices = Array.from(select.options).filter(o => !o.disabled && !o.parentElement?.matches('optgroup:disabled'));
        const index = choices.findIndex(o => o.value === select.value);
        const next = key === 'Home' ? 0 : key === 'End' ? choices.length - 1 : Math.min(choices.length - 1, Math.max(0, index + (key === 'ArrowUp' ? -1 : 1)));
        if (choices[next]) this.fill(el, choices[next]!.value);
      }
    }
    el.dispatchEvent(new win.KeyboardEvent('keyup', { key, shiftKey: shift, bubbles: true }));
  }
  async execute(command: McpCommand): Promise<Record<string, unknown>> {
    if (this.running) return { error: '此面板正在处理 MCP 操作' };
    this.running = true;
    try {
      if (Date.now() > command.expiresAt) throw Error('操作已过期，未执行');
      if (command.operation.startsWith('game_')) {
        if (!this.options.game) throw Error('此面板尚不支持游戏接口，请更新战斗插件的 test 分支');
        return await this.options.game.handle(command.operation, command.args);
      }
      if (command.operation === 'observe') return this.observe(command.args);
      if (command.operation === 'help') return { rules: this.options.help() };
      this.guard(command.args, command.operation);
      const context = this.options.context();
      let backgroundControl = false;
      if (command.operation === 'prepare') this.options.prepare(command.args);
      else {
        const el = this.target(command.args);
        backgroundControl = el.dataset.role === 'full-auto-battle';
        if (command.operation === 'click') this.click(el);
        else if (command.operation === 'fill') this.fill(el, command.args.value);
        else if (command.operation === 'upload') this.upload(el, command.args);
        else if (command.operation === 'key') this.key(el, String(command.args.key), command.args.shift === true);
        else throw Error('未知操作');
      }
      const deadline = Math.min(Date.now() + 12000, command.expiresAt - 1000);
      do { await delay(30); } while (!backgroundControl && this.options.busy() && Date.now() < deadline);
      // Context includes archive revision. A normal write can change it: report the latest view,
      // but never perform a second action against that new context.
      return { dispatched: true, contextChanged: context !== this.options.context(), ...this.observe() };
    } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    finally { this.running = false; }
  }
}
