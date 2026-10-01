import { SmallBattle, MassBattle, V11_OVERFLOW_D20, V11_OVERFLOW_TW, LITE_D20, generatedLayeredField,
  environmentTags, recommendedFormationSlots, cellLabel, personnel, type Combatant, type Trait } from '../../engine/src/index.js';
import { assertBattleCapacity } from '../../engine/src/battle-limits.js';
import { newBattleCommanderProfiles } from '../../engine/src/commander-profile.js';
import { prepareBattleObjective, prepareMassRoster } from './battle-setup.js';
import type { EncounterSetup } from './jev-context.js';
import type { LlmEncounterContext } from './llm-context.js';

export interface EncounterBuild {
  roster: Combatant[];
  setup: EncounterSetup;
  context?: LlmEncounterContext;
  protagonistId?: string;
  commanderId?: string;
  nonLethal: boolean;
  seed: string;
  registry: Map<string, Trait>;
  summonUnit: NonNullable<ConstructorParameters<typeof SmallBattle>[0]['summonUnit']>;
  preparedField?: ReturnType<typeof generatedLayeredField>;
}

/** The live UI and MCP preview construct the same battle once, with the same deployment and rule checks. */
export function buildEncounter(input: EncounterBuild): SmallBattle | MassBattle {
  const { roster, setup, context, seed, registry: traitRegistry, summonUnit } = input;
  if (!roster.some(u => u.side === 'ally' && u.hp > 0 && u.status === 'ready') || !roster.some(u => u.side === 'enemy' && u.hp > 0 && u.status === 'ready')) throw Error('开战前必须同时有可参战的我方与敌方单位');
  assertBattleCapacity(roster, setup.mode);
  const v2 = roster.every(u => u.rulesVersion === 'v2');
  const tags = environmentTags([setup.field, ...(setup.lighting === 'night' ? ['night'] : []), ...(setup.mode === 'small' && setup.objectiveMode === 'siege' ? ['siege'] : [])]);
  if (setup.mode === 'mass') {
    const combatants = prepareMassRoster(roster);
    const battle = new MassBattle({ nonLethal: input.nonLethal, seed: v2 ? seed : undefined,
      formationSlots: recommendedFormationSlots(combatants), ...(v2 ? { rules: V11_OVERFLOW_TW } : {}),
      combatants, traitRegistry, commanderId: input.commanderId, zones: ['左翼','中军','右翼'], summonUnit, field: { tags: v2 ? tags : setup.field ? [setup.field] : [] } });
    battle.commanderProfiles = newBattleCommanderProfiles(context?.commanders); battle.start(); return battle;
  }
  let battlefield = input.preparedField ?? (v2 ? generatedLayeredField(seed, setup.mapLayout === 'indoor' ? 5 : 7, setup.mapLayout === 'indoor' ? 7 : 13, tags,
    { roster, attackingSide: setup.siegeAttacker, design: context?.mapDesign, plan: context?.battlefieldPlan, unitBindings: context?.unitBindings }) : undefined);
  if (battlefield && !input.preparedField) battlefield = prepareBattleObjective(battlefield, roster, setup.objectiveMode, input.protagonistId, setup.siegeAttacker, context?.vipId);
  if (context && battlefield?.generation?.notes?.length) context.designDetail = [context.designDetail, ...battlefield.generation.notes].filter(Boolean).join('；');
  if (context?.mapDesign && battlefield?.generation?.source === 'context') context.mapDesign = structuredClone(battlefield.generation.design);
  if (context && battlefield?.objective.kind === 'escape') { context.vipId = battlefield.objective.unitId; context.vipName = roster.find(u => u.id === context.vipId)?.name; }
  const battle = new SmallBattle({ nonLethal: input.nonLethal, ...(v2 ? { battlefield } : {}), rules: v2 ? V11_OVERFLOW_D20 : LITE_D20,
    combatants: structuredClone(roster), seed: v2 ? seed : undefined, traitRegistry, summonUnit, field: { tags: v2 ? tags : setup.field ? [setup.field] : [] } });
  battle.commanderProfiles = newBattleCommanderProfiles(context?.commanders); battle.start(); return battle;
}

export function encounterPreview(battle: SmallBattle | MassBattle, setup: EncounterSetup) {
  const field = battle instanceof SmallBattle ? battle.battlefield : undefined;
  return {
    kind: battle instanceof SmallBattle ? 'small' : 'mass', rules: battle.rules.id, setup, commanders: battle.commanderProfiles,
    sides: (['ally','enemy'] as const).map(side => { const units = battle.combatants.filter(u => u.side === side); return { side, cards: units.length, personnel: units.reduce((total,u) => total + (u.scale === 'hero' ? 1 : personnel(u)), 0) }; }),
    units: battle.combatants.map(u => ({ id: u.id, name: u.name, side: u.side, scale: u.scale, hp: u.hp, hpMax: u.base.hpMax,
      pos: u.pos, cell: field && u.pos !== undefined ? cellLabel(field, u.pos) : undefined, formationPosition: u.formationPosition })),
    ...(field ? { map: { width: field.width, height: field.height, tiles: field.tiles, groundHeight: field.groundHeight,
      structures: field.structures, landmarks: field.landmarks, objective: field.objective } } : {}),
    ...(battle instanceof MassBattle ? { attachedHeroes: [...battle.attached.entries()], formationSlots: battle.formationSlots } : {}),
  };
}
