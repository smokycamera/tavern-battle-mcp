import { expect, it } from 'vitest';
import { generateUnit, traitRegistry } from '../../engine/src/index.js';
import { editUnitRecord, deployUnitRecord, unitRecordFromCombatant } from './unit-state.js';
import { recoverUnitRecord } from './post-battle-recovery.js';

it('makes healed dying heroes deployable and recovers only reversible cohort losses', () => {
  const reg = traitRegistry();
  const hero = generateUnit({ name: 'hero', side: 'ally', scale: 'hero', level: 3, rulesVersion: 'v2', traits: [] }, { seed: 'recover' }).unit;
  hero.hp = 0; hero.status = 'dying'; hero.xp = 123;
  const record = unitRecordFromCombatant(hero), recovered = recoverUnitRecord(record, reg);
  const edited = editUnitRecord(record, { ...record, hp: record.base.hpMax }, reg);
  for (const result of [recovered, edited]) {
    expect(result).toMatchObject({ hp: record.base.hpMax, status: 'ready', xp: 123 });
    expect(deployUnitRecord([result], [], result.id, reg)[0]?.status).toBe('ready');
    expect(result.snapshot?.weapon).toEqual(record.snapshot?.weapon);
  }
  expect(record.status).toBe('dying');
  expect(() => recoverUnitRecord({ ...record, status: 'dead' }, reg)).toThrow('阵亡');
  const troop = generateUnit({ name: 'troop', side: 'ally', scale: 'company', level: 3, rulesVersion: 'v2', traits: [] }, { seed: 'recover-troop' }).unit;
  troop.hp = 60; troop.base.hpMax = 100; troop.recoverableWounded = 15;
  expect(recoverUnitRecord(unitRecordFromCombatant(troop), reg)).toMatchObject({ hp: 75, recoverableWounded: 0 });
});
