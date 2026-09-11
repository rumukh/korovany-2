import { MAX_UPGRADE_LEVEL } from './config';
import type { MetaProfile, RunRewards, UpgradeId, Upgrades } from './types';

export function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${label} must be a plain object`);
  }
}

export function boundedNumber(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isInteger(value))) throw new Error(`${label} is out of bounds`);
  return value;
}

export function validatedUpgrades(value: unknown, partial = false): Upgrades {
  assertRecord(value, 'Upgrades');
  if (Object.keys(value).some(k => !['damage', 'vitality', 'logistics'].includes(k))) throw new Error('Unknown upgrade');
  return {
    damage: boundedNumber(value.damage ?? (partial ? 0 : undefined), 'damage', 0, MAX_UPGRADE_LEVEL, true),
    vitality: boundedNumber(value.vitality ?? (partial ? 0 : undefined), 'vitality', 0, MAX_UPGRADE_LEVEL, true),
    logistics: boundedNumber(value.logistics ?? (partial ? 0 : undefined), 'logistics', 0, MAX_UPGRADE_LEVEL, true),
  };
}

export function createProfile(): MetaProfile {
  return { namespace: 'korovany2:profile', version: 1, renown: 0,
    upgrades: { damage: 0, vitality: 0, logistics: 0 }, completedRuns: [] };
}

export function restoreProfile(value: unknown): MetaProfile {
  assertRecord(value, 'Profile');
  if (value.namespace !== 'korovany2:profile' || value.version !== 1) throw new Error('Unsupported profile format');
  const renown = boundedNumber(value.renown, 'Renown', 0, 1_000_000, true);
  const upgrades = validatedUpgrades(value.upgrades);
  if (!Array.isArray(value.completedRuns) || value.completedRuns.length > 10_000 ||
      value.completedRuns.some(id => typeof id !== 'string' || !id || id.length > 128) ||
      new Set(value.completedRuns).size !== value.completedRuns.length) throw new Error('Invalid completed run IDs');
  return { namespace: 'korovany2:profile', version: 1, renown, upgrades, completedRuns: [...value.completedRuns] };
}

export function metaUpgradeCost(level: number): number {
  boundedNumber(level, 'Upgrade level', 0, MAX_UPGRADE_LEVEL, true);
  return 30 + level * 30;
}

export function claimRewards(profile: MetaProfile, rewards: RunRewards): MetaProfile {
  const result = restoreProfile(profile);
  assertRecord(rewards, 'Rewards');
  if (typeof rewards.runId !== 'string' || !rewards.runId || rewards.runId.length > 128 ||
      typeof rewards.victory !== 'boolean' || rewards.claimed !== false) throw new Error('Invalid run rewards');
  boundedNumber(rewards.renown, 'Reward renown', 0, 500, true);
  if (result.completedRuns.includes(rewards.runId)) return result;
  if (result.completedRuns.length >= 10_000) throw new Error('Profile run history is full');
  result.completedRuns.push(rewards.runId);
  result.renown = boundedNumber(result.renown + rewards.renown, 'Renown', 0, 1_000_000, true);
  return result;
}

export function purchaseMetaUpgrade(profile: MetaProfile, id: UpgradeId): MetaProfile {
  const result = restoreProfile(profile);
  if (!['damage', 'vitality', 'logistics'].includes(id)) throw new Error('Unknown upgrade');
  const level = result.upgrades[id], cost = metaUpgradeCost(level);
  if (level >= MAX_UPGRADE_LEVEL) throw new Error('Upgrade already at maximum level');
  if (result.renown < cost) throw new Error('Insufficient renown');
  result.renown -= cost;
  result.upgrades[id]++;
  return result;
}
