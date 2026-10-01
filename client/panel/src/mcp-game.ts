import { SmallBattle, MassBattle, cellLabel, FORMATION_NODES, type Combatant, type Order } from '../../engine/src/index.js';
import { randomId } from '../../host/src/browser-compat.js';
import { battleAbilities } from './battle-skills.js';
import { formationChoices } from './formation-orders.js';
import { publicBattleEvents } from './battle-reports.js';

export interface GameAction {
  type: 'move' | 'attack' | 'charge' | 'ability' | 'brace' | 'overwatch' | 'reload' | 'suppress' | 'retreat' | 'takeoff' | 'land' | 'climb' | 'structure' | 'gate' | 'haste' | 'end_turn' | 'auto';
  cell?: number | string;
  direction?: 'advance' | 'withdraw';
  targetId?: string;
  abilityId?: string;
  weaponMode?: 'primary' | 'sidearm';
  enabled?: boolean;
}
type Battle = SmallBattle | MassBattle;
export interface McpGameRuntime {
  environment(): 'live' | 'sandbox';
  scope(): string;
  context(): string;
  battle(): Battle | null;
  roster(): Combatant[];
  archive(): unknown;
  preparation(): unknown;
  busy(): boolean;
  blockReason(): string | undefined;
  saveStatus(): unknown;
  massAutomatic(): boolean;
  automation(): { running: boolean; settling: boolean };
  selection(): { unitId?: string; cell?: number };
  setAutomation(running: boolean): void;
  run(task: () => Promise<void>): Promise<void>;
  act(actorId: string, action: GameAction): Promise<void>;
  start(args: Record<string, unknown>): Promise<void>;
  plan(args: Record<string, unknown>): Promise<unknown>;
  orders(orders: Order[], resolve: boolean): Promise<void>;
  recover(unitIds: string[], deploy: boolean): Promise<void>;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
function unitView(u: Combatant, b: Battle | null) {
  const field = b instanceof SmallBattle ? b.battlefield : undefined;
  return { id: u.id, name: u.name, side: u.side, scale: u.scale, level: u.level, body: u.body,
    hp: u.hp, hpMax: u.base.hpMax, morale: u.morale, status: u.status, stats: u.base, resources: u.resources,
    conditions: u.conditions, pos: u.pos, cell: field && u.pos !== undefined ? cellLabel(field, u.pos) : undefined,
    formationPosition: u.formationPosition, airborne: u.airborne, elevation: u.elevation,
    weapon: u.weapon && { name: u.weapon.name, range: u.weapon.range, minRange: u.weapon.minRange },
    sidearm: u.sidearm && { name: u.sidearm.name, range: u.sidearm.range },
    abilities: battleAbilities(u).map(a => ({ id: a.id, name: a.name, description: a.desc, target: a.target, range: a.range, cost: a.cost,
      cooldown: u.abilityState.find(s => s.abilityId === a.id)?.cdLeft ?? 0 })),
  };
}

/** Domain state, independent of selected tab, map mode, dialog or DOM controls. */
export function playerGameState(runtime: McpGameRuntime, args: Record<string, unknown> = {}) {
  const b = runtime.battle();
  const visible = b ? b.rules.resolutionVersion === 'v2' ? b.visibleCombatants('ally') : b.combatants : runtime.roster();
  const known = new Set(visible.map(u => u.id));
  const actor = visible.find(u => u.side === 'ally' && u.id === args.actorId)
    ?? (b instanceof SmallBattle ? visible.find(u => u.side === 'ally' && u.id === b.active?.id) : visible.find(u => u.side === 'ally' && u.status === 'ready'));
  const field = b instanceof SmallBattle ? b.battlefield : undefined;
  const options = b instanceof SmallBattle && actor ? b.getActionOptions(actor.id).filter(o => o.kind !== 'ability' || battleAbilities(actor).some(a => a.id === o.id)) : undefined;
  const objective = field?.objective;
  const active = b instanceof SmallBattle ? visible.find(u => u.id === b.active?.id) : undefined;
  const selection = runtime.selection();
  const selected = visible.find(u => u.id === selection.unitId && u.side === 'ally' && !['dead','fled'].includes(u.status))
    ?? visible.find(u => u.id === active?.id && u.side === 'ally') ?? visible.find(u => u.side === 'ally' && u.status === 'ready');
  const result = {
    apiVersion: 2, environment: runtime.environment(), perspective: 'player', phase: !b ? 'preparation' : b.isOver() ? 'finished' : 'battle',
    kind: b ? b instanceof SmallBattle ? 'small' : 'mass' : undefined,
    busy: runtime.busy(), automation: runtime.automation(), blockReason: runtime.blockReason(), saveStatus: runtime.saveStatus(),
    round: b?.round, rules: b?.rules.id, winner: b?.isOver() ? b.winner() : undefined,
    activeUnitId: b instanceof SmallBattle && b.active && known.has(b.active.id) ? b.active.id : undefined,
    activeUnit: active && { id: active.id, pos: active.pos, cell: field && active.pos !== undefined ? cellLabel(field, active.pos) : undefined },
    selectedUnitId: selected?.id,
    actorId: actor?.id, commanders: b?.commanderProfiles,
    units: visible.map(u => unitView(u, b)),
    ...(b instanceof SmallBattle && actor ? {
      economy: b.getTurnEconomy(actor.id), movementLeft: field ? b.movementLeft(actor.id) : undefined,
      reachable: field ? b.reachableCells(actor.id).map(p => ({ cell: p.cells.at(-1), label: cellLabel(field, p.cells.at(-1)!), cost: p.cost })) : undefined,
      options,
      auxiliaryActions: ['overwatch','reload','suppress','takeoff','land','climb','structure','gate','haste','auto'],
    } : {}),
    ...(b instanceof MassBattle ? {
      automaticCommand: runtime.massAutomatic(), planningLocked: b.planningLocked, nodes: FORMATION_NODES,
      orders: [...b.orders.values()].filter(o => b.byId(o.unitId).side === 'ally').map(o => ({ ...o, targetId: o.targetId && (known.has(o.targetId) || o.targetId.startsWith('zone:')) ? o.targetId : undefined })),
      choices: actor && !b.isAttached(actor.id) ? formationChoices(b, actor) : [],
    } : {}),
    ...(field && args.includeMap !== false ? { map: { width: field.width, height: field.height, tiles: field.tiles,
      cells: field.tiles.map((terrain, cell) => {
        const occupants = visible.filter(u => u.pos === cell && !['dead','fled'].includes(u.status));
        return { cell, label: cellLabel(field, cell), terrain, unitIds: occupants.map(u => u.id), acting: !!active && occupants.some(u => u.id === active.id), selected: !!selected && occupants.some(u => u.id === selected.id), inspected: selection.cell === cell };
      }),
      groundHeight: field.groundHeight, structures: field.structures, overlays: field.overlays, landmarks: field.landmarks,
      objective: objective && 'unitId' in objective && !known.has(objective.unitId) ? { ...objective, unitId: undefined } : objective } } : {}),
    events: b ? publicBattleEvents(b).slice(-20).map(({ index, entry }) => ({ index, round: entry.round, kind: entry.kind, text: entry.text })) : [],
    ...(!b || b.isOver() ? { archive: runtime.archive() } : {}),
    ...(!b ? { preparation: runtime.preparation() } : {}),
  };
  return structuredClone(result);
}

export function gameCell(b: SmallBattle, value: unknown): number {
  const field = b.battlefield;
  if (!field) throw Error('当前不是格子战场，请使用 advance / withdraw');
  let cell = value;
  if (typeof value === 'string') {
    const match = /^([A-Z])(\d+)$/i.exec(value.trim());
    if (!match || Number(match[2]) < 1 || match[1]!.toUpperCase().charCodeAt(0) - 65 >= field.width) throw Error('格子须为 A1 等坐标或零起始索引');
    cell = (Number(match[2]) - 1) * field.width + match[1]!.toUpperCase().charCodeAt(0) - 65;
  }
  if (!Number.isInteger(cell) || Number(cell) < 0 || Number(cell) >= field.tiles.length) throw Error('格子超出地图范围');
  return Number(cell);
}

/** Explicit game commands; no arbitrary method names, snapshots, bypass flags or UI selection. */
export function executeSmallGameAction(b: SmallBattle, actorId: string, a: GameAction): void {
  const actor = b.combatants.find(u => u.id === actorId && u.side === 'ally');
  if (!actor || b.active?.id !== actorId || actor.status !== 'ready' || b.isOver()) throw Error('该我方单位当前不能行动，后续步骤已停止');
  if (a.targetId && !a.targetId.startsWith('cell:') && !b.visibleCombatants('ally').some(u => u.id === a.targetId)) throw Error('目标不在玩家可见范围内');
  const target = () => { if (!a.targetId) throw Error('请提供 targetId'); return a.targetId; };
  switch (a.type) {
    case 'move':
      if (b.battlefield) b.moveTo(actorId, gameCell(b, a.cell));
      else { if (a.direction !== 'advance' && a.direction !== 'withdraw') throw Error('旧战场移动须提供 direction'); b.move(actorId, a.direction); }
      break;
    case 'attack': b.attack(actorId, target(), { weaponMode: a.weaponMode ?? 'primary' }); break;
    case 'charge': b.attack(actorId, target(), { charge: true }); break;
    case 'ability': {
      if (!a.abilityId || !battleAbilities(actor).some(ability => ability.id === a.abilityId)) throw Error('该技能未准备或不属于此单位');
      const result = b.useAbility(actorId, a.abilityId, a.targetId);
      if (!result.ok) throw Error(result.reason ?? '技能不可用');
      break;
    }
    case 'brace': b.brace(actorId); break;
    case 'overwatch': b.setOverwatch(actorId); break;
    case 'reload': b.reloadWeapon(actorId, a.weaponMode === 'sidearm'); break;
    case 'suppress': b.suppress(actorId, target()); break;
    case 'retreat': b.retreat(actorId); if (!b.battlefield) b.endTurn(); break;
    case 'takeoff': b.changeFlight(actorId, true); break;
    case 'land': b.changeFlight(actorId, false); break;
    case 'climb': b.climb(actorId, gameCell(b, a.cell)); break;
    case 'structure':
      if (a.abilityId && !battleAbilities(actor).some(ability => ability.id === a.abilityId)) throw Error('破障技能未准备或不属于此单位');
      b.attackStructure(actorId, gameCell(b, a.cell), a.abilityId ?? a.weaponMode ?? 'primary'); break;
    case 'gate': b.toggleGate(actorId, gameCell(b, a.cell)); break;
    case 'haste': b.selectHaste(actorId, a.enabled ?? true); break;
    case 'end_turn': b.endTurn(); break;
    case 'auto': b.autoAction(actorId); break;
    default: throw Error('不支持的游戏行动');
  }
}

interface Operation {
  signature: string;
  scope: string;
  status: 'pending' | 'completed' | 'partial' | 'failed';
  completedSteps: number;
  error?: string;
  result?: unknown;
  promise?: Promise<void>;
}

/** Each confirmed step is durable. A failure stops the remaining steps, never rewinds confirmed play. */
export class McpGameApi {
  private signature = '';
  private stateId = randomId();
  private operations = new Map<string, Operation>();
  private active?: Operation;
  constructor(private runtime: McpGameRuntime, private responseWaitMs = 10000) {}
  state(args: Record<string, unknown> = {}) {
    const b = this.runtime.battle();
    const signature = JSON.stringify([this.runtime.context(), b?.toSnapshot(), !b || b.isOver() ? this.runtime.archive() : undefined,
      b ? undefined : [this.runtime.roster(), this.runtime.preparation()], this.runtime.busy(), this.runtime.automation()]);
    if (signature !== this.signature) { this.signature = signature; this.stateId = randomId(); }
    const request = typeof args.requestId === 'string' ? this.operations.get(args.requestId) : undefined;
    return { stateId: this.stateId, ...playerGameState(this.runtime, args),
      ...(request && request.scope === this.runtime.scope() ? { request: { requestId: args.requestId, status: request.status, completedSteps: request.completedSteps, error: request.error, result: request.result } } : {}) };
  }
  async handle(operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (operation === 'game_state') return this.state(args);
    const requestId = args.requestId;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(requestId)) return { error: '请提供唯一 requestId（1—128位字母、数字或 ._:-）' };
    const signature = canonical({ operation, args });
    let record = this.operations.get(requestId);
    if (record) {
      if (record.signature !== signature || record.scope !== this.runtime.scope()) return { error: 'requestId 已用于其他指令或聊天，请为新指令换一个 ID', state: this.state() };
      return { requestId, status: record.status, completedSteps: record.completedSteps, error: record.error, result: record.result, replayed: true, state: this.state() };
    }
    // Pause is safe against a moving state and must remain available during an in-flight auto step.
    const pause = operation === 'game_auto' && args.action === 'pause';
    if (!pause && args.stateId !== this.state().stateId) return { error: '游戏状态已变化，请使用最新 stateId', state: this.state() };
    const reason = this.runtime.blockReason();
    if (!pause && (this.active || this.runtime.busy() || reason)) return { error: reason ?? '游戏正在处理另一项操作，请稍后读取状态', state: this.state() };
    if (!['game_act','game_start','game_plan','game_orders','game_recover','game_auto'].includes(operation)) return { error: '未知游戏操作' };
    const scope = this.runtime.scope();
    record = { scope, signature, status: 'pending', completedSteps: 0 };
    if (operation === 'game_auto') {
      if (args.action !== 'start' && args.action !== 'pause') return { error: 'action 须为 start 或 pause', state: this.state() };
      try { this.runtime.setAutomation(args.action === 'start'); record.status = 'completed'; record.completedSteps = 1; }
      catch (error) { record.status = 'failed'; record.error = message(error); }
      this.operations.set(requestId, record); this.trimOperations();
      return { requestId, status: record.status, completedSteps: record.completedSteps, error: record.error, state: this.state() };
    }
    this.operations.set(requestId, record); this.active = record;
    const current = record;
    const actorId = typeof args.actorId === 'string' ? args.actorId : this.runtime.battle() instanceof SmallBattle ? (this.runtime.battle() as SmallBattle).active?.id : undefined;
    current.promise = (async () => {
      try {
        await this.runtime.run(async () => {
          if (scope !== this.runtime.scope()) throw Error('聊天已变化，未执行');
          if (operation === 'game_act') {
            if (!actorId || !Array.isArray(args.actions) || !args.actions.length || args.actions.length > 8) throw Error('需要我方行动者和1—8个动作');
            for (const action of args.actions) {
              if (scope !== this.runtime.scope()) throw Error('聊天已变化，后续动作已停止');
              if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw Error('动作格式无效');
              await this.runtime.act(actorId, action as GameAction);
              current.completedSteps++;
            }
          } else if (operation === 'game_start') { await this.runtime.start(args); current.completedSteps = 1; }
          else if (operation === 'game_plan') { current.result = await this.runtime.plan(args); current.completedSteps = 1; }
          else if (operation === 'game_orders') {
            if (!Array.isArray(args.orders) || args.orders.length > 64) throw Error('orders 须为不超过64条的列表');
            await this.runtime.orders(args.orders as Order[], args.resolve !== false); current.completedSteps = 1;
          } else {
            if (!Array.isArray(args.unitIds) || !args.unitIds.length || args.unitIds.length > 64 || args.unitIds.some(id => typeof id !== 'string')) throw Error('unitIds 须包含1—64个档案 ID');
            await this.runtime.recover(args.unitIds as string[], args.deploy !== false); current.completedSteps = 1;
          }
        });
        current.status = 'completed';
      } catch (error) { current.status = current.completedSteps ? 'partial' : 'failed'; current.error = message(error); }
      finally { if (this.active === current) this.active = undefined; }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([current.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, this.responseWaitMs); })]);
    clearTimeout(timer);
    // A bounded receipt cache belongs only to this live panel. Reconnects keep it; reloads clear it.
    this.trimOperations();
    return { requestId, status: current.status, completedSteps: current.completedSteps, error: current.error, result: current.result,
      ...(current.status === 'pending' ? { message: '行动仍在处理；用 battle_state 的 requestId 查询结果，同一 requestId 不会重复执行' } : {}), state: this.state() };
  }
  private trimOperations(): void {
    for (const [id, record] of this.operations) {
      if (this.operations.size <= 100) break;
      if (record !== this.active) this.operations.delete(id);
    }
  }
}
