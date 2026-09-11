import type { System, TickContext, World } from '@aegis/core';
import { EMPTY_UPGRADES, FACTIONS, MAX_UPGRADE_LEVEL } from './config';
import { discoverNarrative, narrativeResolved } from './narrative';
import { actors, campaign, Combatant, Intent, type ActorData, type CampaignData } from './state';
import type {
  EffectSnapshot, EventKind, GameInput, InteractionSnapshot, ObjectiveSnapshot, ShopItem,
  UpgradeId, Vec2, WorldBlueprint,
} from './types';
import { distance, findRoadRoute, moveWithCollision, projectSegment } from './world';

const dec = (v: number, dt: number): number => Math.max(0, v - dt);
const direction = (from: Vec2, to: Vec2): Vec2 => {
  const d = distance(from, to) || 1;
  return { x: (to.x - from.x) / d, z: (to.z - from.z) / d };
};

export function emit(world: World, s: CampaignData, kind: EventKind, key: string,
  at: Vec2, amount = 0, targetId = ''): void {
  s.events.push({ id: ++s.eventSequence, tick: world.tick, kind, key, x: at.x, z: at.z, amount, targetId });
  if (s.events.length > 32) s.events.shift();
}

function effect(s: CampaignData, kind: EffectSnapshot['kind'], at: Vec2, radius: number, heading = 0): void {
  const duration = kind === 'shield' ? 0.65 : 0.35;
  s.effects.push({ id: `effect-${++s.transientSequence}`, kind, x: at.x, z: at.z,
    heading, radius, duration, remaining: duration, faction: s.faction });
  if (s.effects.length > 48) s.effects.shift();
}

export function createActor(world: World, kind: ActorData['kind'], id: string, siteId: string,
  at: Vec2, faction: ActorData['faction']): void {
  const hp = kind === 'boss' ? 480 : kind === 'caravan' ? 170 : kind === 'captain' ? 90 : kind === 'archer' ? 48 : 60;
  world.spawn(Combatant({
    x: at.x, z: at.z, id, siteId, faction, kind, home: { x: at.x, z: at.z }, maxHp: hp, hp,
    radius: kind === 'caravan' ? 1.5 : kind === 'boss' ? 1.3 : 0.7,
    damage: kind === 'boss' ? 24 : kind === 'captain' ? 17 : kind === 'archer' ? 10 : 12,
    speed: kind === 'boss' ? 3.6 : kind === 'archer' ? 3 : 3.5,
    attackRange: kind === 'archer' ? 14 : kind === 'boss' ? 4.3 : 2.4,
    cooldown: world.random.range(0.4, 1.2),
  }));
}

function hurtActor(world: World, s: CampaignData, a: ActorData, amount: number): void {
  if (a.hp <= 0 || (a.siteId === 'fortress' && !s.fortress.unlocked)) return;
  const actual = Math.min(a.hp, amount);
  a.hp = Math.max(0, a.hp - amount);
  effect(s, 'hit', a, a.radius + 0.5);
  if (s.faction === 'villain' && s.player.hp > 0) s.player.hp = Math.min(s.player.maxHp, s.player.hp + actual * 0.1);
  if (a.hp > 0) return;
  a.state = 'dead';
  a.stateTime = 0;
  a.target = null;
  s.player.kills++;
  s.player.level = 1 + Math.floor(s.player.kills / 4);
  const coins = a.kind === 'boss' ? 80 : a.kind === 'captain' ? 24 : 14;
  s.pickups.push({ id: `pickup-${++s.transientSequence}`, x: a.x, z: a.z, kind: 'coin', amount: coins });
  if (a.kind !== 'caravan' && a.kind !== 'boss') {
    s.pickups.push({ id: `pickup-${++s.transientSequence}`, x: a.x + 0.6, z: a.z, kind: 'health', amount: 18 });
  }
  if (a.kind === 'caravan') {
    s.raidComplete = true;
    s.pickups.push({ id: `pickup-${++s.transientSequence}`, x: a.x, z: a.z + 0.7, kind: 'supply', amount: 90 });
    emit(world, s, 'raid', 'event.raid', a, 90, a.id);
  }
  if (a.kind === 'boss') s.fortress.bossDefeated = true;
  emit(world, s, 'kill', 'event.kill', a, coins, a.id);
}

