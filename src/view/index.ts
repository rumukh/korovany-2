import * as THREE from 'three';
import type { ActorSnapshot, GameSnapshot, OutpostSnapshot, WorldBlueprint } from '../game/types';
import { allegiancePennant, createActor, createModelHero, createModelTroop, createModelWagon, proceduralWagon, type ActorModel, type ViewAllegiance, type WagonVisual } from './actors';
import { FollowCamera, type GroundPoint, type MovementBasis } from './camera';
import { WorldEffects } from './effects';
import { factionColors, palette } from './palette';
import { part, shapeGeometry } from './primitives';
import { ViewResources } from './resources';
import { WorldResidents } from './residents';
import { createWorldScenery, type WorldScenery } from './world';
import { lightWorld, positionSun, skyEnvironment } from './atmosphere';
import { WorldPostprocessing } from './postprocessing';
import { DRAFT_OX, gltfModelSource, HEROES, ModelLibrary, propInstance, troopModelFor, WAGONS, type CharacterInstance, type HeroInstance, type ModelStatus, type TroopModelId, type WagonModelId } from './models';

export type { GroundPoint, MovementBasis } from './camera';
export type { ModelStatus } from './models';
export type ViewQuality = 'low' | 'high';

/** Result of compiling the cooked-model programs before gameplay. */
export interface ModelWarmup {
  programsBefore: number;
  programsAfter: number;
  milliseconds: number;
}

export interface GameViewOptions {
  quality?: ViewQuality;
  reducedMotion?: boolean;
  /** Page-lifetime model library; created and owned by the view when omitted. */
  models?: ModelLibrary;
  /**
   * Page-lifetime renderer from `createRenderer`, shared by successive views so cooked-model uploads and shader
   * programs survive a world change. Created and owned by the view when omitted; a borrowed renderer is never
   * disposed by the view.
   */
  renderer?: THREE.WebGLRenderer;
}

/** The game's WebGL 2 renderer for `canvas`. Share one across successive views and dispose it after the last. */
export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  try {
    const context = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'high-performance' });
    if (!context) throw new Error('WebGL 2 is not available in this browser.');
    return new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false });
  } catch (cause) {
    throw new Error('Korovany II could not start its 3D renderer. Enable hardware acceleration and WebGL 2, then reload.', { cause });
  }
}

export interface GameView {
  /** Present one detached authoritative snapshot. dt is cosmetic frame time in seconds. */
  render(snapshot: Readonly<GameSnapshot>, dt: number): void;
  getMoveBasis(): MovementBasis;
  screenToWorld(clientX: number, clientY: number): GroundPoint | null;
  /** Resizes the drawing buffer to the canvas CSS box. Does not alter CSS sizing. */
  resize(): void;
  /** Orbit deltas are radians; the shell owns pointer and keyboard event handling. */
  orbit(deltaYaw: number, deltaPitch?: number): void;
  /** Accepts a wheel-like delta: positive zooms out, negative zooms in. */
  zoom(delta: number): void;
  setQuality(quality: ViewQuality): void;
  setReducedMotion(reducedMotion: boolean): void;
  /** Model loading state. Nothing is presented until every model is ready; failures are thrown by `render`. */
  readonly models: ModelStatus;
  /** The latest cooked-model shader warm-up (after a presentation is built or quality changes), if any. */
  readonly warmup: ModelWarmup | undefined;
  dispose(): void;
}

interface HealthBar {
  root: THREE.Group;
  fill: THREE.Mesh;
}

interface ActorVisual {
  appearance: string;
  root: THREE.Group;
  actor?: ActorModel;
  character?: CharacterInstance;
  wagon?: WagonVisual;
  bar: HealthBar;
  tell: THREE.Group;
  tellRing: THREE.Mesh;
  tellLine: THREE.Mesh;
  lastX: number;
  lastZ: number;
  lastHp: number;
  speed: number;
  state: string;
  stateDuration: number;
}

interface PostVisual {
  flag: THREE.Mesh;
  ring: THREE.Mesh;
  progress: THREE.Mesh;
  progressGeometry: THREE.BufferGeometry;
  supply: THREE.Group;
}

function healthBar(resources: ViewResources, parent: THREE.Object3D, height: number, affiliation: boolean | ViewAllegiance): HealthBar {
  const root = new THREE.Group();
  root.name = 'health-bar';
  const allegiance = typeof affiliation === 'boolean' ? affiliation ? 'friendly' : 'hostile' : affiliation;
  const color = allegiance === 'friendly' ? palette.teal : allegiance === 'neutral' ? palette.stone : palette.ember;
  root.position.y = height;
  parent.add(root);
  const back = part(resources, root, 'box', palette.ink, [0, 0, 0], [1.08, 0.12, 0.025]);
  back.castShadow = false;
  back.material = resources.material(palette.ink, { unlit: true });
  const fill = part(resources, root, 'box', color, [0, 0, 0.019], [1, 0.065, 0.012]);
  fill.name = 'health-fill';
  fill.castShadow = false;
  fill.material = resources.material(color, { unlit: true });
  return { root, fill };
}

