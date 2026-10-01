import { escapeHtml as esc } from './battle-presentation.js';
import { McpPlayerUi, type McpCommand, type McpUiOptions } from './mcp-ui.js';

interface Connection { url: string; token: string }

/** Opt-in, session-only pairing. No fetch/timer/store access until the user connects. */
export class McpPanelBridge {
  private connection?: Connection;
  private sessionId?: string;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private aborter?: AbortController;
  private status = '未连接（默认关闭）';
  private player: McpPlayerUi;
  constructor(options: McpUiOptions, private changed: () => void) { this.player = new McpPlayerUi(options); }
  render(): string {
    return `<section data-mcp-private><h2>MCP 玩家操作</h2><p>允许 ChatGPT、Dots 或其他 MCP 客户端操作当前战阵面板。沿用玩家可见信息、按钮与战斗规则。关闭连接后可继续手动操作。</p><label>桥接地址 <input data-mcp-url value="${esc(this.connection?.url ?? 'http://127.0.0.1:8766')}" placeholder="http://127.0.0.1:8766"></label><label>配对密钥 <input data-mcp-token type="password" autocomplete="off" value="${esc(this.connection?.token ?? '')}"></label><div class="row"><button data-mcp-connect>连接 MCP</button><button data-mcp-disconnect ${this.connection ? '' : 'disabled'}>断开 MCP</button></div><p data-mcp-status role="status">${esc(this.status)}</p><p class="sub">当前页面来源：<code>${esc(location.origin)}</code>（VPS 的允许来源填写此值）</p><p class="sub">先运行仓库的 mcp 服务，再填写终端显示的密钥。只在当前页面主动连接，不自动恢复连接。</p></section>`;
  }
  install(): () => void {
    const onClick = (event: MouseEvent) => {
      const el = event.target instanceof Element ? event.target.closest('[data-mcp-connect],[data-mcp-disconnect]') : null;
      if (!el) return;
      event.stopImmediatePropagation();
      if (el.hasAttribute('data-mcp-disconnect')) { this.disconnect(); return; }
      const section = el.closest('[data-mcp-private]')!;
      const url = section.querySelector<HTMLInputElement>('[data-mcp-url]')!.value;
      const token = section.querySelector<HTMLInputElement>('[data-mcp-token]')!.value;
      void this.connect(url, token);
    };
    document.addEventListener('click', onClick, true);
    const stop = () => this.disconnect();
    window.addEventListener('pagehide', stop);
    return () => { stop(); document.removeEventListener('click', onClick, true); window.removeEventListener('pagehide', stop); };
  }
  private report(value: string): void {
    this.status = value;
    const el = document.querySelector<HTMLElement>('[data-mcp-status]');
    if (el) el.textContent = value;
  }
  private async post(path: string, data: unknown, connection = this.connection, signal?: AbortSignal) {
    if (!connection) throw Error('MCP 已断开');
    const res = await fetch(connection.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + connection.token }, body: JSON.stringify(data), signal });
    if (!res.ok) throw Error('桥接返回 ' + res.status + '；检查服务、配对密钥和允许的酒馆 Origin');
    return await res.json();
  }
  async connect(value: string, token: string): Promise<void> {
    this.disconnect(false);
    const epoch = this.epoch;
    try {
      const url = new URL(value.trim());
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw Error('桥接地址须是 http(s) origin，不含路径、参数或密码');
      if (token.trim().length < 24) throw Error('请输入服务端显示的配对密钥（至少24字符）');
      this.connection = { url: url.origin, token: token.trim() };
      this.report('正在连接…');
      const aborter = new AbortController(); this.aborter = aborter;
      const timeout = setTimeout(() => aborter.abort(), 8000);
      let result;
      try { result = await this.post('/bridge/connect', { label: '通用战斗系统 · ' + location.host }, this.connection, aborter.signal); }
      finally { clearTimeout(timeout); }
      if (epoch !== this.epoch) return;
      if (typeof result.sessionId !== 'string') throw Error('无效的桥接响应');
      this.sessionId = result.sessionId;
      this.report('已连接 · 客户端可调用 battle_sessions'); this.changed();
      void this.poll(epoch);
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.connection = undefined;
      this.report(error instanceof Error ? error.message : '连接失败');
    }
  }
  private async poll(epoch: number): Promise<void> {
    if (epoch !== this.epoch || !this.sessionId) return;
    try {
      const aborter = new AbortController(); this.aborter = aborter;
      const timeout = setTimeout(() => aborter.abort(), 8000);
      let response;
      try { response = await this.post('/bridge/poll', { sessionId: this.sessionId }, this.connection, aborter.signal); }
      finally { clearTimeout(timeout); }
      if (epoch !== this.epoch) return;
      if (response.command) {
        const command = response.command as McpCommand;
        if (!command || typeof command.id !== 'string' || !Number.isFinite(command.expiresAt) || !command.args || typeof command.args !== 'object') throw Error('无效的桥接命令');
        const result = await this.player.execute(command);
        if (epoch !== this.epoch) return;
        const deliveryAborter = new AbortController(); this.aborter = deliveryAborter;
        const deliveryTimeout = setTimeout(() => deliveryAborter.abort(), 8000);
        try { await this.post('/bridge/result', { sessionId: this.sessionId, commandId: command.id, result }, this.connection, deliveryAborter.signal); }
        finally { clearTimeout(deliveryTimeout); }
      }
      this.report('已连接 · ' + this.sessionId);
      this.timer = setTimeout(() => void this.poll(epoch), 600);
    } catch (error) {
      if (epoch !== this.epoch) return;
      // Do not replay a command or reconnect into a different chat after an uncertain result.
      this.disconnect(false); this.report((error instanceof Error ? error.message : '连接失败') + '；已停止，请手动重连'); this.changed();
    }
  }
  disconnect(render = true): void {
    const connection = this.connection, sessionId = this.sessionId;
    this.epoch++; clearTimeout(this.timer); this.aborter?.abort(); this.connection = undefined; this.sessionId = undefined;
    if (connection && sessionId) void this.post('/bridge/disconnect', { sessionId }, connection).catch(() => {});
    this.report('未连接（默认关闭）');
    if (render) this.changed();
  }
}