function hurtTarget(world: World, s: CampaignData, target: 'player' | 'convoy', amount: number): void {
  const body = target === 'player' ? s.player : s.convoy;
  if (body.hp <= 0 || (target === 'player' && s.player.invulnerable > 0)) return;
  const reduction = target === 'player' && s.faction === 'guard' && s.player.abilityDuration > 0 ? 0.25 : 1;
  body.hp = Math.max(0, body.hp - amount * reduction);
  emit(world, s, 'hurt', 'event.hurt', body, Math.round(amount * reduction), target);
  effect(s, 'hit', body, 1);
  if (target === 'convoy' && body.hp === 0) {
    s.convoy.disabled = true;
    s.convoy.repairProgress = 0;
    emit(world, s, 'convoy', 'event.disabled', body, 0, 'convoy');
  }
}

function fire(s: CampaignData, from: Vec2, heading: number, damage: number, owner: 'player' | 'enemy',
  faction: ActorData['faction'], speed = 28, kind: 'arrow' | 'bolt' | 'siege' = 'arrow'): void {
  if (s.projectiles.length >= 96) throw new Error('Projectile bound exceeded');
  heading = Math.atan2(Math.sin(heading), Math.cos(heading));
  const reach = owner === 'player' ? 24 : 22;
  s.projectiles.push({
    id: `projectile-${++s.transientSequence}`, x: from.x, z: from.z, heading,
    owner, faction, kind, radius: kind === 'siege' ? 0.4 : 0.16,
    remaining: reach / speed, vx: Math.sin(heading) * speed, vz: Math.cos(heading) * speed, damage,
  });
}

export function shopItems(s: CampaignData, world: WorldBlueprint): ShopItem[] {
  const near = distance(s.player, world.sites.find(site => site.id === 'home')!) < 9 ||
    s.outposts.some(p => p.owner === 'player' && distance(s.player, p) < 8);
  return (Object.keys(EMPTY_UPGRADES) as UpgradeId[]).map(id => {
    const level = s.player.upgrades[id], cost = 35 + level * 30;
    const reason = level >= MAX_UPGRADE_LEVEL ? 'max' : !near ? 'location' : s.player.coins < cost ? 'coins' : 'ready';
    return { id, key: `upgrade.${id}`, level, maxLevel: MAX_UPGRADE_LEVEL, cost, available: reason === 'ready', reason };
  });
}

export function objective(s: CampaignData): ObjectiveSnapshot {
  const captured = s.outposts.filter(p => p.owner === 'player').length;
  const supplied = s.outposts.filter(p => p.supplied).length;
  const stage = s.phase === 'victory' ? 'complete' : s.phase === 'defeat' ? 'failed' :
    captured < 2 ? 'capture' : !s.raidComplete ? 'raid' : supplied < 2 ? 'supply' : 'fortress';
  const targetId = stage === 'capture' ? s.outposts.find(p => p.owner === 'enemy')?.id ?? null :
    stage === 'raid' ? 'enemy-caravan' : stage === 'supply' ?
      s.outposts.find(p => p.owner === 'player' && !p.supplied)?.id ?? null : stage === 'fortress' ? 'fortress' : null;
  return { stage, key: `objective.${stage}`, captured, captureRequired: 2, supplied, supplyRequired: 2, raidComplete: s.raidComplete, targetId };
}