function updateHealth(bar: HealthBar, hp: number, maxHp: number, camera: THREE.Camera, parent: THREE.Object3D): void {
  const fraction = THREE.MathUtils.clamp(hp / Math.max(maxHp, 1), 0, 1);
  bar.fill.scale.x = fraction;
  bar.fill.position.x = (fraction - 1) / 2;
  bar.root.quaternion.copy(parent.quaternion).invert().multiply(camera.quaternion);
}

function createTell(resources: ViewResources, parent: THREE.Object3D): { group: THREE.Group; ring: THREE.Mesh; line: THREE.Mesh } {
  const group = new THREE.Group();
  parent.add(group);
  const material = resources.material(palette.ember, { unlit: true, opacity: 0.65, depthWrite: false });
  const ring = new THREE.Mesh(shapeGeometry(resources, 'ring'), material);
  ring.position.y = 0.095;
  const line = new THREE.Mesh(shapeGeometry(resources, 'box'), material);
  group.add(ring, line);
  group.visible = false;
  return { group, ring, line };
}

export class Presentation {
  readonly scene = new THREE.Scene();
  readonly scenery: WorldScenery;
  readonly sun: THREE.DirectionalLight;
  readonly effects: WorldEffects;
  readonly residents: WorldResidents;
  private readonly actorVisuals = new Map<string, ActorVisual>();
  private readonly postVisuals = new Map<string, PostVisual>();
  /** The cooked hero; the procedural one only without a model library (DOM-free and cutaway tests). */
  private hero: { root: THREE.Group; actor?: ActorModel; character?: HeroInstance } | undefined;
  private convoy: WagonVisual | undefined;
  private convoyBar: HealthBar | undefined;
  private lastConvoyHp = 0;
  private fortressFlag: THREE.Mesh | undefined;
  private fortressRing: THREE.Mesh | undefined;
  private lastTick = -1;
  private lastPlayerX = 0;
  private lastPlayerZ = 0;
  private playerSpeed = 0;
  private playerVelocityX = 0;
  private playerVelocityZ = 0;
  private lastPlayerHp = 0;
  private lastHeroEvent = 0;
  private lastInteraction: { targetId: string; progress: number } | null = null;
  private workingUntil = -1;
  private lastConvoyX = 0;
  private lastConvoyZ = 0;
  private convoyDistance = 0;
  private convoySpeed = 0;
  private cosmeticTime = 0;
  private sinceTick = 0;

  constructor(readonly world: WorldBlueprint, readonly resources = new ViewResources(), environment?: THREE.Texture) {
    this.scenery = createWorldScenery(this.resources, world);
    this.scene.add(this.scenery.group);
    this.scene.environment = environment ?? null;
    this.scene.environmentIntensity = 0.55;
    this.effects = new WorldEffects(this.resources, this.scene);
    this.residents = new WorldResidents(this.resources, this.scene);
    this.sun = lightWorld(this.scene);
    const fortress = world.sites.find((site) => site.kind === 'fortress');
    if (fortress) {
      const color = world.version === 1 ? palette.villain : factionColors[fortress.faction];
      const anchor = this.scenery.flagAnchors.get(fortress.id);
      if (anchor) {
        this.fortressFlag = new THREE.Mesh(shapeGeometry(this.resources, 'cloth'),
          this.resources.material(color, { side: THREE.DoubleSide, surface: 'cloth' }));
        this.fortressFlag.name = 'fortress-flag';
        this.fortressFlag.position.copy(anchor);
        this.fortressFlag.scale.set(1.7, 1.2, 1);
        this.scene.add(this.fortressFlag);
      }
      this.fortressRing = new THREE.Mesh(shapeGeometry(this.resources, 'zone-ring'),
        this.resources.material(world.version === 1 ? palette.villain : fortress.allegiance === 'friendly' ? palette.teal : palette.hostile,
          { unlit: true, opacity: 0.45, depthWrite: false }));
      this.fortressRing.name = 'fortress-ring';
      this.fortressRing.position.set(fortress.x, 0.04, fortress.z);
      this.fortressRing.scale.set(fortress.radius * 2, 1, fortress.radius * 2);
      this.scene.add(this.fortressRing);
    }
  }

  setQuality(low: boolean): void {
    this.scenery.setQuality(low);
    this.effects.setQuality(low);
    this.sun.castShadow = !low;
  }

