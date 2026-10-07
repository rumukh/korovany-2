import { describe, expect, test } from 'vitest';
import {
  ALLY_KITS, battleSnapshot, commandBattle, ENEMY_KITS, joinBattle, startBattle, suggestCommand, tickBattle,
  type BattleInput, type BattleSetup, type BattleState, type EnemyKind,
} from '../src/game/battle';

/** Perfect reactions: a parry for each blow aimed at the hero (a dodge when heavy), pressed on its impact tick. */
function reaction(state: BattleState): BattleInput {
  const hit = state.action?.hits.find(h => h.target === 'hero' && h.outcome === 'pending' && h.pressed === null &&
    h.impact === state.now + 1);
  return hit ? hit.heavy ? { dodge: true } : { parry: true } : {};
}

/** Plays to the end with suggested commands; `react` false never answers a blow. */
function finish(state: BattleState, react = true, limit = 50_000): BattleState {
  for (let i = 0; i < limit && state.phase !== 'victory' && state.phase !== 'defeat'; i++) {
    if (state.phase === 'command') commandBattle(state, suggestCommand(battleSnapshot(state)));
    else tickBattle(state, react ? reaction(state) : {});
  }
  return state;
}

/** Ticks without reacting until an enemy move that strikes a ward begins; false when the battle ends first. */
function toWardBlow(state: BattleState, command = (s: BattleState) => suggestCommand(battleSnapshot(s))): boolean {
  for (let i = 0; i < 20_000; i++) {
    if (state.phase === 'victory' || state.phase === 'defeat') return false;
    if (state.phase === 'command') commandBattle(state, command(state));
    else if (state.action!.hits.some(h => h.target !== 'hero') && state.now === state.action!.start) return true;
    else tickBattle(state, reaction(state));
  }
  return false;
}

const garrison: BattleSetup['enemies'] = [{ id: 'soldier', kind: 'soldier' }, { id: 'archer', kind: 'archer' }, { id: 'captain', kind: 'captain' }];