export function interaction(s: CampaignData, world: WorldBlueprint): InteractionSnapshot | null {
  if (s.phase !== 'playing') return null;
  const p = s.player, convoy = s.convoy;
  const nearConvoy = distance(p, convoy) < 4;
  if (nearConvoy && p.supplies > 0 && convoy.cargo < convoy.capacity) {
    return { kind: 'transfer', key: 'interaction.transfer', targetId: 'convoy', progress: 0, enabled: true };
  }
  if (nearConvoy && convoy.hp < convoy.maxHp) {
    return { kind: 'repair', key: 'interaction.repair', targetId: 'convoy', progress: convoy.repairProgress, enabled: true };
  }
  for (const post of s.outposts) {
    if (post.owner === 'player' || distance(p, post) > post.captureRadius) continue;
    const kind = post.defendersRemaining > 0 ? 'contested' : 'capture';
    return { kind, key: `interaction.${kind}`, targetId: post.id, progress: post.captureProgress, enabled: kind === 'capture' };
  }
  const home = world.sites.find(site => site.id === 'home')!;
  if (distance(p, home) < 9) return { kind: 'rest', key: 'interaction.rest', targetId: 'home', progress: p.hp / p.maxHp, enabled: true };
  const post = s.outposts.find(post => post.owner === 'player' && distance(p, post) < 8);
  if (post) return { kind: 'shop', key: 'interaction.shop', targetId: post.id, progress: 0, enabled: true };
  if (!s.fortress.unlocked && distance(p, s.fortress) < 15) {
    return { kind: 'locked', key: 'interaction.locked', targetId: 'fortress', progress: 0, enabled: false };
  }
  return null;
}

export function resolveOutcome(world: World, s: CampaignData): void {
  if (s.phase !== 'playing') return;
  // Mutual lethal combat is a defeat; a narrative decision cannot reverse a death.
  if (s.player.hp <= 0) { s.phase = 'defeat'; s.player.state = 'dead'; }
  else if (s.fortress.bossDefeated && narrativeResolved(s)) s.phase = 'victory';
  if (s.phase !== 'playing') {
    if (s.narrative) s.narrative.dialogue = null;
    s.rewards = {
      runId: s.runId, claimed: false, victory: s.phase === 'victory',
      renown: (s.phase === 'victory' ? 60 : 5) + s.outposts.filter(p => p.owner === 'player').length * 10 + Math.floor(s.player.kills / 3),
    };
    emit(world, s, s.phase, `event.${s.phase}`, s.player, s.rewards.renown, s.runId);
  }
}

