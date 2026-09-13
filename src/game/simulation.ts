import { createSchedule, createSimulation, createWorld, type World } from '@aegis/core';
import { FACTIONS, TICK_RATE } from './config';
import { assertRecord, boundedNumber, validatedUpgrades } from './profile';
import { applyNarrative, createNarrative, discoverNarrative, narrativeSnapshot, pauseNarrative, validateNarrativeInput } from './narrative';
import { campaignSystems, createActor, interaction, objective, resolveOutcome, shopItems } from './rules';
import { actors, campaign, Campaign, Intent, type CampaignData } from './state';
import type { CampaignOptions, CampaignSave, FactionId, GameInput, GameSession, GameSnapshot, Vec2, WorldBlueprint } from './types';
import { generateWorld, normalizeSeed } from './world';
import { validateSavedWorld } from './validation';

export function validateFaction(value: unknown): asserts value is FactionId {
  if (value !== 'elf' && value !== 'guard' && value !== 'villain') throw new Error('Unknown faction');
}

function inputVector(value: unknown, label: string): Vec2 {
  assertRecord(value, label);
  const x = boundedNumber(value.x, `${label}.x`, -1e6, 1e6);
  const z = boundedNumber(value.z, `${label}.z`, -1e6, 1e6);
  const d = Math.max(1, Math.hypot(x, z));
  return { x: x / d, z: z / d };
}

export function validateInput(value: unknown): GameInput {
  assertRecord(value, 'Input');
  const result: GameInput = {};
  const names = ['move', 'aim', 'attack', 'sprint', 'interact', 'dodge', 'special', 'convoy', 'upgrade', 'narrative'];
  if (Object.keys(value).some(k => !names.includes(k))) throw new Error('Unknown input command');
  if (value.narrative !== undefined) {
    if (Object.keys(value).some(k => k !== 'narrative' && value[k] !== undefined)) throw new Error('Narrative commands cannot include combat input');
    return { narrative: validateNarrativeInput(value.narrative) };
  }
  if (value.move !== undefined) result.move = inputVector(value.move, 'move');
  if (value.aim !== undefined) result.aim = inputVector(value.aim, 'aim');
  for (const key of ['attack', 'sprint', 'interact', 'dodge', 'special'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new Error(`${key} must be boolean`);
      result[key] = value[key];
    }
  }
  if (value.convoy !== undefined) {
    if (value.convoy === 'cycle' || value.convoy === 'hold' || value.convoy === 'follow' || value.convoy === 'return') {
      result.convoy = value.convoy;
    } else {
      assertRecord(value.convoy, 'Convoy command');
      if (Object.keys(value.convoy).length !== 1 || typeof value.convoy.destination !== 'string' ||
          !value.convoy.destination || value.convoy.destination.length > 80) throw new Error('Invalid convoy destination');
      result.convoy = { destination: value.convoy.destination };
    }
  }
  if (value.upgrade !== undefined) {
    if (value.upgrade !== 'damage' && value.upgrade !== 'vitality' && value.upgrade !== 'logistics') throw new Error('Invalid upgrade');
    result.upgrade = value.upgrade;
  }
  return result;
}

function initialState(options: CampaignOptions, blueprint: WorldBlueprint): CampaignData {
  validateFaction(options.faction);
  const upgrades = validatedUpgrades(options.upgrades ?? {}, true);
  const faction = FACTIONS[options.faction];
  const runId = options.runId ?? `korovany2:${blueprint.seed}:${options.faction}`;
  if (typeof runId !== 'string' || !runId || runId.length > 128) throw new Error('Run ID must contain 1-128 characters');
  const home = blueprint.sites.find(site => site.kind === 'home')!;
  const fortress = blueprint.sites.find(site => site.kind === 'fortress')!;
  const maxHp = faction.maxHp + upgrades.vitality * 30;
  const cartHp = (options.faction === 'guard' ? 280 : options.faction === 'villain' ? 250 : 210) + upgrades.logistics * 50;
  return {
    seed: blueprint.seed, faction: options.faction, runId, worldId: blueprint.id, phase: 'playing',
    player: {
      id: 'player', x: home.x + 2, z: home.z + 1, heading: 0, hp: maxHp, maxHp,
      stamina: 100, maxStamina: 100, coins: 0, supplies: 0, level: 1, kills: 0,
      damage: faction.damage + upgrades.damage * 8, speed: faction.speed, radius: 0.65,
      attackCooldown: 0, abilityCooldown: 0, abilityDuration: 0, dodgeCooldown: 0, invulnerable: 0,
      state: 'idle', upgrades,
    },
    convoy: {
      id: 'convoy', x: home.x, z: home.z, heading: 0, faction: options.faction,
      hp: cartHp, maxHp: cartHp, cargo: 30, capacity: 120 + upgrades.logistics * 30,
      mode: 'hold', destination: null, route: [],
      speed: (options.faction === 'elf' ? 5.6 : 4.7) + upgrades.logistics * 0.45,
      radius: 1.5, disabled: false, repairProgress: 1, delivered: 0,
    },
    outposts: blueprint.sites.filter(site => site.kind === 'outpost').map(site => ({
      id: site.id, nameKey: site.nameKey, faction: site.faction, x: site.x, z: site.z,
      owner: 'enemy', captureProgress: 0, captureRadius: 6, defendersRemaining: 3, supplied: false, supplyRequired: 30,
    })),
    pickups: [], projectiles: [], effects: [], events: [],
    fortress: { id: 'fortress', x: fortress.x, z: fortress.z, unlocked: false, bossId: 'boss', bossDefeated: false, reinforcementWaves: 0 },
    rewards: null, raidComplete: false, eventSequence: 0, transientSequence: 0, spawnSequence: 0,
    followTimer: 0, convoyWeaponTimer: 0, reinforcementTimer: 0, dodgeDirection: { x: 0, z: 1 },
    ...(blueprint.version === 2 ? { narrative: createNarrative(blueprint) } : {}),
  };
}