  /**
   * Compiles every cooked-model shader program before gameplay (aegis-engine #6): the skinned, dyed soldier body,
   * its items, the Echo Well and their shadow-depth variants, with this scene's real lights, fog, environment and
   * quality. Temporary instances are placed at (x, z) and drawn alone: every other renderable is hidden for the
   * warm-up, so the main and shadow passes cost almost nothing while the lights, fog, environment and output path
   * that decide program keys stay those of a real frame. `draw` renders with the real frame's state (it may shade
   * almost no pixels), then the instances are removed and the scene restored. Call it in the same task as the real
   * frame so no warm-up pixel reaches the screen. Returns the renderer's program count before and after, and the
   * time spent.
   */
  warmModels(renderer: THREE.WebGLRenderer, x: number, z: number, draw: () => void): ModelWarmup {
    const started = performance.now();
    const programsBefore = renderer.info.programs?.length ?? 0;
    const soldierModel = this.resources.model('char-line-soldier');
    const wellModel = this.resources.model('prop-echo-well');
    if (!soldierModel || !wellModel) return { programsBefore, programsAfter: programsBefore, milliseconds: 0 };
    const group = new THREE.Group();
    group.name = 'model-warmup';
    // A complete soldier visual (model, allegiance ring, health bar and attack tell), exactly as gameplay shows one.
    const actor = {
      id: 'model-warmup', kind: 'soldier', faction: 'guard', allegiance: 'friendly', x: x + 1.5, z: z + 1.5, heading: 0,
      hp: 1, maxHp: 2, state: 'windup', stateTime: 0.25, radius: 0.7, attackRange: 2.3,
    } as unknown as ActorSnapshot;
    const visual = this.makeActor(actor, false);
    visual.root.position.set(actor.x, 0.08, actor.z);
    visual.bar.root.visible = true;
    visual.tell.visible = true;
    visual.tell.position.set(actor.x, 0, actor.z);
    const well = propInstance(wellModel, this.resources.modelDepthMaterial(), 2.8);
    well.position.set(x - 2.5, 0.08, z + 2.5);
    group.add(well);
    // Every other troop model this campaign shows shares the soldier's programs; drawing one of each here uploads its
    // textures too, so no troop's first appearance stalls on a texture upload.
    const troops = new Set<TroopModelId>();
    for (const existing of this.actorVisuals.values()) if (existing.character) troops.add(existing.character.contract.id);
    troops.delete('char-line-soldier');
    const extras = [...troops].map((id, index) => {
      const troop = createModelTroop(this.resources, this.resources.model(id)!, 'soldier', 'guard', 'friendly');
      troop.root.position.set(x - 1.5 - index * 1.4, 0.08, z + 1.5);
      troop.character.update({ state: 'idle', progress: 0, speed: 0, hit: false, relaxed: false, reducedMotion: true }, 0);
      group.add(troop.root);
      return troop;
    });
    // Both wagons with their oxen and the convoy's cargo reuse the prop, item and skinned programs; drawing one of each
    // uploads their textures before either first appears.
    const wagons = (['prop-wagon-convoy', 'prop-wagon-shipment'] as const).map((id, index) => {
      const wagon = this.makeWagon(id, true, palette.teal);
      wagon.root.position.set(x + 4 + index * 3.5, 0.08, z - 3);
      wagon.update({ distance: 0, speed: 0, tilt: 0, cargo: true, hit: false, reducedMotion: true, time: 0 }, 0);
      group.add(wagon.root);
      return wagon;
    });
    this.scene.add(group);
    const warming = new Set<THREE.Object3D>();
    // The hero, when already built, shares the soldier's programs; drawing it here also uploads its own textures.
    for (const root of [group, visual.root, visual.bar.root, visual.tell, this.hero?.root]) root?.traverse(object => warming.add(object));
    const hidden: THREE.Object3D[] = [];
    this.scene.traverseVisible(object => {
      const drawn = object as THREE.Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
      if ((drawn.isMesh || drawn.isLine || drawn.isPoints || drawn.isSprite) && !warming.has(object)) hidden.push(object);
    });
    for (const object of hidden) object.visible = false;
    try {
      // Two draws: the shared shadow-depth material picks its program in draw order, and one draw was measured to
      // miss two depth variants that the first soldier would then compile (models-browser program-growth test).
      draw();
      draw();
    } finally {
      for (const object of hidden) object.visible = true;
      group.removeFromParent();
      for (const extra of extras) extra.character.dispose();
      for (const wagon of wagons) wagon.dispose();
      this.removeActor(actor.id, visual);
    }
    return { programsBefore, programsAfter: renderer.info.programs?.length ?? 0, milliseconds: performance.now() - started };
  }

