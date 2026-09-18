import * as THREE from 'three';
import type { ActorSnapshot, GameSnapshot, OutpostSnapshot, WorldBlueprint } from '../game/types';
import { createActor, createWagon, type ActorLook, type ActorModel, type ViewAllegiance, type WagonModel } from './actors';
import { FollowCamera, type GroundPoint, type MovementBasis } from './camera';
import { WorldEffects } from './effects';
import { factionColors, palette } from './palette';
import { part, shapeGeometry } from './primitives';
import { ViewResources } from './resources';
import { WorldResidents } from './residents';
import { createWorldScenery, type WorldScenery } from './world';
import { lightWorld, positionSun, skyEnvironment } from './atmosphere';
import { WorldPostprocessing } from './postprocessing';

export type { GroundPoint, MovementBasis } from './camera';
export type ViewQuality = 'low' | 'high';

export interface GameViewOptions {
  quality?: ViewQuality;
  reducedMotion?: boolean;
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
  wagon?: WagonModel;
  bar: HealthBar;
  tell: THREE.Group;
  tellRing: THREE.Mesh;
  tellLine: THREE.Mesh;
  lastX: number;
  lastZ: number;
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
  private hero: ActorModel | undefined;
  private convoy: WagonModel | undefined;
  private convoyBar: HealthBar | undefined;
  private convoyCargo: THREE.Group | undefined;
  private fortressFlag: THREE.Mesh | undefined;
  private fortressRing: THREE.Mesh | undefined;
  private lastTick = -1;
  private lastPlayerX = 0;
  private lastPlayerZ = 0;
  private playerSpeed = 0;
  private lastConvoyX = 0;
  private lastConvoyZ = 0;
  private convoyDistance = 0;
  private convoySpeed = 0;
  private cosmeticTime = 0;

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

  private makeActor(snapshot: ActorSnapshot): ActorVisual {
    const affiliation = snapshot.allegiance ?? false;
    const actor = snapshot.kind === 'caravan' ? undefined : createActor(this.resources,
      ({ soldier: 'guard', archer: 'archer', captain: 'brute', boss: 'boss' } satisfies Record<Exclude<ActorSnapshot['kind'], 'caravan'>, ActorLook>)[snapshot.kind],
      snapshot.faction, affiliation);
    const wagon = snapshot.kind === 'caravan' ? createWagon(this.resources, affiliation) : undefined;
    const root = actor?.root ?? wagon?.root;
    if (!root) throw new Error(`Unsupported actor kind: ${snapshot.kind}`);
    root.name = `actor:${snapshot.id}`;
    this.scene.add(root);
    const bar = healthBar(this.resources, root, actor?.height ?? 2.95, affiliation);
    const tell = createTell(this.resources, this.scene);
    tell.group.name = `tell:${snapshot.id}`;
    return {
      appearance: `${snapshot.kind}:${snapshot.faction}:${snapshot.allegiance ?? 'legacy'}`,
      root, actor, wagon, bar, tell: tell.group, tellRing: tell.ring, tellLine: tell.line,
      lastX: snapshot.x, lastZ: snapshot.z, speed: 0, state: snapshot.state, stateDuration: snapshot.stateTime,
    };
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
      this.hero = createActor(this.resources, 'hero', snapshot.faction, true);
      this.scene.add(this.hero.root);
      this.convoy = createWagon(this.resources, true);
      this.scene.add(this.convoy.root);
      this.convoyBar = healthBar(this.resources, this.convoy.root, 2.92, true);
      this.convoyCargo = new THREE.Group();
      this.convoy.root.add(this.convoyCargo);
      for (const x of [-0.43, 0.37]) {
        part(this.resources, this.convoyCargo, 'box', palette.teal, [x, 1.39, -0.88], [0.5, 0.36, 0.4]);
      }
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
      this.playerSpeed = Math.hypot(snapshot.player.x - this.lastPlayerX, snapshot.player.z - this.lastPlayerZ) / tickDt;
      this.convoyDistance = Math.hypot(snapshot.convoy.x - this.lastConvoyX, snapshot.convoy.z - this.lastConvoyZ);
      this.convoySpeed = this.convoyDistance / tickDt;
      this.lastPlayerX = snapshot.player.x;
      this.lastPlayerZ = snapshot.player.z;
      this.lastConvoyX = snapshot.convoy.x;
      this.lastConvoyZ = snapshot.convoy.z;
    }
    const heroRoot = this.hero.root;
    heroRoot.position.set(snapshot.player.x, 0.08, snapshot.player.z);
    heroRoot.rotation.y = snapshot.player.heading;
    this.hero.animate({
      moving: this.playerSpeed / Math.max(1, snapshot.player.speed),
      time: snapshot.elapsed,
      attacking: snapshot.player.state === 'attack' ? THREE.MathUtils.clamp(1 - snapshot.player.attackCooldown / 0.6, 0, 1) : 0,
      winding: 0,
      dodging: snapshot.player.state === 'dodge',
      dead: snapshot.player.state === 'dead',
      reducedMotion,
    });
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