describe('battle engine: campaign participants', () => {
  test('a battle state is plain data: a JSON copy continues exactly like the original', () => {
    const setup: BattleSetup = {
      seed: 7, faction: 'guard', enemies: [...garrison, { id: 'wolf', kind: 'wolf', hp: 30 }],
      allies: [{ id: 'ally', kind: 'archer' }], wards: [{ id: 'convoy', hp: 200, maxHp: 280 }],
      hero: { hp: 150, maxHp: 210, damage: 40 },
    };
    const state = startBattle(setup);
    expect(state).toEqual(startBattle(setup));
    for (let i = 0; i < 400; i++) {
      if (state.phase === 'command') commandBattle(state, suggestCommand(battleSnapshot(state)));
      else tickBattle(state, reaction(state));
    }
    const copy: BattleState = JSON.parse(JSON.stringify(state));
    expect(finish(copy)).toEqual(finish(state));
    expect(state.phase).toBe('victory');
    const frozen = battleSnapshot(state);
    expect(battleSnapshot(state)).toEqual(frozen);
    expect(state.hero.damage).toBe(40);
    expect(state.enemies.find(e => e.id === 'wolf')!.maxHp).toBe(ENEMY_KITS.wolf.maxHp);
  });

  test('allies act on the timeline and strike the weakest enemy with their kit damage; nobody strikes them', () => {
    const state = startBattle({
      seed: 'allies', faction: 'elf', opening: 'first-strike', enemies: [{ id: 'big', kind: 'captain' }, { id: 'small', kind: 'soldier', hp: 50 }],
      allies: [{ id: 'cart', kind: 'siege-cart' }, { id: 'watch', kind: 'soldier' }],
    });
    expect(battleSnapshot(state).allies).toEqual([{ id: 'cart', kind: 'siege-cart' }, { id: 'watch', kind: 'soldier' }]);
    expect(battleSnapshot(state).order).toContain('watch');
    const supporters = new Set<string>();
    for (let i = 0; i < 20_000 && supporters.size < 2 && state.phase !== 'victory'; i++) {
      if (state.phase === 'command') { commandBattle(state, { type: 'attack', target: 'big' }); continue; }
      const action = state.action!;
      if ((action.actor === 'cart' || action.actor === 'watch') && state.now === action.start) {
        supporters.add(action.actor);
        expect(action.target).toBe(state.enemies.filter(e => e.hp > 0).sort((a, b) => a.hp - b.hp)[0]!.id);
      }
      // Enemy blows come only at the hero (there are no wards here), never at an ally.
      expect(action.hits.every(h => h.target === 'hero')).toBe(true);
      tickBattle(state, reaction(state));
    }
    expect(supporters).toEqual(new Set(['cart', 'watch']));
    const blows = state.log.filter(e => e.kind === 'damage' && (e.actor === 'cart' || e.actor === 'watch'));
    expect(blows.length).toBeGreaterThan(0);
    for (const entry of blows) {
      expect(entry.amount).toBeLessThanOrEqual(Math.round(ALLY_KITS[entry.actor === 'cart' ? 'siege-cart' : 'soldier'].damage * 1.25));
    }
  });

  test('enemies strike wards that nobody can parry; protect turns those blows on the hero', () => {
    let found = false;
    for (let seed = 0; seed < 60 && !found; seed++) {
      const state = startBattle({ seed, faction: 'guard', enemies: garrison, wards: [{ id: 'convoy', hp: 280, maxHp: 280 }] });
      if (!toWardBlow(state)) continue;
      found = true;
      const action = state.action!, hit = action.hits[0]!;
      expect(hit.target).toBe('convoy');
      const before = state.wards[0]!.hp;
      for (let tick = 0; state.action?.id === action.id && tick < 400; tick++) tickBattle(state, { parry: true });
      expect(action.hits.every(h => h.outcome === 'hit' && h.reaction === null)).toBe(true);
      expect(state.wards[0]!.hp).toBe(before - action.hits.reduce((sum, h) => sum + h.damage, 0));
    }
    expect(found).toBe(true);
    // While the hero guards, a blow aimed at a ward comes at the hero instead.
    let redirected = 0;
    for (let seed = 0; seed < 40 && redirected === 0; seed++) {
      const state = startBattle({ seed, faction: 'guard', enemies: garrison, wards: [{ id: 'convoy', hp: 280, maxHp: 280 }], opening: 'first-strike' });
      for (let i = 0; i < 20_000 && state.phase !== 'victory' && state.phase !== 'defeat'; i++) {
        if (state.phase === 'command') {
          commandBattle(state, { type: 'protect' });
          expect(state.hero.guarding).toBe(true);
          continue;
        }
        const entries = state.log.length;
        tickBattle(state, reaction(state));
        if (state.log.slice(entries).some(e => e.kind === 'protect' && e.target === 'convoy')) {
          redirected++;
          expect(state.action!.hits.every(h => h.target === 'hero')).toBe(true);
          break;
        }
        if (state.action) expect(state.action.hits.every(h => h.target === 'hero')).toBe(true);
      }
    }
    expect(redirected).toBe(1);
    const noWards = startBattle({ seed: 1, faction: 'elf', enemies: garrison, opening: 'first-strike' });
    expect(battleSnapshot(noWards).commands.map(c => c.id)).not.toContain('protect');
    commandBattle(noWards, { type: 'protect' });
    expect(noWards.notice).toBe('unavailable');
  });

  test('a ward at zero falls for the rest of the battle; bulwark repairs the standing ones', () => {
    let fallen = false;
    for (let seed = 0; seed < 80 && !fallen; seed++) {
      const state = startBattle({ seed, faction: 'guard', enemies: garrison, wards: [{ id: 'shipment', hp: 3, maxHp: 170 }] });
      if (!toWardBlow(state)) continue;
      fallen = true;
      const action = state.action!;
      while (state.action?.id === action.id) tickBattle(state);
      expect(state.wards[0]!.hp).toBe(0);
      expect(state.log.some(e => e.kind === 'ward-down' && e.target === 'shipment')).toBe(true);
      finish(state);
      const later = state.log.filter(e => e.kind === 'damage' && e.target === 'shipment');
      expect(later.every(e => e.id <= state.log.find(x => x.kind === 'ward-down')!.id)).toBe(true);
    }
    expect(fallen).toBe(true);
    const state = startBattle({ seed: 2, faction: 'guard', enemies: garrison, opening: 'first-strike',
      wards: [{ id: 'convoy', hp: 100, maxHp: 280 }], hero: { hp: 100, maxHp: 180, damage: 32 } });
    state.hero.ap = 3;
    commandBattle(state, { type: 'skill', skill: 'bulwark' });
    expect(state.wards[0]!.hp).toBe(130);
    expect(state.hero.hp).toBe(125);
  });

  test('the suggested commands cover a failing wagon yet always finish the battle', () => {
    for (const faction of ['elf', 'guard', 'villain'] as const) {
      const state = startBattle({ seed: faction, faction, enemies: [{ id: 'archer', kind: 'archer' }], wards: [{ id: 'convoy', hp: 70, maxHp: 250 }] });
      let covered = 0;
      for (let i = 0; i < 50_000 && state.phase !== 'victory' && state.phase !== 'defeat'; i++) {
        if (state.phase !== 'command') { tickBattle(state, reaction(state)); continue; }
        const command = suggestCommand(battleSnapshot(state));
        if (command.type === 'protect') covered++;
        commandBattle(state, command);
      }
      expect(state.phase, faction).toBe('victory');
      expect(covered, faction).toBeGreaterThan(0);
    }
  });

  test('a cart fights from the convoy: when the convoy is wrecked, its weapon leaves the battle', () => {
    const attack = (s: BattleState) => ({ type: 'attack' as const, target: s.enemies.filter(e => e.hp > 0).sort((a, b) => a.hp - b.hp)[0]!.id });
    let wrecked = 0;
    for (let seed = 0; seed < 80 && wrecked === 0; seed++) {
      const state = startBattle({ seed, faction: 'villain', enemies: garrison, allies: [{ id: 'cart', kind: 'siege-cart' }, { id: 'watch', kind: 'soldier' }],
        wards: [{ id: 'convoy', hp: 3, maxHp: 250 }] });
      if (!toWardBlow(state, attack)) continue;
      wrecked++;
      const action = state.action!;
      while (state.action?.id === action.id) tickBattle(state, reaction(state));
      expect(state.wards[0]!.hp).toBe(0);
      expect(state.allies.map(a => a.id)).toEqual(['watch']);
      expect(battleSnapshot(state).allies).toEqual([{ id: 'watch', kind: 'soldier' }]);
      expect(battleSnapshot(state).order).not.toContain('cart');
      for (let i = 0; i < 50_000 && state.phase !== 'victory' && state.phase !== 'defeat'; i++) {
        if (state.phase === 'command') commandBattle(state, attack(state));
        else tickBattle(state, reaction(state));
        expect(state.action?.actor).not.toBe('cart');
      }
      expect(state.phase).toBe('victory');
    }
    expect(wrecked).toBe(1);
    // A cart is silenced only by its own wagon: a wrecked shipment leaves it fighting.
    let spared = 0;
    for (let seed = 0; seed < 80 && spared === 0; seed++) {
      const state = startBattle({ seed, faction: 'elf', enemies: garrison, allies: [{ id: 'cart', kind: 'arrow-cart' }],
        wards: [{ id: 'shipment', hp: 1, maxHp: 170 }] });
      if (!toWardBlow(state, attack)) continue;
      spared++;
      const action = state.action!;
      while (state.action?.id === action.id) tickBattle(state, reaction(state));
      expect(state.wards[0]!.hp).toBe(0);
      expect(state.allies.map(a => a.id)).toEqual(['cart']);
    }
    expect(spared).toBe(1);
  });

  test('joining enemies start far, act after a turn and keep the battle going; finished battles cannot be joined', () => {
    const state = startBattle({ seed: 'join', faction: 'villain', enemies: [{ id: 'warlord', kind: 'warlord', hp: 300 }], opening: 'first-strike' });
    joinBattle(state, [{ id: 'r1', kind: 'soldier' }, { id: 'r2', kind: 'soldier' }]);
    const snapshot = battleSnapshot(state);
    expect(snapshot.enemies.filter(e => e.id.startsWith('r')).map(e => e.band)).toEqual(['far', 'far']);
    expect(snapshot.order[0]).toBe('hero');
    expect(state.log.filter(e => e.kind === 'join').map(e => e.actor)).toEqual(['r1', 'r2']);
    expect(() => joinBattle(state, [{ id: 'r1', kind: 'soldier' }])).toThrow();
    expect(() => joinBattle(state, [{ id: 'hero', kind: 'soldier' }])).toThrow();
    expect(() => joinBattle(state, Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, kind: 'soldier' as const })))).toThrow();
    finish(state);
    expect(state.phase).toBe('victory');
    expect(state.enemies.every(e => e.hp === 0)).toBe(true);
    expect(() => joinBattle(state, [{ id: 'late', kind: 'soldier' }])).toThrow();
  });

  test('a wagon never acts but must be destroyed', () => {
    const state = startBattle({ seed: 'wagon', faction: 'elf', enemies: [{ id: 'wagon', kind: 'caravan', hp: 120 }] });
    const s = battleSnapshot(state);
    expect(s.phase).toBe('command');
    expect(s.order.every(id => id === 'hero')).toBe(true);
    finish(state);
    expect(state.phase).toBe('victory');
    expect(state.log.filter(e => e.kind === 'damage').every(e => e.actor === 'hero')).toBe(true);
  });

  test('every enemy kind fights with its kit and loses to perfect reactions', () => {
    for (const kind of Object.keys(ENEMY_KITS) as EnemyKind[]) {
      for (const faction of ['elf', 'guard', 'villain'] as const) {
        const state = finish(startBattle({ seed: `${kind}-${faction}`, faction, enemies: [{ id: 'foe', kind }, { id: 'aide', kind: 'soldier' }] }));
        expect(state.phase, `${faction} vs ${kind}`).toBe('victory');
        expect(state.hero.hp, `${faction} vs ${kind}`).toBe(state.hero.maxHp);
      }
    }
  });

  test('setups are validated: kinds, IDs, HP, allies, wards and roster sizes', () => {
    const valid: BattleSetup = { seed: 1, faction: 'elf', enemies: [{ id: 'a', kind: 'soldier' }] };
    expect(() => startBattle(valid)).not.toThrow();
    for (const bad of [
      { ...valid, enemies: [] }, { ...valid, enemies: [{ id: 'a', kind: 'dragon' }] },
      { ...valid, enemies: [{ id: 'a', kind: 'soldier', hp: 999 }] }, { ...valid, enemies: [{ id: 'a', kind: 'soldier', hp: 0 }] },
      { ...valid, enemies: [{ id: 'a', kind: 'soldier' }, { id: 'a', kind: 'archer' }] },
      { ...valid, enemies: [{ id: 'hero', kind: 'soldier' }] },
      { ...valid, enemies: Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, kind: 'wolf' })) },
      { ...valid, allies: [{ id: 'b', kind: 'dragon' }] }, { ...valid, allies: [{ id: 'a', kind: 'soldier' }] },
      { ...valid, allies: Array.from({ length: 5 }, (_, i) => ({ id: `ally${i}`, kind: 'archer' })) },
      { ...valid, wards: [{ id: 'tower', hp: 1, maxHp: 1 }] }, { ...valid, wards: [{ id: 'convoy', hp: 300, maxHp: 280 }] },
      { ...valid, hero: { hp: 200, maxHp: 120, damage: 24 } }, { ...valid, encounter: 'troll' },
    ]) expect(() => startBattle(bad as BattleSetup), JSON.stringify(bad)).toThrow();
  });
});