  private makeActor(snapshot: ActorSnapshot, dead: boolean): ActorVisual {
    const affiliation = snapshot.allegiance ?? false;
    let actor: ActorModel | undefined;
    let character: CharacterInstance | undefined;
    let root: THREE.Group | undefined;
    let height = 2.95;
    if (snapshot.kind !== 'caravan') {
      const look = ({ soldier: 'soldier', archer: 'archer', captain: 'brute', boss: 'boss' } as const)[snapshot.kind];
      const model = this.resources.model(troopModelFor(snapshot.kind, snapshot.faction));
      if (model) {
        const troop = createModelTroop(this.resources, model, look, snapshot.faction, affiliation, dead);
        character = troop.character;
        root = troop.root;
        height = troop.height;
      } else if (snapshot.kind === 'soldier') {
        // DOM-free geometry tests construct resources without models; browser views always have them.
        root = new THREE.Group();
        root.userData.allegiance = typeof affiliation === 'boolean' ? affiliation ? 'friendly' : 'hostile' : affiliation;
        height = 2.47;
      } else {
        actor = createActor(this.resources, look as Exclude<typeof look, 'soldier'>, snapshot.faction, affiliation);
        root = actor.root;
        height = actor.height;
      }
    }
    const wagon = snapshot.kind === 'caravan' ? this.makeWagon('prop-wagon-shipment', affiliation, allegiancePennant(affiliation)) : undefined;
    root ??= wagon?.root;
    if (!root) throw new Error(`Unsupported actor kind: ${snapshot.kind}`);
    root.name = `actor:${snapshot.id}`;
    this.scene.add(root);
    const bar = healthBar(this.resources, root, height, affiliation);
    const tell = createTell(this.resources, this.scene);
    tell.group.name = `tell:${snapshot.id}`;
    return {
      appearance: `${snapshot.kind}:${snapshot.faction}:${snapshot.allegiance ?? 'legacy'}`,
      root, actor, character, wagon, bar, tell: tell.group, tellRing: tell.ring, tellLine: tell.line,
      lastX: snapshot.x, lastZ: snapshot.z, lastHp: snapshot.hp, speed: 0, state: snapshot.state, stateDuration: snapshot.stateTime,
    };
  }

  /** A cooked wagon and ox; the procedural wagon only without a model library (DOM-free geometry tests). */
  private makeWagon(id: WagonModelId, affiliation: boolean | ViewAllegiance, pennant: string): WagonVisual {
    const wagon = this.resources.model(id);
    const ox = this.resources.model(DRAFT_OX.id);
    if (wagon && ox) {
      return createModelWagon(this.resources, wagon, ox, WAGONS[id].cargo ? this.resources.model('prop-cargo-load') : undefined, pennant, affiliation);
    }
    return proceduralWagon(this.resources, affiliation, WAGONS[id].cargo);
  }

  private removeActor(id: string, visual: ActorVisual): void {
    visual.character?.dispose();
    visual.wagon?.dispose();
    visual.root.removeFromParent();
    visual.tell.removeFromParent();
    this.actorVisuals.delete(id);
  }

  private makePost(post: OutpostSnapshot): PostVisual {
    const flag = new THREE.Mesh(shapeGeometry(this.resources, 'cloth'),
      this.resources.material(factionColors[post.faction], { side: THREE.DoubleSide, surface: 'cloth' }));
    const anchor = this.scenery.flagAnchors.get(post.id);
    if (!anchor) throw new Error(`Outpost ${post.id} is missing from its world blueprint.`);
    flag.position.copy(anchor);
    flag.scale.set(1.4, 0.93, 1);
    flag.castShadow = true;
    flag.customDepthMaterial = this.resources.depthMaterial();
    this.scene.add(flag);
    const ring = new THREE.Mesh(shapeGeometry(this.resources, 'zone-ring'),
      this.resources.material(palette.hostile, { unlit: true, opacity: 0.34, depthWrite: false }));
    ring.position.set(post.x, 0.04, post.z);
    ring.scale.set(post.captureRadius * 2, 1, post.captureRadius * 2);
    this.scene.add(ring);
    const progressGeometry = this.resources.geometry(`capture-${post.id}`, () =>
      new THREE.RingGeometry(0.93, 1, 80).rotateX(-Math.PI / 2));
    const progress = new THREE.Mesh(progressGeometry, this.resources.material(palette.brass, { unlit: true }));
    progress.position.set(post.x, 0.055, post.z);
    progress.scale.set(post.captureRadius, 1, post.captureRadius);
    this.scene.add(progress);
    const supply = new THREE.Group();
    supply.position.copy(anchor).add(new THREE.Vector3(0, 1.02, 0));
    const supplied = part(this.resources, supply, 'sphere', palette.brass, [0, 0, 0], [0.38, 0.38, 0.13]);
    supplied.material = this.resources.material(palette.brass, { unlit: true });
    this.scene.add(supply);
    return { flag, ring, progress, progressGeometry, supply };
  }

