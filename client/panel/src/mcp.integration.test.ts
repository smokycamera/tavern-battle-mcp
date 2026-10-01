// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFixture } from '../../runtime/tests/native-fixture.js';
import { generateUnit, SmallBattle, standardField, V11_OVERFLOW_D20 } from '../../engine/src/index.js';
import { unitRecordFromCombatant } from './unit-state.js';
import { McpPlayerUi } from './mcp-ui.js';
import type { LlmEncounterContext } from './llm-context.js';

vi.mock('./panel-runtime.js', async () => import('../../extension/src/panel-runtime.js'));
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.unstubAllGlobals(); });

it('plays through production buttons, honors player fog and chat changes, and starts a designed battle without a second model', async () => {
  const f = nativeFixture(); await f.service.start(); localStorage.clear();
  const units = (['ally','enemy'] as const).map((side, i) => {
    const u = generateUnit({ name: side === 'ally' ? '玩家' : '秘密敌军', side, scale: 'hero', level: 3, rulesVersion: 'v2', damageModel: 'wounds-v2', weaponClass: 'sword', traits: [] }, { seed: side }).unit;
    u.id = 'u' + i; u.morale = u.base.moraleMax = 100; return u;
  });
  const field = standardField(7,13); field.tiles.fill('open');
  const battle = new SmallBattle({ combatants: units, battlefield: field, field: { tags: ['night'] }, rules: V11_OVERFLOW_D20, seed: 'mcp-integration' });
  battle.start(); battle.turnOrder = ['u0','u1']; battle.turnIndex = 0; battle.byId('u0').pos = 79; battle.byId('u1').pos = 9;
  const saved = { schemaVersion: 2 as const, storage: units.map(u => unitRecordFromCombatant(u)), rosterIds: units.map(u => u.id), protagonistId: 'u0', autoTurn: false };
  await f.service.transact(() => ({ ...saved, battle: { kind: 'small', snap: battle.toSnapshot() } }));
  Object.assign(window, { __tavernBattleNative: { service: f.service, messages: {} }, __TAURITAVERN__: {}, SillyTavern: { getContext: () => f.context } });
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  document.body.innerHTML = '<div id="app"></div><div id="toast"></div>';
  await import('./main.js');
  const ui = new McpPlayerUi({ roots: () => [document.querySelector<HTMLElement>('#app')!], context: () => JSON.stringify(f.service.version()), busy: () => document.body.getAttribute('aria-busy') === 'true', help: () => ({}), prepare: () => {} });
  const call = async (operation: string, selector: (c: ReturnType<typeof ui.observe>['controls'][number]) => boolean, extra = {}) => {
    const view = ui.observe({ limit: 500 }), control = view.controls.find(selector);
    expect(control).toBeDefined();
    const result = await ui.execute({ id: 'test', operation, args: { viewId: view.viewId, controlId: control!.controlId, ...extra }, expiresAt: Date.now() + 20000 });
    expect(result.error).toBeUndefined(); return result;
  };
  const click = (action: string) => call('click', c => c.action === action);
  const before = JSON.stringify(f.service.snapshot());
  const positions = ui.observe({ limit: 500 });
  expect(positions.activeUnit).toMatchObject({ id: 'u0', pos: 79, cell: 'C12' });
  expect(positions.controls.find(c => c.action === 'grid-cell' && c.cell === '79' && c.unitIds)).toMatchObject({ unitIds: ['u0'], acting: true, selected: true, coordinate: 'C12' });
  expect(positions.controls.flatMap(c => c.unitIds ?? [])).not.toContain('u1');
  expect(JSON.stringify(ui.observe({ limit: 500 }))).not.toContain('秘密敌军');
  expect(JSON.stringify(f.service.snapshot())).toBe(before);
  await click('grid-endturn');
  expect(SmallBattle.fromSnapshot(f.service.snapshot().battle!.snap).round).toBe(2);
  expect(request).not.toHaveBeenCalled();
  const old = ui.observe(), nav = old.controls.find(c => c.action === 'workspace-tab')!;
  f.switchTo('b'); await f.service.load();
  expect(await ui.execute({ id: 'stale', operation: 'click', args: { viewId: old.viewId, controlId: nav.controlId }, expiresAt: Date.now() + 10000 })).toHaveProperty('error');
  await f.service.transact(() => saved);
  await call('click', c => c.action === 'workspace-tab' && c.tab === 'battle');
  await call('click', c => c.tag === 'summary' && c.label.startsWith('指挥风格与地图设计'));
  await call('fill', c => c.label === '双方指挥 JSON', { value: '{"ally":{"ability":"master","style":"flanking"},"enemy":{"ability":"regular","style":"cautious"}}' });
  await call('fill', c => c.label === '地图 JSON', { value: '{"scene":"field","layout":"lanes","landmarks":[{"kind":"hill","anchor":"center_left","label":"西侧高地"}]}' });
  await click('player-preparation-apply');
  expect(document.body.textContent).toContain('已准备，点击开始交战时使用');
  await click('small-start');
  const final = SmallBattle.fromSnapshot(f.service.snapshot().battle!.snap);
  expect(final.commanderProfiles.ally).toMatchObject({ ability: 'master', style: 'flanking' });
  expect(final.battlefield?.generation?.source).toBe('context');
  expect((f.service.snapshot().encounterContext as LlmEncounterContext)?.battlefieldPlan?.landmarks?.[0]?.label).toBe('西侧高地');
  expect(request).not.toHaveBeenCalled();
  f.service.dispose();
}, 20000);
