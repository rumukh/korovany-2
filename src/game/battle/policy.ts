import type { BattleCommand, BattleEnemySnapshot, BattleSnapshot } from './types';

const weakest = (list: readonly BattleEnemySnapshot[]): BattleEnemySnapshot =>
  [...list].sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id))[0]!;

/**
 * A simple, deterministic command for the hero's turn: heal when low, use each faction's skills in their obvious
 * situations, otherwise attack the weakest reachable enemy. The balance bots use it so that reaction skill is the only
 * variable they measure; the sandbox offers it as a suggestion and for automatic commands. Call it only on the hero's
 * turn of an unfinished battle.
 */
export function suggestCommand(s: BattleSnapshot): BattleCommand {
  const hero = s.hero, living = s.enemies.filter(e => e.hp > 0);
  const enabled = (id: string): boolean => s.commands.some(option => option.id === id && option.enabled);
  const close = living.filter(e => e.band === 'close'), far = living.filter(e => e.band === 'far');
  if (hero.hp < hero.maxHp * 0.35 && enabled('tonic')) return { type: 'item', item: 'tonic' };
  if (hero.faction === 'elf') {
    if (close.filter(e => e.kind !== 'archer').length >= 2 && enabled('fall-back')) {
      return { type: 'skill', skill: 'fall-back', target: weakest(living).id };
    }
    if (living.length >= 2 && enabled('volley')) return { type: 'skill', skill: 'volley' };
    const target = weakest(far.length ? far : living);
    if (hero.ap >= 4 && enabled('aimed-shot')) return { type: 'skill', skill: 'aimed-shot', target: target.id };
    return { type: 'attack', target: target.id };
  }
  if (hero.faction === 'guard') {
    if (hero.hp < hero.maxHp * 0.5 && enabled('bulwark')) return { type: 'skill', skill: 'bulwark' };
    const target = weakest(close.length ? close : living);
    if (hero.ap >= 3 && enabled('shield-bash') && !target.broken && target.breakMax - target.breakMeter <= 3) {
      return { type: 'skill', skill: 'shield-bash', target: target.id };
    }
    return { type: 'attack', target: target.id };
  }
  if (far.length >= 2 && enabled('warcry')) return { type: 'skill', skill: 'warcry' };
  if (close.length >= 2 && enabled('cleave')) return { type: 'skill', skill: 'cleave' };
  return { type: 'attack', target: weakest(close.length ? close : living).id };
}