  update(snapshot: Readonly<GameSnapshot>, dt: number, camera: THREE.Camera, reducedMotion: boolean): void {
    this.resources.assertTextures();
    this.cosmeticTime += dt;
    if (!this.hero) {
      const model = this.resources.model(HEROES[snapshot.faction].id);
      if (model) {
        this.hero = createModelHero(this.resources, model, snapshot.faction, snapshot.player.state === 'dead');
      } else {
        // DOM-free geometry tests construct resources without models; browser views always have them.
        const actor = createActor(this.resources, 'hero', snapshot.faction, true);
        this.hero = { root: actor.root, actor };
      }
      this.scene.add(this.hero.root);
      this.lastPlayerHp = snapshot.player.hp;
      // A rebuilt mirror never replays attacks that happened before it existed.
      this.lastHeroEvent = snapshot.events.reduce((latest, event) => Math.max(latest, event.id), 0);
      this.convoy = this.makeWagon('prop-wagon-convoy', true, factionColors[snapshot.faction]);
      this.scene.add(this.convoy.root);
      this.convoyBar = healthBar(this.resources, this.convoy.root, 2.92, true);
      this.lastConvoyHp = snapshot.convoy.hp;
      this.lastPlayerX = snapshot.player.x;
      this.lastPlayerZ = snapshot.player.z;
      this.lastConvoyX = snapshot.convoy.x;
      this.lastConvoyZ = snapshot.convoy.z;
      const home = snapshot.world.sites.find((site) => site.kind === 'home');
      if (home) {
        const anchor = this.scenery.flagAnchors.get(home.id);
        if (anchor) {
          const flag = new THREE.Mesh(shapeGeometry(this.resources, 'cloth'),
            this.resources.material(factionColors[snapshot.faction], { side: THREE.DoubleSide, surface: 'cloth' }));
          flag.position.copy(anchor);
          flag.scale.set(1.4, 0.93, 1);
          this.scene.add(flag);
        }
      }
    }
    const tickChanged = snapshot.tick !== this.lastTick;
    const tickDt = this.lastTick < 0 ? 1 / 60 : Math.max(1 / 60, (snapshot.tick - this.lastTick) / 60);
    if (tickChanged) {
      this.playerVelocityX = (snapshot.player.x - this.lastPlayerX) / tickDt;
      this.playerVelocityZ = (snapshot.player.z - this.lastPlayerZ) / tickDt;
      this.playerSpeed = Math.hypot(this.playerVelocityX, this.playerVelocityZ);
      this.convoyDistance = Math.hypot(snapshot.convoy.x - this.lastConvoyX, snapshot.convoy.z - this.lastConvoyZ);
      this.convoySpeed = this.convoyDistance / tickDt;
      this.lastPlayerX = snapshot.player.x;
      this.lastPlayerZ = snapshot.player.z;
      this.lastConvoyX = snapshot.convoy.x;
      this.lastConvoyZ = snapshot.convoy.z;
    }
    if (tickChanged) this.sinceTick = 0;
    else this.sinceTick += dt;
    const storyOpen = Boolean(snapshot.narrative?.dialogue || snapshot.narrative?.inspection);
    // A stalled tick means the shell paused the simulation: never run in place.
    const paused = storyOpen || snapshot.phase !== 'playing' || this.sinceTick > 0.1;
    const heroRoot = this.hero.root;
    heroRoot.position.set(snapshot.player.x, 0.08, snapshot.player.z);
    heroRoot.rotation.y = snapshot.player.heading;
    if (this.hero.character) {
      let attack = false;
      let ability = false;
      for (const event of snapshot.events) {
        if (event.id <= this.lastHeroEvent) continue;
        this.lastHeroEvent = event.id;
        if (event.kind === 'attack' && event.targetId === 'player') attack = true;
        if (event.kind === 'ability') ability = true;
      }
      const hit = tickChanged && snapshot.player.hp < this.lastPlayerHp;
      const interaction = snapshot.interaction;
      if (tickChanged) {
        this.lastPlayerHp = snapshot.player.hp;
        // Capture, repair and rest progress rises only while the interaction is held; a pickup or heal jumps instead.
        const last = this.lastInteraction;
        const rise = interaction && last?.targetId === interaction.targetId ? interaction.progress - last.progress : 0;
        if (interaction?.enabled && rise > 1e-6 && rise < 0.02) this.workingUntil = this.cosmeticTime + 0.25;
        this.lastInteraction = interaction ? { targetId: interaction.targetId, progress: interaction.progress } : null;
      }
      // Teleports (fast travel, a rebuilt run) are not movement.
      const moving = !paused && this.playerSpeed < 30;
      const cos = Math.cos(snapshot.player.heading), sin = Math.sin(snapshot.player.heading);
      const vx = moving ? this.playerVelocityX : 0, vz = moving ? this.playerVelocityZ : 0;
      this.hero.character.update({
        velocity: { x: vx * cos - vz * sin, z: vx * sin + vz * cos },
        dodging: snapshot.player.state === 'dodge',
        dead: snapshot.player.state === 'dead' || snapshot.player.hp <= 0,
        attack,
        ability,
        hit,
        working: !paused && this.cosmeticTime < this.workingUntil,
        relaxed: storyOpen,
        reducedMotion,
      }, dt);
    } else {
      this.hero.actor!.animate({
        moving: this.playerSpeed / Math.max(1, snapshot.player.speed),
        time: snapshot.elapsed,
        attacking: snapshot.player.state === 'attack' ? THREE.MathUtils.clamp(1 - snapshot.player.attackCooldown / 0.6, 0, 1) : 0,
        winding: 0,
        dodging: snapshot.player.state === 'dodge',
        dead: snapshot.player.state === 'dead',
        reducedMotion,
      });
    }
    this.scenery.heroPosition.set(snapshot.player.x, 1.15, snapshot.player.z);
    this.scenery.update(this.cosmeticTime, reducedMotion);
    const fortress = snapshot.world.sites.find((site) => site.kind === 'fortress');
    const legacyFortressColor = snapshot.fortress.bossDefeated ? palette.teal : snapshot.fortress.unlocked ? palette.brass : palette.villain;
    const fortressColor = snapshot.campaign && fortress
      ? factionColors[snapshot.fortress.bossDefeated ? snapshot.faction : fortress.faction] : legacyFortressColor;
    const fortressRingColor = snapshot.campaign && fortress
      ? snapshot.fortress.bossDefeated || fortress.allegiance === 'friendly' ? palette.teal
        : snapshot.fortress.unlocked ? palette.brass : palette.hostile
      : legacyFortressColor;
    if (this.fortressFlag) {
      this.fortressFlag.material = this.resources.material(fortressColor, { side: THREE.DoubleSide, surface: 'cloth' });
      this.fortressFlag.rotation.y = reducedMotion ? 0 : Math.sin(this.cosmeticTime * 1.35) * 0.12;
    }
    if (this.fortressRing) {
      this.fortressRing.material = this.resources.material(fortressRingColor, { unlit: true, opacity: 0.45, depthWrite: false });
    }
    // A player-centred shadow frustum preserves detail without a map-sized shadow texture.
    positionSun(this.sun, snapshot.player.x, snapshot.player.z);

    if (this.convoy && this.convoyBar) {
      this.convoy.root.position.set(snapshot.convoy.x, 0.08, snapshot.convoy.z);
      this.convoy.root.rotation.y = snapshot.convoy.heading;
      // Travel moves the convoy with the hero: a jump is not driving.
      const driving = this.convoySpeed < 30;
      const hit = tickChanged && snapshot.convoy.hp < this.lastConvoyHp;
      if (tickChanged) this.lastConvoyHp = snapshot.convoy.hp;
      this.convoy.update({
        distance: tickChanged && driving ? this.convoyDistance : 0,
        speed: !paused && driving ? this.convoySpeed : 0,
        tilt: snapshot.convoy.disabled ? 0.085 : 0,
        cargo: snapshot.convoy.cargo > 0,
        hit,
        reducedMotion,
        time: snapshot.elapsed,
      }, dt);
      this.convoyBar.root.visible = snapshot.convoy.hp < snapshot.convoy.maxHp || snapshot.convoy.disabled;
      updateHealth(this.convoyBar, snapshot.convoy.hp, snapshot.convoy.maxHp, camera, this.convoy.root);
    }
    const activeIds = new Set<string>();
    let corpses = 0;
    for (const actor of snapshot.actors) {
      activeIds.add(actor.id);
      let visual = this.actorVisuals.get(actor.id);
      const appearance = `${actor.kind}:${actor.faction}:${actor.allegiance ?? 'legacy'}`;
      const disabledShipment = snapshot.campaign?.shipment.targetId === actor.id && actor.state !== 'dead' && actor.hp <= 0;
      const dead = actor.state === 'dead' || (actor.hp <= 0 && !disabledShipment);
      if (visual && visual.appearance !== appearance) {
        this.removeActor(actor.id, visual);
        visual = undefined;
      }
      if (!visual) {
        visual = this.makeActor(actor, dead);
        this.actorVisuals.set(actor.id, visual);
      }
      if (dead) corpses += 1;
      visual.root.visible = !dead || corpses <= 8;
      visual.root.position.set(actor.x, 0.08, actor.z);
      visual.root.rotation.y = actor.heading;
      let moved = 0;
      if (tickChanged) {
        moved = Math.hypot(actor.x - visual.lastX, actor.z - visual.lastZ);
        visual.speed = moved / tickDt;
        visual.lastX = actor.x;
        visual.lastZ = actor.z;
      }
      if (visual.state !== actor.state) {
        visual.state = actor.state;
        visual.stateDuration = actor.stateTime;
      }
      const progress = THREE.MathUtils.clamp(1 - actor.stateTime / Math.max(visual.stateDuration, 0.01), 0, 1);
      const hit = tickChanged && actor.hp < visual.lastHp;
      if (tickChanged) visual.lastHp = actor.hp;
      visual.character?.update({
        state: dead ? 'dead' : actor.state === 'windup' || actor.state === 'attack' || actor.state === 'recovery' ? actor.state
          : !paused && visual.speed > 0.35 ? 'move' : 'idle',
        progress,
        speed: paused ? 0 : visual.speed,
        hit,
        relaxed: storyOpen,
        reducedMotion,
      }, dt);
      visual.actor?.animate({
        moving: visual.speed / 4,
        time: snapshot.elapsed,
        attacking: actor.state === 'attack' ? progress : 0,
        winding: actor.state === 'windup' ? 0.35 + progress * 0.65 : 0,
        dodging: false,
        dead,
        reducedMotion,
      });
      const driving = visual.speed < 30;
      visual.wagon?.update({
        distance: driving ? moved : 0,
        speed: !paused && driving ? visual.speed : 0,
        tilt: disabledShipment ? 0.085 : dead ? 0.27 : 0,
        cargo: false,
        hit,
        reducedMotion,
        time: snapshot.elapsed,
      }, dt);
      visual.bar.root.visible = !dead && (actor.hp < actor.maxHp || actor.state === 'windup' || actor.kind === 'boss');
      updateHealth(visual.bar, actor.hp, actor.maxHp, camera, visual.root);
      visual.tell.visible = actor.state === 'windup' && !dead &&
        (actor.allegiance === undefined || actor.allegiance === 'hostile');
      visual.tell.position.set(actor.x, 0, actor.z);
      visual.tell.rotation.y = actor.heading;
      visual.tellRing.scale.setScalar((actor.kind === 'archer' ? actor.radius + 0.45 : actor.attackRange) * 2);
      visual.tellRing.visible = true;
      visual.tellLine.visible = actor.kind === 'archer';
      visual.tellLine.position.set(0, 0.07, actor.attackRange / 2);
      visual.tellLine.scale.set(0.12 + progress * 0.1, 0.015, actor.attackRange);
    }
    for (const [id, visual] of this.actorVisuals) {
      if (activeIds.has(id)) continue;
      this.removeActor(id, visual);
    }

    for (const post of snapshot.outposts) {
      let visual = this.postVisuals.get(post.id);
      if (!visual) {
        visual = this.makePost(post);
        this.postVisuals.set(post.id, visual);
      }
      const color = post.owner === 'player' ? palette.teal : factionColors[post.faction];
      visual.flag.material = this.resources.material(color, { side: THREE.DoubleSide, surface: 'cloth' });
      visual.flag.rotation.y = reducedMotion ? 0 : Math.sin(this.cosmeticTime * 1.35 + post.x) * 0.12;
      visual.ring.material = this.resources.material(post.owner === 'player' ? palette.teal : palette.hostile,
        { unlit: true, opacity: 0.34, depthWrite: false });
      visual.progressGeometry.setDrawRange(0, Math.floor(THREE.MathUtils.clamp(post.captureProgress, 0, 1) * 80) * 6);
      visual.progress.visible = post.owner !== 'player' && post.captureProgress > 0;
      visual.supply.visible = post.supplied;
      visual.supply.quaternion.copy(camera.quaternion);
    }
    this.effects.update(snapshot, dt, this.cosmeticTime, reducedMotion);
    this.residents.update(snapshot, camera, reducedMotion);
    this.lastTick = snapshot.tick;
  }

