import type { FactionDefinition, FactionId, Upgrades } from './types';

export const TICK_RATE = 60;
export const SAVE_KEY = 'korovany2:campaign';
export const PROFILE_KEY = 'korovany2:profile';
export const MAX_UPGRADE_LEVEL = 3;
export const EMPTY_UPGRADES: Readonly<Upgrades> = Object.freeze({ damage: 0, vitality: 0, logistics: 0 });
export const FACTIONS: Readonly<Record<FactionId, Readonly<FactionDefinition>>> = Object.freeze({
  elf: Object.freeze({
    id: 'elf', nameKey: 'faction.elf', abilityKey: 'ability.volley', convoyKey: 'convoy.ranger',
    maxHp: 120, speed: 7.6, damage: 24, attackRange: 17, attackCooldown: 0.45,
    abilityCooldown: 10, color: 0x71c69a,
  }),
  guard: Object.freeze({
    id: 'guard', nameKey: 'faction.guard', abilityKey: 'ability.bulwark', convoyKey: 'convoy.repair',
    maxHp: 180, speed: 6.3, damage: 32, attackRange: 3.5, attackCooldown: 0.55,
    abilityCooldown: 12, color: 0xe3b661,
  }),
  villain: Object.freeze({
    id: 'villain', nameKey: 'faction.villain', abilityKey: 'ability.cleave', convoyKey: 'convoy.siege',
    maxHp: 150, speed: 6.8, damage: 38, attackRange: 3.8, attackCooldown: 0.62,
    abilityCooldown: 9, color: 0xcb757e,
  }),
});
