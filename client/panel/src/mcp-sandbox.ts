import { generateUnit, SmallBattle, MassBattle, randomSeed, WEAPON_CLASSES, type Trait, type Order } from '../../engine/src/index.js';
import { randomId } from '../../host/src/browser-compat.js';
import { AutoBattleLoop, yieldBattleFrame } from './auto-battle.js';
import { executeSmallGameAction, McpGameApi, type GameAction } from './mcp-game.js';
import { buildEncounter, encounterPreview, type EncounterBuild } from './game-encounter.js';
import { PlayerPreparation } from './player-preparation.js';
import { publicBattleEvents } from './battle-reports.js';
import { executeMassPlan } from './battle-execution.js';
import { battleAbilities } from './battle-skills.js';
import type { EncounterSetup } from './jev-context.js';

type Battle = SmallBattle | MassBattle;
interface Baseline { kind: 'small' | 'mass'; snapshot: Record<string, unknown>; setup: EncounterSetup; opening: ReturnType<typeof encounterPreview> }
interface SandboxReport { id: string; createdAt: string; status: 'running' | 'finished' | 'stopped'; kind: 'small' | 'mass'; round: number; winner?: string | null;
  opening: ReturnType<typeof encounterPreview>; events: { round: number; kind: string; text: string }[] }