  dispose(): void {
    for (const visual of this.actorVisuals.values()) {
      visual.character?.dispose();
      visual.wagon?.dispose();
    }
    this.convoy?.dispose();
    this.hero?.character?.dispose();
    this.effects.dispose();
    this.residents.dispose();
    this.scenery.dispose();
    this.sun.shadow.dispose();
    this.scene.clear();
    this.actorVisuals.clear();
    this.postVisuals.clear();
    this.resources.dispose();
  }
}

/**
 * Renders `scene` with a real frame's lights, fog, shadow maps and output path while shading almost no pixels, so a
 * shader warm-up pays for program compilation, not for extra full frames (SwiftShader and low-end GPUs). Program keys
 * depend on whether a frame renders into a target, not on its size: pass a tiny `target` when real frames render
 * through post-processing, or null when they render straight to the canvas.
 */
export function compileFrame(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null,
): void {
  if (target) {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
    return;
  }
  const scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest();
  renderer.setScissor(0, 0, 1, 1);
  renderer.setScissorTest(true);
  renderer.render(scene, camera);
  renderer.setScissor(scissor);
  renderer.setScissorTest(scissorTest);
}

/**
 * Browser-only Three presenter. It owns GPU resources, not input, RAF or game rules.
 * A changed world/run/faction rebuilds the mirror and releases the previous run.
 * Nothing is presented until every cooked model is loaded; a load failure is thrown by `render`.
 * Import from this module, never from the Aegis Node renderer entry point.
 */