    if (this.convoy && this.convoyBar && this.convoyCargo) {
      this.convoy.root.position.set(snapshot.convoy.x, 0.08, snapshot.convoy.z);
      this.convoy.root.rotation.y = snapshot.convoy.heading;
      this.convoy.animate(tickChanged ? this.convoyDistance : 0, snapshot.elapsed, reducedMotion, this.convoySpeed / 2);
      this.convoyCargo.visible = snapshot.convoy.cargo > 0;
      this.convoy.root.rotation.z = snapshot.convoy.disabled ? 0.085 : 0;
      this.convoyBar.root.visible = snapshot.convoy.hp < snapshot.convoy.maxHp || snapshot.convoy.disabled;
      updateHealth(this.convoyBar, snapshot.convoy.hp, snapshot.convoy.maxHp, camera, this.convoy.root);
    }
    const activeIds = new Set<string>();
    let corpses = 0;
    for (const actor of snapshot.actors) {
      activeIds.add(actor.id);
      let visual = this.actorVisuals.get(actor.id);
      const appearance = `${actor.kind}:${actor.faction}:${actor.allegiance ?? 'legacy'}`;
      if (visual && visual.appearance !== appearance) {
        visual.root.removeFromParent();
        visual.tell.removeFromParent();
        this.actorVisuals.delete(actor.id);
        visual = undefined;
      }
      if (!visual) {
        visual = this.makeActor(actor);
        this.actorVisuals.set(actor.id, visual);
      }
      const disabledShipment = snapshot.campaign?.shipment.targetId === actor.id && actor.state !== 'dead' && actor.hp <= 0;
      const dead = actor.state === 'dead' || (actor.hp <= 0 && !disabledShipment);
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
      visual.actor?.animate({
        moving: visual.speed / 4,
        time: snapshot.elapsed,
        attacking: actor.state === 'attack' ? progress : 0,
        winding: actor.state === 'windup' ? 0.35 + progress * 0.65 : 0,
        dodging: false,
        dead,
        reducedMotion,
      });
      visual.wagon?.animate(moved, snapshot.elapsed, reducedMotion, visual.speed / 2);
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
      if (visual.wagon) visual.root.rotation.z = disabledShipment ? 0.085 : dead ? 0.27 : 0;
    }
    for (const [id, visual] of this.actorVisuals) {
      if (activeIds.has(id)) continue;
      visual.root.removeFromParent();
      visual.tell.removeFromParent();
      this.actorVisuals.delete(id);
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
 * Browser-only Three presenter. It owns GPU resources, not input, RAF or game rules.
 * A changed world/run/faction rebuilds the mirror and releases the previous run.
 * Import from this module, never from the Aegis Node renderer entry point.
 */
export function createGameView(canvas: HTMLCanvasElement, blueprint: WorldBlueprint, options: GameViewOptions = {}): GameView {
  let renderer: THREE.WebGLRenderer;
  try {
    const context = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'high-performance' });
    if (!context) throw new Error('WebGL 2 is not available in this browser.');
    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false });
  } catch (cause) {
    throw new Error('Korovany II could not start its 3D renderer. Enable hardware acceleration and WebGL 2, then reload.', { cause });
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const camera = new FollowCamera(canvas);
  const createResources = () => new ViewResources(new THREE.TextureLoader(), renderer.capabilities.getMaxAnisotropy());
  let presentation = new Presentation(blueprint, createResources());
  const environment = skyEnvironment(renderer, presentation.scenery.group);
  presentation.scene.environment = environment.texture;
  let postprocessing: WorldPostprocessing | undefined;
  let quality: ViewQuality = options.quality ?? 'high';
  let reducedMotion = options.reducedMotion ?? false;
  let disposed = false;
  let contextLost = false;
  let runId: string | undefined;
  let faction: GameSnapshot['faction'] | undefined;
  let lastTick = -1;

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
    presentation.setQuality(quality === 'low');
    renderer.shadowMap.enabled = quality !== 'low';
    if (quality === 'low') {
      postprocessing?.dispose();
      postprocessing = undefined;
    } else if (!postprocessing) {
      postprocessing = new WorldPostprocessing(renderer, presentation.scene, camera.camera);
      const size = renderer.getSize(new THREE.Vector2());
      postprocessing.resize(size.x, size.y, renderer.getPixelRatio());
    }
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
  applyQuality();
  resize();

  return {
    render(snapshot, dt): void {
      assertUsable();
      if (!Number.isFinite(dt) || dt < 0) throw new Error('View frame time must be a finite nonnegative number.');
      if (snapshot.world.id !== presentation.world.id || (runId !== undefined && (runId !== snapshot.runId || faction !== snapshot.faction || snapshot.tick < lastTick))) {
        postprocessing?.dispose();
        postprocessing = undefined;
        presentation.dispose();
        presentation = new Presentation(snapshot.world, createResources(), environment.texture);
        camera.reset();
        applyQuality();
      }
      runId = snapshot.runId;
      faction = snapshot.faction;
      lastTick = snapshot.tick;
      const frameDt = Math.min(dt, 0.1);
      camera.update(snapshot.player, frameDt);
      presentation.update(snapshot, frameDt, camera.camera, reducedMotion);
      if (postprocessing) postprocessing.render();
      else renderer.render(presentation.scene, camera.camera);
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      presentation.dispose();
      postprocessing?.dispose();
      environment.dispose();
      renderer.dispose();
    },
  };
}
