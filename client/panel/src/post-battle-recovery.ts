import { applyRecovery, recoveryCapacity } from '../../engine/src/recovery.js';
import type { Trait } from '../../engine/src/types.js';
import { materializeUnitRecord, unitRecordFromCombatant, type UnitRecord } from './unit-state.js';

/** Explicit out-of-battle treatment. Cohorts recover wounded personnel, not permanent casualties. */
export function recoverUnitRecord(record: UnitRecord, registry: Map<string, Trait>): UnitRecord {
  if (record.retired || record.status === 'dead' || record.hp <= 0 && record.status !== 'dying') throw Error('阵亡或解散档案不能通过战后恢复复活');
  const unit = materializeUnitRecord(record, registry);
  if (unit.status === 'routing' || unit.status === 'fled') unit.status = 'ready';
  applyRecovery(unit, recoveryCapacity(unit));
  if (unit.hp > 0 && unit.status === 'dying') unit.status = 'ready';
  if (unit.base.moraleMax !== undefined) unit.morale = unit.base.moraleMax;
  return unitRecordFromCombatant(unit, record, { kind: 'update' });
}
