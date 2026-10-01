import { COMMANDER_ABILITIES, COMMANDER_STYLES, normalizeCommanderProfiles } from '../../engine/src/commander-profile.js';
import { BATTLEFIELD_PLAN_PROMPT, normalizeBattlefieldPlan, LANDMARK_KINDS, LANDMARK_ANCHORS } from '../../engine/src/small/battlefield-plan.js';
import { validateSceneIntentEvidence, type NarrativeSource } from '../../engine/src/small/scene-intent.js';
import { generatedLayeredField } from '../../engine/src/small/layered-generator.js';
import type { Combatant } from '../../engine/src/types.js';
import { prepareBattleObjective } from './battle-setup.js';
import { encounterRequest, normalizeContextSettings, STYLE_PRESETS, type EncounterSetup } from './jev-context.js';
import type { LlmEncounterContext } from './llm-context.js';
import { escapeHtml as esc } from './battle-presentation.js';

interface PreparationInputs {
  scope: string;
  setup: EncounterSetup;
  roster: Combatant[];
  protagonistId?: string;
  unitBindings: Record<string, string>;
  sources: NarrativeSource[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An optional next-battle draft. Shared by local UI and MCP; never edits a running battle. */
export class PlayerPreparation {
  private draft?: { scope: string; context: LlmEncounterContext };
  private editScope = '';
  commanders = '';
  battlefield = '';
  private sync(scope: string): void {
    if (scope === this.editScope) return;
    this.editScope = scope; this.commanders = ''; this.battlefield = ''; this.draft = undefined;
  }
  clear(): void { this.draft = undefined; this.commanders = ''; this.battlefield = ''; }
  resolve(scope: string): LlmEncounterContext | undefined {
    this.sync(scope);
    return this.draft ? structuredClone(this.draft.context) : undefined;
  }
  apply(value: Record<string, unknown>, input: PreparationInputs): void {
    this.sync(input.scope);
    if (value.clear === true) { this.clear(); return; }
    if (!input.roster.length || input.roster.some(u => u.rulesVersion !== 'v2')) throw Error('指挥与地图准备需要 V2 单位');
    const context: LlmEncounterContext = encounterRequest({ roster: input.roster, setup: input.setup,
      settings: { ...normalizeContextSettings(), enemy: 'manual', scene: 'manual' }, messages: [], windowSize: 0, roles: [], phase: 'preparation' }).base;
    if (value.commanders !== undefined) {
      if (!object(value.commanders) || Object.keys(value.commanders).some(k => !['ally','enemy'].includes(k))) throw Error('commanders 仅接受 ally、enemy');
      for (const [side, p] of Object.entries(value.commanders)) {
        if (!object(p)) throw Error(`commanders.${side} 须为包含 ability 和 style 的对象`);
        if (!(COMMANDER_ABILITIES as readonly unknown[]).includes(p.ability)) throw Error(`commanders.${side}.ability ${p.ability === undefined ? '缺失' : '无效'}；可选：${COMMANDER_ABILITIES.join('、')}`);
        if (!(COMMANDER_STYLES as readonly unknown[]).includes(p.style)) throw Error(`commanders.${side}.style ${p.style === undefined ? '缺失' : '无效'}；可选：${COMMANDER_STYLES.join('、')}`);
        if (p.preferences !== undefined && (!object(p.preferences) || Object.keys(p.preferences).length > 3 || Object.entries(p.preferences).some(([k,v]) => !['reserve','risk','counterattack','cohesion','breach'].includes(k) || !Number.isInteger(v) || Number(v) < 0 || Number(v) > 4))) throw Error('指挥偏好最多3项，每项为0—4整数');
      }
      context.commanders = normalizeCommanderProfiles(value.commanders);
      const enemy = context.commanders.enemy;
      if (enemy) context.enemy = { ability: enemy.ability, style: { ...STYLE_PRESETS[enemy.style].style }, source: 'manual' };
    }
    if (value.battlefield !== undefined) {
      if (context.mode !== 'small') throw Error('会战使用阵位规则，详细格子地图只用于小战');
      if (!object(value.battlefield)) throw Error('battlefield 必须为对象');
      const raw = value.battlefield;
      if (raw.landmarks !== undefined) {
        if (!Array.isArray(raw.landmarks) || raw.landmarks.length > 5) throw Error('battlefield.landmarks 须为最多5个地标的数组');
        raw.landmarks.forEach((mark: unknown, index: number) => {
          const path = `battlefield.landmarks[${index}]`;
          if (!object(mark)) throw Error(path + ' 须为对象，包含 kind 和 anchor');
          if (!(LANDMARK_KINDS as readonly unknown[]).includes(mark.kind)) throw Error(`${path}.kind ${mark.kind === undefined ? '缺失' : '无效'}；可选：${LANDMARK_KINDS.join('、')}`);
          if (!(LANDMARK_ANCHORS as readonly unknown[]).includes(mark.anchor)) throw Error(`${path}.anchor ${mark.anchor === undefined ? '缺失' : '无效'}；可选：${LANDMARK_ANCHORS.join('、')}`);
        });
      }
      let normalized: ReturnType<typeof normalizeBattlefieldPlan>;
      try { normalized = normalizeBattlefieldPlan(value.battlefield); }
      catch (error) { throw Error('battlefield.intent 参数无效：' + (error instanceof Error ? error.message : String(error))); }
      if (normalized.notes.length) throw Error('battlefield 参数无效：' + normalized.notes.map(note => note.replace(/，采用.*|，默认.*|，超出项未采用/g, '')).join('；'));
      if (!normalized.plan) throw Error('battlefield 参数格式无效');
      if (normalized.plan.intent) validateSceneIntentEvidence(normalized.plan.intent, input.sources, Object.keys(input.unitBindings));
      context.battlefieldPlan = normalized.plan; context.unitBindings = input.unitBindings;
      const tags = [...new Set([context.field, ...(context.objectiveMode === 'siege' ? ['siege'] : []), ...(context.mapLayout === 'indoor' ? ['indoor'] : [])])];
      const field = generatedLayeredField('player-preparation-validation', context.mapLayout === 'indoor' ? 5 : 7, context.mapLayout === 'indoor' ? 7 : 13, tags,
        { roster: input.roster, attackingSide: context.siegeAttacker, plan: context.battlefieldPlan, unitBindings: context.unitBindings });
      prepareBattleObjective(field, input.roster, context.objectiveMode, input.protagonistId, context.siegeAttacker);
    }
    context.detail = '玩家准备配置（本场优先采用，开战仍由本体校验）';
    this.draft = { scope: input.scope, context };
    this.commanders = value.commanders === undefined ? '' : JSON.stringify(value.commanders, null, 2);
    this.battlefield = value.battlefield === undefined ? '' : JSON.stringify(value.battlefield, null, 2);
  }
  help(input?: PreparationInputs) {
    return { identity: '玩家视角；我方由玩家下令，敌方由现有 AI 执行。未连接 MCP 时原流程不变。',
      workflow: '先在任务设置选择环境/光照/目标，再提交 commanders 和 battlefield。修改队伍、聊天或任务会使草稿失效。准备后点击开始交战；不会额外请求副API。',
      commanderAbilities: COMMANDER_ABILITIES, commanderStyles: COMMANDER_STYLES,
      preferences: { keys: ['reserve','risk','counterattack','cohesion','breach'], maxKeys: 3, min: 0, max: 4 },
      battlefield: BATTLEFIELD_PLAN_PROMPT,
      example: { commanders: { ally: { ability: 'skilled', style: 'flanking' }, enemy: { ability: 'regular', style: 'cautious' } }, battlefield: { scene: 'field', layout: 'lanes', landmarks: [{ kind: 'hill', anchor: 'center_left', label: '西侧高地' }] } },
      ...(input ? { setup: input.setup, units: Object.entries(input.unitBindings).map(([id, realId]) => ({ id, name: input.roster.find(u => u.id === realId)?.name })), narrativeSources: input.sources,
        prepared: this.resolve(input.scope) ? { commanders: this.draft?.context.commanders, battlefield: this.draft?.context.battlefieldPlan } : null } : {}) };
  }
  render(scope: string): string {
    const prepared = this.resolve(scope);
    return `<details data-detail-id="player-preparation"><summary>指挥风格与地图设计${prepared ? ' · 已准备' : ''}</summary><p>为下一场手动或通过 MCP 配置。应用后优先采用；未应用时沿用原来的开战配置。聊天、队伍或任务改变后需重新应用。</p><label>双方指挥 JSON<textarea data-player-preparation="commanders" rows="4" placeholder='{"ally":{"ability":"skilled","style":"flanking"}}'>${esc(this.commanders)}</textarea></label><label>地图 JSON<textarea data-player-preparation="battlefield" rows="6" placeholder='{"scene":"field","landmarks":[{"kind":"hill","anchor":"center_left"}]}'>${esc(this.battlefield)}</textarea></label><div class="row"><button data-action="player-preparation-apply">校验并应用准备</button><button data-action="player-preparation-clear">清除准备</button></div><p role="status">${prepared ? '已准备，点击开始交战时使用。' : '尚未应用自定义准备。'}</p><details><summary>可用风格与地图格式</summary><p>能力：${COMMANDER_ABILITIES.join(' / ')}。风格：${COMMANDER_STYLES.join(' / ')}。偏好 reserve / risk / counterattack / cohesion / breach，最多3项，每项0—4。</p><pre>${esc(BATTLEFIELD_PLAN_PROMPT)}</pre></details></details>`;
  }
}