export function campaignSystems(blueprint: WorldBlueprint): System[] {
  const state = (ctx: TickContext) => ({ s: campaign(ctx.world), input: ctx.world.getResource(Intent) ?? {} });
  return [
    {
      name: 'KorovanyTimers', phase: 'preUpdate',
      run(ctx) {
        const { s } = state(ctx), p = s.player, dt = ctx.dt;
        p.attackCooldown = dec(p.attackCooldown, dt);
        p.abilityCooldown = dec(p.abilityCooldown, dt);
        p.abilityDuration = dec(p.abilityDuration, dt);
        p.dodgeCooldown = dec(p.dodgeCooldown, dt);
        p.invulnerable = dec(p.invulnerable, dt);
        p.state = 'idle';
        s.followTimer = dec(s.followTimer, dt);
        s.convoyWeaponTimer = dec(s.convoyWeaponTimer, dt);
        for (const a of actors(ctx.world)) {
          a.cooldown = dec(a.cooldown, dt);
          a.stateTime = dec(a.stateTime, dt);
          if (a.hp <= 0) a.deadTime += dt;
        }
        s.effects = s.effects.filter(e => { e.remaining = dec(e.remaining, dt); return e.remaining > 0; });
      },
    },
    {
      name: 'KorovanyHero', phase: 'update',
      run(ctx) {
        const { s, input } = state(ctx), p = s.player, faction = FACTIONS[s.faction];
        const all = actors(ctx.world);
        const move = input.move ?? { x: 0, z: 0 }, aim = input.aim ?? { x: 0, z: 0 };
        if (Math.hypot(aim.x, aim.z) > 0.01) p.heading = Math.atan2(aim.x, aim.z);
        else if (Math.hypot(move.x, move.z) > 0.01) p.heading = Math.atan2(move.x, move.z);
        if (input.dodge && p.dodgeCooldown === 0 && p.stamina >= 25) {
          p.stamina -= 25;
          p.dodgeCooldown = 0.85;
          p.invulnerable = 0.3;
          s.dodgeDirection = Math.hypot(move.x, move.z) > 0.01 ? { ...move } :
            { x: Math.sin(p.heading), z: Math.cos(p.heading) };
        }
        const dodging = p.invulnerable > 0;
        const sprinting = !dodging && input.sprint && p.stamina > 1 && Math.hypot(move.x, move.z) > 0;
        p.stamina = Math.max(0, Math.min(p.maxStamina, p.stamina + (sprinting ? -20 : 19) * ctx.dt));
        const speed = dodging ? 18 : p.speed * (sprinting ? 1.55 : 1);
        const movement = dodging ? s.dodgeDirection : move;
        moveWithCollision(blueprint, p, movement.x * speed * ctx.dt, movement.z * speed * ctx.dt, p.radius);
        p.state = dodging ? 'dodge' : Math.hypot(move.x, move.z) > 0 ? 'moving' : 'idle';
        if (input.special && p.abilityCooldown === 0) {
          p.abilityCooldown = faction.abilityCooldown;
          emit(ctx.world, s, 'ability', 'event.ability', p, 0, s.faction);
          if (s.faction === 'elf') {
            for (let i = -2; i <= 2; i++) fire(s, p, p.heading + i * 0.12, p.damage * 1.3, 'player', s.faction);
            effect(s, 'volley', p, 6, p.heading);
          } else if (s.faction === 'guard') {
            p.abilityDuration = 5;
            p.hp = Math.min(p.maxHp, p.hp + 25);
            if (distance(p, s.convoy) < 10) s.convoy.hp = Math.min(s.convoy.maxHp, s.convoy.hp + 55);
            effect(s, 'shield', p, 4, p.heading);
            for (const a of all) if (distance(p, a) < 4.5) hurtActor(ctx.world, s, a, p.damage);
          } else {
            for (const a of all) if (distance(p, a) < 6.5) hurtActor(ctx.world, s, a, p.damage * 2);
            effect(s, 'cleave', p, 6.5, p.heading);
          }
        }
        if (input.attack && p.attackCooldown === 0 && !dodging) {
          p.attackCooldown = faction.attackCooldown;
          p.state = 'attack';
          emit(ctx.world, s, 'attack', 'event.attack', p, 0, 'player');
          if (s.faction === 'elf') fire(s, p, p.heading, p.damage, 'player', s.faction);
          else {
            for (const a of all) {
              const d = distance(p, a);
              if (d <= faction.attackRange + a.radius &&
                  (d < 1 || (Math.sin(p.heading) * (a.x - p.x) + Math.cos(p.heading) * (a.z - p.z)) / d > -0.1)) {
                hurtActor(ctx.world, s, a, p.damage);
              }
            }
            effect(s, 'slash', p, faction.attackRange, p.heading);
          }
        }
        if (input.upgrade) {
          const item = shopItems(s, blueprint).find(item => item.id === input.upgrade)!;
          if (!item.available) emit(ctx.world, s, 'notice', `notice.${item.reason}`, p, item.cost, item.id);
          else {
            p.coins -= item.cost;
            p.upgrades[item.id]++;
            if (item.id === 'damage') p.damage += 8;
            if (item.id === 'vitality') { p.maxHp += 30; p.hp = Math.min(p.maxHp, p.hp + 45); }
            if (item.id === 'logistics') {
              s.convoy.maxHp += 50; s.convoy.hp += 50; s.convoy.capacity += 30;
              s.convoy.speed = (s.faction === 'elf' ? 5.6 : 4.7) + p.upgrades.logistics * 0.45;
            }
            emit(ctx.world, s, 'upgrade', 'event.upgrade', p, p.upgrades[item.id], item.id);
          }
        }
      },
    },
    {
      name: 'KorovanyEnemies', phase: 'update', after: ['KorovanyHero'],
      run(ctx) {
        const { s } = state(ctx), all = actors(ctx.world);
        const caravan = all.find(a => a.kind === 'caravan' && a.hp > 0);
        if (caravan) {
          caravan.x += caravan.patrolDirection * 1.15 * ctx.dt;
          if (caravan.x <= 7) caravan.patrolDirection = 1;
          if (caravan.x >= 42) caravan.patrolDirection = -1;
          caravan.heading = caravan.patrolDirection * Math.PI / 2;
          caravan.state = 'idle';
        }
        for (const a of all) {
          if (a.hp <= 0 || a.kind === 'caravan' || (a.siteId === 'fortress' && !s.fortress.unlocked)) continue;
          if (a.siteId === 'raid' && caravan) a.home = { x: caravan.x, z: caravan.z };
          if (a.state === 'windup') {
            if (a.stateTime > 0) continue;
            a.state = 'attack'; a.stateTime = 0.12;
            if (a.kind === 'archer') fire(s, a, a.heading, a.damage, 'enemy', a.faction, 18, 'bolt');
            else {
              const victim = a.target === 'convoy' ? s.convoy : s.player;
              if (distance(a, victim) <= a.attackRange + victim.radius &&
                  distance(a.attackPoint, victim) < (a.kind === 'boss' ? 3.5 : 2.3)) {
                hurtTarget(ctx.world, s, a.target ?? 'player', a.damage);
              }
              if (a.kind === 'boss') effect(s, 'explosion', a.attackPoint, 3.5, a.heading);
            }
            continue;
          }
          if (a.state === 'attack') {
            if (a.stateTime === 0) { a.state = 'recovery'; a.stateTime = a.kind === 'boss' ? 1.1 : 0.65; }
            continue;
          }
          if (a.state === 'recovery' && a.stateTime > 0) continue;
          const heroDistance = distance(a, s.player), cartDistance = distance(a, s.convoy);
          const heroLeash = distance(s.player, a.home) < (a.kind === 'boss' ? 22 : 19);
          const cartLeash = distance(s.convoy, a.home) < 18;
          const target = heroDistance < 17 && heroLeash ? 'player' :
            cartDistance < 12 && cartLeash && !s.convoy.disabled ? 'convoy' : null;
          a.target = target;
          if (!target) {
            a.state = 'idle';
            if (distance(a, a.home) > 0.5) {
              const d = direction(a, a.home);
              moveWithCollision(blueprint, a, d.x * a.speed * ctx.dt, d.z * a.speed * ctx.dt, a.radius);
              a.heading = Math.atan2(d.x, d.z);
            }
            continue;
          }
          const victim = target === 'player' ? s.player : s.convoy;
          const d = direction(a, victim), range = distance(a, victim);
          a.heading = Math.atan2(d.x, d.z);
          if (range <= a.attackRange + victim.radius && a.cooldown === 0) {
            a.state = 'windup'; a.stateTime = a.kind === 'boss' ? 0.85 : a.kind === 'archer' ? 0.65 : 0.5;
            a.cooldown = a.kind === 'boss' ? 2.6 : a.kind === 'archer' ? 2.2 : 1.8;
            a.attackPoint = { x: victim.x, z: victim.z };
          } else {
            a.state = 'chase';
            if (range > a.attackRange * 0.8) {
              moveWithCollision(blueprint, a, d.x * a.speed * ctx.dt, d.z * a.speed * ctx.dt, a.radius);
            }
          }
        }
      },
    },
    {
      name: 'KorovanyConvoy', phase: 'physics',
      run(ctx) {
        const { s, input } = state(ctx), cart = s.convoy;
        if (input.convoy) {
          const command = input.convoy;
          if (typeof command === 'object') {
            if (!blueprint.roads.nodes.some(n => n.id === command.destination)) {
              emit(ctx.world, s, 'notice', 'notice.destination', cart, 0, command.destination);
            } else {
              cart.mode = 'route'; cart.destination = command.destination;
              cart.route = findRoadRoute(blueprint, cart, command.destination);
            }
          } else {
            cart.mode = command === 'cycle' ? cart.mode === 'hold' ? 'follow' : cart.mode === 'follow' ? 'return' : 'hold' : command;
            cart.destination = null; cart.route = [];
          }
          s.followTimer = 0;
          emit(ctx.world, s, 'convoy', 'event.convoy', cart, 0, cart.destination ?? cart.mode);
        }
        if (cart.mode === 'return' && cart.destination !== 'home') {
          cart.destination = 'home'; cart.route = findRoadRoute(blueprint, cart, 'home');
        }
        if (cart.mode === 'follow' && s.followTimer === 0) {
          s.followTimer = 1;
          const nearest = [...blueprint.roads.nodes].sort((a, b) => distance(a, s.player) - distance(b, s.player))[0]!;
          if (cart.destination !== nearest.id) {
            cart.destination = nearest.id; cart.route = findRoadRoute(blueprint, cart, nearest.id);
          }
        }
        if (cart.hp <= 0) cart.disabled = true;
        if (cart.disabled && cart.hp >= cart.maxHp * 0.25) cart.disabled = false;
        if (!cart.disabled && cart.mode !== 'hold' && cart.route.length > 0) {
          let remaining = cart.speed * ctx.dt;
          while (remaining > 0 && cart.route.length > 0) {
            const next = cart.route[0]!, length = distance(cart, next);
            if (length <= remaining) {
              cart.x = next.x; cart.z = next.z; cart.route.shift(); remaining -= length;
            } else {
              const d = direction(cart, next);
              cart.heading = Math.atan2(d.x, d.z);
              cart.x += d.x * remaining; cart.z += d.z * remaining; remaining = 0;
            }
          }
        }
        if (!cart.disabled && s.convoyWeaponTimer === 0) {
          const enemy = actors(ctx.world).find(a => a.hp > 0 && distance(a, cart) < (s.faction === 'elf' ? 14 : 9) &&
            (a.siteId !== 'fortress' || s.fortress.unlocked));
          if (enemy && s.faction !== 'guard') {
            s.convoyWeaponTimer = s.faction === 'villain' ? 2.5 : 1.2;
            fire(s, cart, Math.atan2(enemy.x - cart.x, enemy.z - cart.z),
              s.faction === 'villain' ? 26 : 12, 'player', s.faction, 24, s.faction === 'villain' ? 'siege' : 'arrow');
          }
        }
      },
    },
    {
      name: 'KorovanyProjectiles', phase: 'physics', after: ['KorovanyConvoy'],
      run(ctx) {
        const { s } = state(ctx), all = actors(ctx.world);
        s.projectiles = s.projectiles.filter(projectile => {
          const start = { x: projectile.x, z: projectile.z };
          const dt = Math.min(ctx.dt, projectile.remaining);
          const end = { x: start.x + projectile.vx * dt, z: start.z + projectile.vz * dt };
          projectile.x = end.x; projectile.z = end.z; projectile.remaining = dec(projectile.remaining, ctx.dt);
          if (blueprint.obstacles.some(o => distance(o, projectSegment(o, start, end)) < o.radius + projectile.radius) ||
              end.x < blueprint.bounds.minX || end.x > blueprint.bounds.maxX ||
              end.z < blueprint.bounds.minZ || end.z > blueprint.bounds.maxZ) return false;
          if (projectile.owner === 'player') {
            const hits = all.filter(a => a.hp > 0 && (a.siteId !== 'fortress' || s.fortress.unlocked) &&
              distance(a, projectSegment(a, start, end)) < a.radius + projectile.radius)
              .sort((a, b) => distance(start, a) - distance(start, b));
            const hit = hits[0];
            if (hit) { hurtActor(ctx.world, s, hit, projectile.damage); return false; }
          } else {
            for (const target of ['player', 'convoy'] as const) {
              const body = target === 'player' ? s.player : s.convoy;
              if (body.hp > 0 && distance(body, projectSegment(body, start, end)) < body.radius + projectile.radius) {
                hurtTarget(ctx.world, s, target, projectile.damage); return false;
              }
            }
          }
          return projectile.remaining > 0;
        });
      },
    },
    {
      name: 'KorovanyConquest', phase: 'postUpdate',
      run(ctx) {
        const { s, input } = state(ctx), p = s.player, cart = s.convoy, all = actors(ctx.world);
        for (const post of s.outposts) {
          post.defendersRemaining = all.filter(a => a.siteId === post.id && a.hp > 0).length;
          if (post.owner === 'enemy') {
            if (post.defendersRemaining === 0 && distance(p, post) <= post.captureRadius && input.interact && p.hp > 0) {
              post.captureProgress = Math.min(1, post.captureProgress + ctx.dt / 3);
              if (post.captureProgress >= 1) {
                post.owner = 'player'; p.coins += 25;
                emit(ctx.world, s, 'capture', 'event.capture', post, 25, post.id);
                effect(s, 'capture', post, post.captureRadius);
              }
            }
          }
          if (post.owner === 'player' && !post.supplied && cart.hp > 0 &&
              cart.cargo >= post.supplyRequired && distance(cart, post) < 6) {
            post.supplied = true; cart.cargo -= post.supplyRequired; cart.delivered += post.supplyRequired;
            p.coins += 20;
            emit(ctx.world, s, 'delivery', 'event.delivery', post, post.supplyRequired, post.id);
            effect(s, 'delivery', post, 5);
          }
        }
        s.pickups = s.pickups.filter(pickup => {
          if (p.hp <= 0 || distance(p, pickup) > 2.3) return true;
          if (pickup.kind === 'coin') p.coins += pickup.amount;
          if (pickup.kind === 'health') p.hp = Math.min(p.maxHp, p.hp + pickup.amount);
          if (pickup.kind === 'supply') p.supplies += pickup.amount;
          emit(ctx.world, s, 'pickup', `event.${pickup.kind}`, pickup, pickup.amount, pickup.id);
          return false;
        });
        if (input.interact && p.hp > 0) {
          if (distance(p, cart) < 4) {
            const amount = Math.min(p.supplies, cart.capacity - cart.cargo);
            p.supplies -= amount; cart.cargo += amount;
            if (amount > 0) emit(ctx.world, s, 'pickup', 'event.supply', cart, amount, 'convoy');
            if (cart.hp < cart.maxHp) {
              if (cart.disabled) {
                cart.repairProgress = Math.min(1, cart.repairProgress + ctx.dt / 5);
                if (cart.repairProgress >= 1) {
                  cart.hp = cart.maxHp * 0.5; cart.disabled = false;
                  emit(ctx.world, s, 'repair', 'event.repair', cart, cart.hp, 'convoy');
                }
              } else {
                cart.hp = Math.min(cart.maxHp, cart.hp + (s.faction === 'guard' ? 35 : 22) * ctx.dt);
                cart.repairProgress = cart.hp / cart.maxHp;
              }
            }
          }
          const rest = distance(p, blueprint.sites.find(site => site.id === 'home')!) < 9 ||
            s.outposts.some(post => post.owner === 'player' && distance(p, post) < 7);
          if (rest && !all.some(a => a.hp > 0 && a.kind !== 'caravan' && distance(a, p) < 13)) {
            p.hp = Math.min(p.maxHp, p.hp + 25 * ctx.dt);
          }
        }
        const supplied = s.outposts.filter(post => post.supplied).length;
        if (!s.fortress.unlocked && supplied >= 2 && s.raidComplete) {
          s.fortress.unlocked = true;
          emit(ctx.world, s, 'fortress', 'event.fortress', s.fortress, supplied, 'fortress');
        }
        const boss = all.find(a => a.id === s.fortress.bossId);
        if (s.fortress.unlocked && boss && boss.hp > 0 && boss.hp < boss.maxHp * 0.6 &&
            s.fortress.reinforcementWaves === 0 && supplied < 3) {
          s.reinforcementTimer += ctx.dt;
          if (s.reinforcementTimer >= 2) {
            s.fortress.reinforcementWaves++;
            for (let i = -1; i <= 1; i++) {
              createActor(ctx.world, 'soldier', `reinforcement-${++s.spawnSequence}`, 'fortress',
                { x: s.fortress.x + i * 3, z: s.fortress.z + 5 }, 'villain');
            }
          }
        }
      },
    },
    {
      name: 'KorovanyOutcome', phase: 'cleanup',
      run(ctx) {
        const { s } = state(ctx);
        discoverNarrative(s, blueprint);
        resolveOutcome(ctx.world, s);
        for (const row of ctx.world.query({ has: [Combatant] })) {
          if (row.get(Combatant).deadTime > 8) ctx.world.despawn(row.entity);
        }
      },
    },
  ];
}
