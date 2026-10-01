import { randomUUID } from 'node:crypto';

/** One in-flight command per live panel. Never replay an uncertain write. */
export class BattleBroker {
  constructor({ timeout = 25000, staleAfter = 45000, now = Date.now } = {}) {
    this.timeout = timeout;
    this.staleAfter = staleAfter;
    this.now = now;
    this.sessions = new Map();
  }
  prune() {
    for (const [id, session] of this.sessions) {
      if (this.now() - session.seen > this.staleAfter) this.remove(id);
    }
  }
  connect(label) {
    this.prune();
    if (this.sessions.size >= 16) throw Error('Too many connected panels');
    const id = randomUUID();
    this.sessions.set(id, { id, label: String(label || '战阵').slice(0, 120), seen: this.now() });
    return { sessionId: id };
  }
  get(id) {
    this.prune();
    const session = this.sessions.get(id);
    if (!session) throw Error('面板未连接或已过期，请在酒馆战阵设置中连接 MCP');
    return session;
  }
  list() {
    this.prune();
    return [...this.sessions.values()].map(s => ({ sessionId: s.id, label: s.label, busy: !!s.pending, lastSeen: s.seen }));
  }
  poll(id) {
    const s = this.get(id); s.seen = this.now();
    if (!s.pending || s.pending.delivered) return {};
    s.pending.delivered = true;
    return { command: s.pending.command };
  }
  request(id, operation, args, signal) {
    const s = this.get(id);
    if (s.pending) throw Error('此面板正在执行另一项操作，请先读取状态');
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(Error('操作已取消')); return; }
      const command = { id: randomUUID(), operation, args, expiresAt: this.now() + this.timeout };
      const abort = () => {
        if (s.pending?.command.id !== command.id) return;
        const delivered = s.pending.delivered;
        clearTimeout(s.pending.timer); s.pending = undefined;
        reject(Error(delivered ? '已取消等待；操作可能已执行，请重新观察' : '操作已取消，未送达面板'));
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        if (s.pending?.command.id !== command.id) return;
        const delivered = s.pending.delivered;
        s.pending = undefined; cleanup();
        reject(Error(delivered ? '操作已送达但未收到结果；结果未知，请重新观察，勿盲目重复操作' : '面板未领取操作，已取消；请检查面板连接'));
      }, this.timeout);
      s.pending = { command, resolve: result => { cleanup(); resolve(result); }, reject: error => { cleanup(); reject(error); }, timer, delivered: false };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  result(id, commandId, result) {
    const s = this.get(id); s.seen = this.now();
    if (!s.pending || s.pending.command.id !== commandId) return { accepted: false };
    clearTimeout(s.pending.timer);
    s.pending.resolve(result); s.pending = undefined;
    return { accepted: true };
  }
  remove(id) {
    const s = this.sessions.get(id);
    if (s?.pending) { clearTimeout(s.pending.timer); s.pending.reject(Error('面板连接已断开；请重新观察操作结果')); }
    this.sessions.delete(id);
  }
  close() { for (const id of this.sessions.keys()) this.remove(id); }
}