export function createGameView(canvas: HTMLCanvasElement, blueprint: WorldBlueprint, options: GameViewOptions = {}): GameView {
  const ownsRenderer = options.renderer === undefined;
  const renderer = options.renderer ?? createRenderer(canvas);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(palette.ink);
  const camera = new FollowCamera(canvas);
  const ownsModels = options.models === undefined;
  const models = options.models ?? new ModelLibrary(gltfModelSource());
  const createResources = () => new ViewResources(new THREE.TextureLoader(), renderer.capabilities.getMaxAnisotropy(), models);
  let presentation: Presentation | undefined;
  let environment: THREE.WebGLRenderTarget | undefined;
  let postprocessing: WorldPostprocessing | undefined;
  let quality: ViewQuality = options.quality ?? 'high';
  let reducedMotion = options.reducedMotion ?? false;
  let disposed = false;
  let contextLost = false;
  let runId: string | undefined;
  let faction: GameSnapshot['faction'] | undefined;
  let lastTick = -1;
  let needsWarmup = true;
  let warmup: ModelWarmup | undefined;
  const warmTarget = new THREE.WebGLRenderTarget(4, 4);

  function assertUsable(): void {
    if (disposed) throw new Error('The Korovany II view has already been disposed.');
    if (contextLost) throw new Error('The 3D graphics context was lost. Reload to restore the campaign view.');
  }
  function resize(): void {
    assertUsable();
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : 1.75));
    renderer.setSize(width, height, false);
    camera.resize(width, height);
    postprocessing?.resize(width, height, renderer.getPixelRatio());
  }
  function applyQuality(): void {
    presentation?.setQuality(quality === 'low');
    renderer.shadowMap.enabled = quality !== 'low';
    // Shadow and post-processing changes alter program keys; recompile the model variants before the next frame.
    needsWarmup = true;
    if (quality === 'low' || !presentation) {
      postprocessing?.dispose();
      postprocessing = undefined;
    } else if (!postprocessing) {
      postprocessing = new WorldPostprocessing(renderer, presentation.scene, camera.camera);
      const size = renderer.getSize(new THREE.Vector2());
      postprocessing.resize(size.x, size.y, renderer.getPixelRatio());
    }
  }
  function present(world: WorldBlueprint): Presentation {
    postprocessing?.dispose();
    postprocessing = undefined;
    presentation?.dispose();
    const next = new Presentation(world, createResources(), environment?.texture);
    environment ??= skyEnvironment(renderer, next.scenery.group);
    next.scene.environment = environment.texture;
    presentation = next;
    camera.reset();
    applyQuality();
    return next;
  }
  function onContextLost(event: Event): void {
    event.preventDefault();
    contextLost = true;
  }
  function onContextRestored(): void {
    contextLost = false;
  }
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  camera.setReducedMotion(reducedMotion);
  resize();
  if (models.isReady) present(blueprint);
  else applyQuality();

  return {
    render(snapshot, dt): void {
      assertUsable();
      if (!Number.isFinite(dt) || dt < 0) throw new Error('View frame time must be a finite nonnegative number.');
      models.assert();
      if (!models.isReady) {
        renderer.setRenderTarget(null);
        renderer.clear();
        return;
      }
      let current = presentation;
      if (!current || snapshot.world.id !== current.world.id
        || (runId !== undefined && (runId !== snapshot.runId || faction !== snapshot.faction || snapshot.tick < lastTick))) {
        current = present(snapshot.world);
      }
      runId = snapshot.runId;
      faction = snapshot.faction;
      lastTick = snapshot.tick;
      const frameDt = Math.min(dt, 0.1);
      camera.update(snapshot.player, frameDt);
      current.update(snapshot, frameDt, camera.camera, reducedMotion);
      const draw = (): void => {
        if (postprocessing) postprocessing.render();
        else renderer.render(current.scene, camera.camera);
      };
      if (needsWarmup) {
        // Same task as the real frame below, which overwrites any warm-up pixel before the canvas is presented.
        warmup = current.warmModels(renderer, snapshot.player.x, snapshot.player.z,
          () => compileFrame(renderer, current.scene, camera.camera, postprocessing ? warmTarget : null));
        needsWarmup = false;
      }
      draw();
    },
    getMoveBasis: () => camera.getMoveBasis(),
    screenToWorld: (clientX, clientY) => camera.screenToWorld(clientX, clientY),
    resize,
    orbit(deltaYaw, deltaPitch = 0): void {
      assertUsable();
      camera.orbit(deltaYaw, deltaPitch);
    },
    zoom(delta): void {
      assertUsable();
      camera.zoom(delta);
    },
    setQuality(value): void {
      assertUsable();
      if (value !== 'low' && value !== 'high') throw new Error(`Unknown view quality: ${value}`);
      quality = value;
      applyQuality();
      resize();
    },
    setReducedMotion(value): void {
      assertUsable();
      reducedMotion = value;
      camera.setReducedMotion(value);
    },
    get models(): ModelStatus {
      return models.status;
    },
    get warmup(): ModelWarmup | undefined {
      return warmup;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      presentation?.dispose();
      postprocessing?.dispose();
      environment?.dispose();
      warmTarget.dispose();
      if (ownsModels) models.dispose();
      if (ownsRenderer) {
        // A borrowed library's GPU copies belong to this renderer; release them before it goes away.
        if (!ownsModels) models.releaseGpu();
        renderer.dispose();
      }
    },
  };
}