interface Store { version: 1; baseline?: Baseline; reports: SandboxReport[] }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A separate local save namespace: this class has no reference to the formal archive, inventory or host save API. */
export class McpSandbox {
  private currentScope = '';
  private key = '';
  private data: Store = { version: 1, reports: [] };
  private battle: Battle | null = null;
  private runId = '';
  private busy = false;
  private revision = 0;
  private auto = new AutoBattleLoop();
  private saveError?: string;
  private receipts = new Map<string, { signature: string; result: Record<string, unknown> }>();
  readonly api: McpGameApi;
  constructor(private scope: () => string, private namespace: () => string, private registry: Map<string, Trait>, private summonUnit: EncounterBuild['summonUnit']) {
    this.api = new McpGameApi({
      environment: () => 'sandbox', scope: () => this.currentScope, context: () => this.currentScope + ':' + this.revision,
      battle: () => this.battle, roster: () => [], archive: () => [], preparation: () => ({ sandbox: true, restartAvailable: !!this.data.baseline }),
      busy: () => this.busy || this.auto.running, blockReason: () => this.saveError,
      saveStatus: () => ({ status: this.saveError ? 'failed' : 'saved', destination: 'isolated-browser-storage', error: this.saveError }),
      massAutomatic: () => this.battle instanceof MassBattle && !this.battle.manualCommandAllowed, automation: () => ({ running: this.auto.running, settling: this.busy }),
      selection: () => ({ unitId: this.battle instanceof SmallBattle ? this.battle.active?.id : undefined }),
      setAutomation: running => this.setAuto(running), run: async task => { this.busy = true; try { await task(); } finally { this.busy = false; } },
      act: (actorId, action) => this.act(actorId, action), orders: (orders, resolve) => this.orders(orders, resolve),
      start: async () => { throw Error('当前为隔离试战；用 battle_sandbox restart 满状态重开，或 close 返回正式档案'); },
      plan: async () => { throw Error('当前为隔离试战；用 battle_sandbox start 配置新测试场景'); },
      recover: async () => { throw Error('隔离试战用 battle_sandbox restart 恢复完整开局，正式档案不受影响'); },
    });
  }
  private sync(): void {
    const scope = this.scope(); if (scope === this.currentScope) return;
    this.auto.stop(); this.battle = null; this.currentScope = scope; this.receipts.clear(); this.saveError = undefined;
    this.key = 'tavern-battle:mcp-sandbox:v1:' + this.namespace();
    try {
      const raw = localStorage.getItem(this.key), saved = raw ? JSON.parse(raw) as Store : undefined;
      if (saved && (saved.version !== 1 || !Array.isArray(saved.reports))) throw Error('隔离试战记录格式无效');
      this.data = saved ?? { version: 1, reports: [] };
    } catch (error) { this.data = { version: 1, reports: [] }; this.saveError = errorText(error); }
  }
  get active(): boolean { this.sync(); return !!this.battle; }
  stop(): void { this.auto.stop(); }
  private restore(snapshot: Record<string, unknown>, kind: 'small' | 'mass'): Battle {
    return kind === 'small' ? SmallBattle.fromSnapshot(snapshot, { traitRegistry: this.registry, summonUnit: this.summonUnit })
      : MassBattle.fromSnapshot(snapshot, { traitRegistry: this.registry, summonUnit: this.summonUnit });
  }
  private save(stopped = false): void {
    if (this.currentScope !== this.scope()) { this.auto.stop(); throw Error('聊天已切换，隔离试战已暂停'); }
    const next = structuredClone(this.data), b = this.battle;
    if (b && next.baseline) {
      const report: SandboxReport = { id: this.runId, createdAt: next.reports.find(r => r.id === this.runId)?.createdAt ?? new Date().toISOString(),
        status: b.isOver() ? 'finished' : stopped ? 'stopped' : 'running', kind: b instanceof SmallBattle ? 'small' : 'mass', round: b.round,
        winner: b.isOver() ? b.winner() : undefined, opening: next.baseline.opening,
        events: publicBattleEvents(b).map(({ entry }) => ({ round: entry.round, kind: entry.kind, text: entry.text })) };
      next.reports = [...next.reports.filter(r => r.id !== this.runId), report].slice(-20);
    }
    try { localStorage.setItem(this.key, JSON.stringify(next)); this.data = next; this.saveError = undefined; this.revision++; }
    catch (error) { this.saveError = '隔离试战战报未保存：' + errorText(error); this.auto.stop(); throw Error(this.saveError); }
  }
  private async transaction(task: () => void | Promise<void>): Promise<void> {
    const b = this.battle; if (!b) throw Error('尚未创建隔离试战');
    const snapshot = b.toSnapshot();
    try { await task(); if (b instanceof SmallBattle && b.isOver()) b.finalizeCasualties(); this.save(); }
    catch (error) { this.battle = this.restore(snapshot, b instanceof SmallBattle ? 'small' : 'mass'); throw error; }
  }
  private async enemyTurns(): Promise<void> {
    const b = this.battle; if (!(b instanceof SmallBattle)) return;
    let steps = 0;
    while (!b.isOver() && b.active && (b.active.side === 'enemy' || b.active.status !== 'ready' || b.active.conditions.some(c => c.dur > 0 && b.conditions.get(c.id)?.skipTurn))) {
      if (++steps > 200) throw Error('自动回合未能交还控制，试战已暂停');
      if (b.active.status !== 'ready') b.endTurn(); else b.autoAction(b.active.id);
      await yieldBattleFrame();
      if (this.currentScope !== this.scope()) throw Error('聊天已切换');
    }
  }
  private async act(actorId: string, action: GameAction): Promise<void> {
    await this.transaction(async () => {
      const b = this.battle; if (!(b instanceof SmallBattle)) throw Error('会战请使用 battle_orders');
      executeSmallGameAction(b, actorId, action); await this.enemyTurns();
    });
  }
  private async orders(orders: Order[], resolve: boolean): Promise<void> {
    await this.transaction(() => {
      const b = this.battle; if (!(b instanceof MassBattle) || b.isOver()) throw Error('当前不是可下令的会战');
      if (!b.manualCommandAllowed) throw Error('当前指挥官无法下令，请使用自动指挥');
      const known = new Set(b.visibleCombatants('ally').map(u => u.id));
      for (const order of orders) {
        if (!b.combatants.some(u => u.id === order.unitId && u.side === 'ally')) throw Error('只能为我方下令');
        if (order.abilityActorId && !b.combatants.some(u => u.id === order.abilityActorId && u.side === 'ally')) throw Error('技能行动者必须属于我方');
        if (order.targetId && !order.targetId.startsWith('zone:') && !known.has(order.targetId)) throw Error('目标不可见');
        if (order.type === 'ability' && !battleAbilities(b.byId(order.abilityActorId ?? order.unitId)).some(a => a.id === order.abilityId)) throw Error('技能未准备');
      }
      if (resolve) executeMassPlan(b, Object.fromEntries(orders.map(({ unitId, ...draft }) => [unitId, draft])), false);
      else { const result = b.replaceOrders(orders, b.round); if (!result.ok) throw Error(result.reason); }
    });
  }
  private setAuto(running: boolean): void {
    if (!running) { this.auto.stop(); return; }
    if (!this.battle || this.battle.isOver()) throw Error('需要进行中的隔离试战');
    this.auto.start(async () => {
      if (this.currentScope !== this.scope()) return false;
      if (this.busy) return true;
      this.busy = true;
      try {
        await this.transaction(() => {
          const b = this.battle!;
          if (b instanceof SmallBattle) { if (b.active?.status !== 'ready') b.endTurn(); else b.autoAction(b.active.id); }
          else executeMassPlan(b, {}, true);
        });
        return !this.battle!.isOver();
      } finally { this.busy = false; }
    }, () => {}, error => { this.saveError = errorText(error); });
  }
  private build(args: Record<string, unknown>): Baseline {
    const seed = randomSeed();
    const mass = (args.setup as { mode?: string } | undefined)?.mode === 'mass';
    const participants = args.participants ?? [
      { name: '试战剑士', side: 'ally', weaponClass: 'sword' }, { name: mass ? '试战步兵队' : '试战射手', side: 'ally', scale: mass ? 'company' : 'hero', weaponClass: 'rifle' },
      { name: '对手剑士', side: 'enemy', weaponClass: 'sword' }, { name: mass ? '对手步兵队' : '对手射手', side: 'enemy', scale: mass ? 'company' : 'hero', weaponClass: 'rifle' },
    ];
    if (!Array.isArray(participants) || participants.length < 2 || participants.length > 64) throw Error('participants 须为2—64个测试单位');
    const roster = participants.map((p: { name?: string; side?: string; scale?: string; level?: number; weaponClass?: string; personnel?: number }, index) => {
      if (!p || !['ally','enemy'].includes(p.side ?? '') || !['hero','mook','company'].includes(p.scale ?? 'hero')
        || !Number.isInteger(p.level ?? 3) || (p.level ?? 3) < 1 || (p.level ?? 3) > 10 || !WEAPON_CLASSES[p.weaponClass ?? 'sword']) throw Error(`participants[${index}] 的 side、scale、level 或 weaponClass 无效`);
      if (p.personnel !== undefined && (!Number.isInteger(p.personnel) || p.personnel < 1 || p.personnel > 10000 || (p.scale ?? 'hero') === 'hero')) throw Error(`participants[${index}].personnel 只适用于部队，范围1—10000`);
      const unit = generateUnit({ name: String(p.name ?? '试战单位' + (index + 1)).slice(0,80), side: p.side as 'ally' | 'enemy', scale: (p.scale ?? 'hero') as 'hero' | 'mook' | 'company',
        level: p.level ?? 3, rulesVersion: 'v2', damageModel: 'wounds-v2', weaponClass: p.weaponClass ?? 'sword', ...(p.personnel !== undefined ? { hpMax: p.personnel } : {}), traits: [] }, { seed: seed + ':' + index, registry: this.registry }).unit;
      unit.id = 'sandbox-unit-' + (index + 1); return unit;
    });
    const setup = { mode: roster.length > 32 ? 'mass' : 'small', field: 'plains', lighting: 'day', mapLayout: 'standard', objectiveMode: 'annihilation', siegeAttacker: 'ally', ...(args.setup as object ?? {}) } as EncounterSetup;
    const choices: Record<string, readonly string[]> = { mode: ['small','mass'], field: ['plains','urban','siege','forest','mountain'], lighting: ['day','night'], mapLayout: ['standard','indoor'], objectiveMode: ['auto','annihilation','siege','control','escort','intercept'], siegeAttacker: ['ally','enemy'] };
    for (const [key, value] of Object.entries(setup)) if (!choices[key]?.includes(value)) throw Error('setup.' + key + ' 无效');
    const protagonistId = roster.find(u => u.side === 'ally')?.id, draft = new PlayerPreparation();
    draft.apply(args, { scope: 'sandbox', setup, roster, protagonistId, unitBindings: Object.fromEntries(roster.map((u,i) => ['u'+(i+1), u.id])), sources: [] });
    const battle = buildEncounter({ roster, setup, context: draft.resolve('sandbox'), protagonistId, commanderId: protagonistId,
      nonLethal: args.nonLethal !== false, seed, registry: this.registry, summonUnit: this.summonUnit });
    return { kind: battle instanceof SmallBattle ? 'small' : 'mass', snapshot: battle.toSnapshot(), setup, opening: encounterPreview(battle, setup) };
  }
  async control(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sync();
    if (args.action === 'reports') {
      const report = args.reportId ? this.data.reports.find(r => r.id === args.reportId) : undefined;
      if (args.reportId && !report) return { error: '找不到该隔离试战战报' };
      return { environment: 'sandbox', report, reports: this.data.reports.map(({ events: _events, opening: _opening, ...summary }) => summary), limit: 20 };
    }
    if (typeof args.requestId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(args.requestId)) return { error: '请提供唯一 requestId' };
    const signature = JSON.stringify(args), receipt = this.receipts.get(args.requestId);
    if (receipt) return receipt.signature === signature ? { ...receipt.result, replayed: true } : { error: 'requestId 已用于其他指令' };
    if (this.busy) return { error: '隔离试战正在结算，请先暂停并等待本次保存完成' };
    if (!['start','restart','close'].includes(String(args.action))) return { error: 'action 须为 start、restart、close 或 reports' };
    this.busy = true;
    let result: Record<string, unknown>;
    let previous: { data: Store; battle: Battle | null; runId: string } | undefined;
    try {
      // Build and validate before replacing any existing sandbox.
      const baseline = args.action === 'start' ? this.build(args) : this.data.baseline;
      if (args.action === 'restart' && !baseline) throw Error('尚无上次试战配置，请先 start');
      this.auto.stop(); if (this.battle) this.save(true);
      previous = { data: structuredClone(this.data), battle: this.battle, runId: this.runId };
      if (args.action === 'close') this.battle = null;
      else {
        this.data.baseline = structuredClone(baseline!); this.runId = randomId(); this.battle = this.restore(baseline!.snapshot, baseline!.kind);
        await this.enemyTurns(); this.save();
      }
      result = { status: 'completed', environment: 'sandbox', active: !!this.battle, reportId: this.runId,
        opening: this.battle ? this.data.baseline?.opening : undefined, message: this.battle ? '隔离试战已开启；游戏工具操作此试战，close 后返回正式档案' : '隔离试战已关闭，后续游戏工具返回正式档案' };
    } catch (error) {
      if (previous) { this.data = previous.data; this.battle = previous.battle; this.runId = previous.runId; }
      result = { status: 'failed', error: errorText(error), environment: 'sandbox' };
    }
    finally { this.busy = false; }
    if (this.battle) result.state = this.api.state();
    this.receipts.set(args.requestId, { signature, result });
    while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
    return result;
  }
}
