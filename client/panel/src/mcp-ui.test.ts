// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { McpPlayerUi, type McpCommand } from './mcp-ui.js';
import { McpPanelBridge } from './mcp-bridge.js';

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(html: string) {
  document.body.innerHTML = `<div id="app">${html}</div><div id="toast"></div>`;
  let context = 'chat-a', busy = false;
  const prepare = vi.fn();
  const options = { roots: () => [document.getElementById('app')!], context: () => context, busy: () => busy, help: () => ({}), prepare };
  const ui = new McpPlayerUi(options);
  const run = (operation: string, args: Record<string, unknown>) => ui.execute({ id: 'test', operation, args, expiresAt: Date.now() + 20000 });
  const action = (operation: string, label: string, args: Record<string, unknown> = {}) => {
    const view = ui.observe(); const control = view.controls.find(c => c.label === label)!;
    expect(control, label).toBeDefined();
    return run(operation, { viewId: view.viewId, controlId: control.controlId, ...args });
  };
  return { ui, options, prepare, run, action, context: (v: string) => { context = v; }, busy: (v: boolean) => { busy = v; } };
}
it('reads visible player information, pages controls and redacts credentials without mutating the DOM', async () => {
  const f = fixture('<button title="需要行动点" disabled>攻击</button><section hidden>隐藏敌军<input value="secret"></section><div style="display:none">地图秘密</div><details><summary>地图</summary><button>内部按钮</button></details><label>API Key<input type="password" value="private-secret"></label><section data-mcp-private>pairing-secret</section>');
  const before = document.body.innerHTML;
  const view = f.ui.observe({ limit: 1 });
  expect(view.controls).toHaveLength(1); expect(view.nextOffset).toBe(1);
  const serial = JSON.stringify(f.ui.observe());
  for (const secret of ['隐藏敌军','地图秘密','内部按钮','private-secret','pairing-secret']) expect(serial).not.toContain(secret);
  expect(serial).toContain('[redacted]'); expect(document.body.innerHTML).toBe(before);
  expect(await f.action('click', '攻击')).toMatchObject({ error: expect.stringContaining('禁用') });
  await f.action('click', '地图');
  expect(JSON.stringify(f.ui.observe())).toContain('内部按钮');
});
it('rejects obsolete observations across same-looking chat switches, disabled changes and expired commands', async () => {
  const f = fixture('<button>结束回合</button>'); const button = document.querySelector('button')!, click = vi.fn(); button.onclick = click;
  const view = f.ui.observe(), args = { viewId: view.viewId, controlId: view.controls[0]!.controlId };
  f.context('chat-b');
  expect(await f.run('click', args)).toMatchObject({ error: expect.stringContaining('聊天已变化') });
  expect(click).not.toHaveBeenCalled();
  const fresh = f.ui.observe(); button.disabled = true;
  expect(await f.run('click', { ...args, viewId: fresh.viewId })).toMatchObject({ error: expect.stringContaining('界面') });
  expect(await f.ui.execute({ id: 'expired', operation: 'click', args, expiresAt: 0 })).toMatchObject({ error: expect.stringContaining('过期') });
  expect(click).not.toHaveBeenCalled();
});
it('uses existing input/change/click handlers, validates options and number bounds, and supports keyboard actions', async () => {
  const f = fixture('<label>等级<input type="number" min="1" max="10" value="2"></label><label>技能<select multiple><option value="a">A</option><option value="b">B</option><option value="c" disabled>C</option></select></label><label>自动<input type="checkbox"></label><button>确定</button>');
  const input = vi.fn(), change = vi.fn(), click = vi.fn();
  document.querySelector('input')!.addEventListener('input', input);
  document.querySelector('input')!.addEventListener('change', change);
  document.querySelector('button')!.onclick = click;
  expect(await f.action('fill', '等级', { value: '20' })).toHaveProperty('error'); expect(input).not.toHaveBeenCalled();
  await f.action('fill', '等级', { value: '4' }); expect(input).toHaveBeenCalledOnce(); expect(change).toHaveBeenCalledOnce();
  expect(await f.action('fill', '技能', { value: ['c'] })).toHaveProperty('error');
  expect(await f.action('fill', '技能', { value: ['a','b'] })).toHaveProperty('dispatched', true);
  expect(Array.from(document.querySelector('select')!.options).filter(o => o.selected).map(o => o.value)).toEqual(['a','b']);
  await f.action('fill', '自动', { value: true }); expect(document.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(true);
  await f.action('key', '确定', { key: 'Enter' }); expect(click).toHaveBeenCalledOnce();
});
it('allows pausing auto battle while busy and never starts network activity until paired', async () => {
  const f = fixture('<label>自动<input type="checkbox" data-role="full-auto-battle" checked></label><button>攻击</button>');
  f.busy(true);
  expect(await f.action('click', '攻击')).toHaveProperty('error');
  document.querySelector('input')!.addEventListener('change', () => f.busy(false));
  expect(await f.action('fill', '自动', { value: false })).toHaveProperty('dispatched', true);
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  const bridge = new McpPanelBridge(f.options, () => {}); const stop = bridge.install();
  expect(bridge.render()).toContain('默认关闭'); expect(request).not.toHaveBeenCalled(); stop(); expect(request).not.toHaveBeenCalled();
});
it('returns immediately after enabling full auto even while the battle remains busy', async () => {
  vi.useFakeTimers();
  const f = fixture('<label>自动<input type="checkbox" data-role="full-auto-battle"></label>');
  document.querySelector('input')!.addEventListener('change', () => f.busy(true));
  let result: Record<string, unknown> | undefined;
  const call = f.action('fill', '自动', { value: true }).then(value => { result = value; });
  await vi.advanceTimersByTimeAsync(40);
  expect(result).toMatchObject({ dispatched: true, busy: true });
  await call;
});
