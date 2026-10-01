// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFixture } from '../../runtime/tests/native-fixture.js';
import { generateUnit, SmallBattle, standardField, V11_OVERFLOW_D20 } from '../../engine/src/index.js';
import { unitRecordFromCombatant } from './unit-state.js';

vi.mock('./panel-runtime.js', async () => import('../../extension/src/panel-runtime.js'));
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.unstubAllGlobals(); });

it('runs durable action chains, stops on reactions, replays receipts, recovers and starts a new battle', async () => {
  const f = nativeFixture(); await f.service.start(); localStorage.clear();
  Object.assign(window, { __tavernBattleNative: { service: f.service, messages: {} }, __TAURITAVERN__: {}, SillyTavern: { getContext: () => f.context } });
  vi.stubGlobal('fetch', vi.fn()); document.body.innerHTML = '<div id="app"></div><div id="toast"></div>';
  const { mcpGame } = await import('./main.js');
  const units = ['player','friend','guard'].map(id => {
    const u = generateUnit({ name: id, side: id === 'guard' ? 'enemy' : 'ally', scale: 'hero', level: 4, rulesVersion: 'v2', damageModel: 'wounds-v2',
      weaponClass: id === 'guard' ? 'rifle' : 'sword', weaponLevel: 5, hpMax: 500, traits: [] }, { seed: id, noVariance: true }).unit;
    u.id = id; u.morale = u.base.moraleMax = 100; return u;
  });
  const field = standardField(7,13); field.tiles.fill('open');
  const b = new SmallBattle({ combatants: units, battlefield: field, rules: V11_OVERFLOW_D20, seed: 'reaction-turn', nonLethal: true });
  b.start(); b.turnOrder = ['player','friend','guard']; b.turnIndex = 0;
  b.byId('player').pos = 79; b.byId('friend').pos = 87; b.byId('guard').pos = 65;
  const load = async (battle: SmallBattle) => {
    await f.service.transact(() => ({ schemaVersion: 2, storage: battle.combatants.map(u => unitRecordFromCombatant(u)),
      rosterIds: battle.combatants.map(u => u.id), protagonistId: 'player', autoTurn: false, battle: { kind: 'small', snap: battle.toSnapshot() } }));
    await vi.waitFor(() => expect(mcpGame.state().busy).toBe(false));
  };
  const savedBattle = () => SmallBattle.fromSnapshot(f.service.snapshot().battle!.snap);
  await load(b);
  expect(mcpGame.state().activeUnit).toMatchObject({ id: 'player', pos: 79, cell: 'C12' });
  expect(mcpGame.state().map?.cells.find(c => c.cell === 79)).toMatchObject({ unitIds: ['player'], acting: true, selected: true });
  const args = { stateId: mcpGame.state().stateId, requestId: 'chain', actions: [{ type: 'move', cell: 72 }, { type: 'attack', targetId: 'guard' }] };
  expect(await mcpGame.handle('game_act', args)).toMatchObject({ status: 'completed', completedSteps: 2 });
  expect(savedBattle().byId('player').pos).toBe(72); expect(savedBattle().actedThisTurn.has('player')).toBe(true);
  const committed = f.service.snapshot().battle;
  expect(await mcpGame.handle('game_act', args)).toMatchObject({ replayed: true, completedSteps: 2 });
  expect(f.service.snapshot().battle).toEqual(committed);
  expect(await mcpGame.handle('game_act', { ...args, requestId: 'stale' })).toHaveProperty('error');

  // A reaction downs the original actor; the second step must not act as their teammate.
  b.turnOrder = ['guard','player','friend']; b.turnIndex = 0; b.byId('guard').pos = 58; b.byId('guard').base.atk = 100;
  b.setOverwatch('guard'); b.endTurn(); b.byId('player').hp = 1;
  await load(b);
  const reaction = await mcpGame.handle('game_act', { stateId: mcpGame.state().stateId, requestId: 'reaction', actions: [{ type: 'move', cell: 65 }, { type: 'attack', targetId: 'guard' }] });
  expect(reaction).toMatchObject({ status: 'partial', completedSteps: 1, error: expect.stringContaining('不能行动') });
  expect(savedBattle().byId('player')).toMatchObject({ pos: 72, status: 'dying' });
  expect(savedBattle().active?.id).toBe('friend'); expect(savedBattle().actedThisTurn.has('friend')).toBe(false);

  // Starting auto returns before its first scheduled activation; pausing accepts a moving state.
  const auto = await mcpGame.handle('game_auto', { stateId: mcpGame.state().stateId, requestId: 'auto-start', action: 'start' });
  expect(auto).toMatchObject({ status: 'completed', state: { automation: { running: true } } });
  expect(await mcpGame.handle('game_auto', { requestId: 'auto-pause', action: 'pause' })).toMatchObject({ state: { automation: { running: false } } });
  expect(f.service.snapshot().battle!.snap.round).toBe(1);

  const down = savedBattle(); down.byId('friend').hp = 0; down.byId('friend').status = 'dying';
  await load(down);
  expect(await mcpGame.handle('game_recover', { stateId: mcpGame.state().stateId, requestId: 'recover', unitIds: ['player','friend'] })).toMatchObject({ status: 'completed' });
  expect(f.service.snapshot().battle).toBeNull();
  expect(f.service.snapshot().storage!.find(u => u.id === 'player')).toMatchObject({ hp: 500, status: 'ready' });
  expect(f.service.snapshot().rosterIds).toContain('player');
  const beforePlan = JSON.stringify(f.service.snapshot());
  const planned = await mcpGame.handle('game_plan', { stateId: mcpGame.state().stateId, requestId: 'preview', setup: { mode: 'small' },
    deployment: [{ unitId: 'player', side: 'ally' }, { unitId: 'friend', side: 'ally' }, { unitId: 'guard', side: 'enemy' }],
    commanders: { ally: { ability: 'master', style: 'flanking' } } });
  expect(planned).toMatchObject({ status: 'completed' });
  expect(JSON.stringify(f.service.snapshot())).toBe(beforePlan);
  const preview = planned.result as { previewId: string; map: { width: number; height: number; tiles: unknown[]; objective: unknown }; units: { id: string; pos: number }[] };
  expect(preview.map.width).toBeGreaterThan(0);
  expect(await mcpGame.handle('game_start', { stateId: mcpGame.state().stateId, requestId: 'start', previewId: preview.previewId })).toMatchObject({ status: 'completed' });
  expect(savedBattle().commanderProfiles.ally?.style).toBe('flanking');
  const opening = SmallBattle.fromSnapshot(f.service.snapshot().activeBattleStart!.snapshot);
  expect(opening.battlefield!.tiles).toEqual(preview.map.tiles); expect(opening.battlefield!.objective).toEqual(preview.map.objective);
  expect(opening.combatants.map(u => ({ id: u.id, pos: u.pos }))).toEqual(preview.units.map(u => ({ id: u.id, pos: u.pos })));

  // Sandbox generation, real combat, full-state restart and persisted reports never touch the native archive.
  const formal = JSON.stringify(f.service.snapshot());
  expect(await mcpGame.handle('game_sandbox', { action: 'start', requestId: 'sandbox' })).toMatchObject({ status: 'completed', state: { environment: 'sandbox' } });
  const sandbox = mcpGame.state();
  expect(await mcpGame.handle('game_act', { stateId: sandbox.stateId, requestId: 'sandbox-act', actions: [{ type: 'auto' }] })).toMatchObject({ status: 'completed' });
  expect(await mcpGame.handle('game_sandbox', { action: 'restart', requestId: 'sandbox-restart' })).toMatchObject({ status: 'completed' });
  expect(mcpGame.state().units).toEqual(sandbox.units);
  const reports = await mcpGame.handle('game_sandbox', { action: 'reports' });
  expect(reports.reports).toHaveLength(2);
  const report = await mcpGame.handle('game_sandbox', { action: 'reports', reportId: (reports.reports as { id: string }[])[0]!.id });
  expect((report.report as { events: unknown[] }).events.length).toBeGreaterThan(0);
  expect(await mcpGame.handle('game_sandbox', { action: 'close', requestId: 'sandbox-close' })).toMatchObject({ active: false });
  expect(mcpGame.state().environment).toBe('live');
  expect(JSON.stringify(f.service.snapshot())).toBe(formal);
  expect(await mcpGame.handle('game_sandbox', { action: 'start', requestId: 'mass-sandbox', setup: { mode: 'mass' }, participants: [
    { side: 'ally', scale: 'hero' }, { side: 'ally', scale: 'company', personnel: 100 }, { side: 'ally', scale: 'company', personnel: 100 },
    { side: 'enemy', scale: 'hero' }, { side: 'enemy', scale: 'company', personnel: 100 },
  ] })).toMatchObject({ status: 'completed', state: { kind: 'mass' } });
  const massBefore = mcpGame.state();
  expect(await mcpGame.handle('game_orders', { stateId: massBefore.stateId, requestId: 'invalid-batch', orders: [
    { unitId: 'sandbox-unit-2', type: 'hold' }, { unitId: 'sandbox-unit-5', type: 'hold' },
  ] })).toMatchObject({ status: 'failed', completedSteps: 0 });
  expect(mcpGame.state().round).toBe(massBefore.round); expect(mcpGame.state().orders).toEqual(massBefore.orders);
  expect(await mcpGame.handle('game_orders', { stateId: mcpGame.state().stateId, requestId: 'mass-batch', orders: [
    { unitId: 'sandbox-unit-2', type: 'hold' }, { unitId: 'sandbox-unit-3', type: 'brace' },
  ] })).toMatchObject({ status: 'completed', state: { round: massBefore.round! + 1 } });
  await mcpGame.handle('game_sandbox', { action: 'close', requestId: 'mass-close' });
  expect(JSON.stringify(f.service.snapshot())).toBe(formal);
  expect(fetch).not.toHaveBeenCalled();
  f.service.dispose();
}, 20000);
