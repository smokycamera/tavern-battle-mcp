import { expect, it } from 'vitest';
import { generateUnit } from '../../engine/src/index.js';
import { PlayerPreparation } from './player-preparation.js';
import type { EncounterSetup } from './jev-context.js';

function fixture() {
  return { scope: 'chat-a:roster-v1', setup: { mode: 'small', field: 'plains', lighting: 'day', mapLayout: 'standard', objectiveMode: 'annihilation', siegeAttacker: 'ally' } as EncounterSetup,
    roster: (['ally','enemy'] as const).map(side => generateUnit({ name: side, side, scale: 'hero', level: 3, rulesVersion: 'v2', damageModel: 'wounds-v2', traits: [] }, { seed: side }).unit), unitBindings: {}, sources: [] };
}
it('validates a next-battle plan with real deployment rules and preserves the roster', () => {
  const input = fixture(), before = JSON.stringify(input.roster), draft = new PlayerPreparation();
  draft.apply({ commanders: { ally: { ability: 'expert', style: 'flanking', preferences: { risk: 3, reserve: 1 } } }, battlefield: { scene: 'field', layout: 'lanes', landmarks: [{ kind: 'hill', anchor: 'center_left', label: '西侧高地' }] } }, input);
  const context = draft.resolve(input.scope)!;
  expect(context.commanders?.ally).toMatchObject({ ability: 'expert', style: 'flanking', preferences: { risk: 3 } });
  expect(context.battlefieldPlan?.landmarks?.[0]?.label).toBe('西侧高地');
  expect(JSON.stringify(input.roster)).toBe(before);
  context.commanders!.ally!.style = 'aggressive'; expect(draft.resolve(input.scope)?.commanders?.ally?.style).toBe('flanking');
  expect(draft.resolve('chat-b')).toBeUndefined(); expect(draft.battlefield).toBe('');
});
it('rejects unsupported or impossible plans without replacing a valid draft', () => {
  const input = fixture(), draft = new PlayerPreparation();
  draft.apply({ commanders: { ally: { ability: 'regular', style: 'balanced' } } }, input);
  const before = draft.resolve(input.scope);
  expect(() => draft.apply({ commanders: { ally: { ability: 'god', style: 'balanced' } } }, input)).toThrow('无效');
  expect(() => draft.apply({ battlefield: { scene: 'invented', landmarks: [] } }, input)).toThrow('无效');
  expect(() => draft.apply({ battlefield: { scene: 'interior', landmarks: [{ kind: 'forest', anchor: 'center' }] } }, input)).toThrow();
  expect(() => draft.apply({ battlefield: { landmarks: [{ kind: 'hill', anchor: 'center' }] } }, { ...input, setup: { ...input.setup, mode: 'mass' } })).toThrow('会战');
  expect(draft.resolve(input.scope)).toEqual(before);
});