function session(world: World, blueprint: WorldBlueprint): GameSession {
  const simulation = createSimulation({
    world, schedule: createSchedule().addAll(campaignSystems(blueprint)), tickRate: TICK_RATE,
  });
  return {
    step(input: GameInput = {}) {
      if (campaign(world).phase !== 'playing') return;
      const valid = validateInput(input);
      const s = campaign(world);
      if (valid.narrative) {
        if (!s.narrative) throw new Error('Narrative commands are not supported by legacy campaigns');
        world.setResource(Intent, {});
        applyNarrative(s, blueprint, actors(world), valid.narrative);
        resolveOutcome(world, s);
        return;
      }
      if (s.narrative?.dialogue || s.narrative?.inspection) {
        world.setResource(Intent, {});
        pauseNarrative(s);
        return;
      }
      world.setResource(Intent, valid);
      simulation.step();
    },
    snapshot(): GameSnapshot {
      const s = campaign(world);
      const visibleActors = actors(world).map(a => {
        const { cooldown: _cooldown, damage: _damage, speed: _speed, deadTime: _deadTime,
          attackPoint: _attackPoint, patrolDirection: _patrolDirection, ...visible } = a;
        return visible;
      });
      const projectiles = s.projectiles.map(p => {
        const { vx: _vx, vz: _vz, damage: _damage, ...visible } = p;
        return visible;
      });
      return structuredClone({
        version: 1, phase: s.phase, tick: world.tick, elapsed: world.tick / TICK_RATE,
        seed: s.seed, runId: s.runId, faction: s.faction, world: blueprint,
        player: s.player, actors: visibleActors, convoy: s.convoy, outposts: s.outposts,
        pickups: s.pickups, projectiles, effects: s.effects, events: s.events,
        objective: objective(s), fortress: s.fortress, interaction: interaction(s, blueprint),
        shop: shopItems(s, blueprint), rewards: s.rewards,
        ...(s.narrative ? { narrative: narrativeSnapshot(s, blueprint, actors(world)) } : {}),
      });
    },
    serialize(): CampaignSave {
      const s = campaign(world);
      return {
        namespace: 'korovany2:campaign', version: blueprint.version, seed: s.seed, faction: s.faction,
        runId: s.runId, worldId: blueprint.id, engine: world.snapshot(),
      };
    },
  };
}

function populateActors(world: World, data: CampaignData, blueprint: WorldBlueprint): void {
  for (const post of data.outposts) {
    createActor(world, 'soldier', `${post.id}-soldier`, post.id, { x: post.x - 3, z: post.z - 2 }, post.faction);
    createActor(world, 'archer', `${post.id}-archer`, post.id, { x: post.x + 3, z: post.z + 2 }, post.faction);
    createActor(world, 'captain', `${post.id}-captain`, post.id, { x: post.x, z: post.z }, post.faction);
  }
  const raid = blueprint.sites.find(site => site.kind === 'raid')!;
  createActor(world, 'caravan', 'enemy-caravan', 'raid', raid, 'guard');
  createActor(world, 'soldier', 'raid-guard-1', 'raid', { x: raid.x - 3, z: raid.z - 2 }, 'guard');
  createActor(world, 'archer', 'raid-guard-2', 'raid', { x: raid.x - 3, z: raid.z + 2 }, 'guard');
  createActor(world, 'boss', 'boss', 'fortress', data.fortress, 'villain');
  for (let i = -1; i <= 1; i += 2) {
    createActor(world, 'captain', `fortress-guard-${i}`, 'fortress',
      { x: data.fortress.x + i * 4, z: data.fortress.z - 4 }, 'villain');
  }
}

export function createCampaign(options: CampaignOptions): GameSession {
  assertRecord(options, 'Campaign options');
  if (options.worldVersion !== undefined && options.worldVersion !== 1 && options.worldVersion !== 2) throw new Error('Unsupported world version');
  const blueprint = generateWorld(options.seed, options.worldVersion ?? 2);
  const data = initialState(options, blueprint);
  discoverNarrative(data, blueprint);
  const world = createWorld({ seed: `korovany2:simulation:${blueprint.seed}` });
  world.setResource(Campaign, data);
  world.setResource(Intent, {});
  populateActors(world, data, blueprint);
  return session(world, blueprint);
}

export function restoreCampaign(save: unknown): GameSession {
  assertRecord(save, 'Campaign save');
  if (save.namespace !== 'korovany2:campaign' || (save.version !== 1 && save.version !== 2)) throw new Error('Unsupported campaign save');
  if (typeof save.seed !== 'string' || normalizeSeed(save.seed) !== save.seed) throw new Error('Invalid saved seed');
  validateFaction(save.faction);
  if (typeof save.runId !== 'string' || !save.runId || save.runId.length > 128) throw new Error('Invalid saved run ID');
  const blueprint = generateWorld(save.seed, save.version);
  if (save.worldId !== blueprint.id) throw new Error('Saved world does not match the seed/version');
  const template = initialState({ seed: save.seed, faction: save.faction, runId: save.runId }, blueprint);
  const world = createWorld({ seed: `korovany2:simulation:${save.seed}` });
  populateActors(world, template, blueprint);
  const engine = validateSavedWorld(save.engine, template, blueprint, actors(world), validateInput);
  world.restore(engine);
  return session(world, blueprint);
}
