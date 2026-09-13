import * as THREE from 'three';
import type { Obstacle, Vec2, WorldBlueprint, WorldLocation } from '../game/types';
import { palette } from './palette';
import { beam, part } from './primitives';
import type { ViewResources } from './resources';

export interface RegionTheme {
  ground: string;
  patches: string;
  stone: string;
  roof: string;
  foliage: readonly [string, string, string];
  accent: string;
}

export const regionThemes: Readonly<Record<string, RegionTheme>> = {
  heartlands: { ground: palette.meadow, patches: '#afb078', stone: palette.stone, roof: palette.slate, foliage: [palette.leafDark, palette.leaf, palette.leafLight], accent: palette.brass },
  greenmarch: { ground: '#788f56', patches: '#6b8151', stone: '#a0a184', roof: '#526342', foliage: ['#294e3d', '#426d47', '#7b9658'], accent: '#d2aa5c' },
  fenlands: { ground: '#687e70', patches: '#576d61', stone: '#899c92', roof: '#6c6650', foliage: ['#355b55', '#587c68', '#8d9e6a'], accent: '#e4bf72' },
  saltcoast: { ground: '#c3b788', patches: '#b0ac8c', stone: '#d0c8ad', roof: '#497f85', foliage: ['#4c7164', '#688a76', '#9ca88a'], accent: '#72b9b0' },
  ashsteppe: { ground: '#a18367', patches: '#897364', stone: '#686967', roof: '#683f35', foliage: ['#474840', '#676652', '#a49166'], accent: '#b7d5ac' },
  crownlands: { ground: '#afb081', patches: '#a2a06e', stone: '#c1bbae', roof: '#505c77', foliage: ['#42564b', '#718363', '#99a27a'], accent: '#b18b4d' },
  frostspine: { ground: '#c6d0c8', patches: '#a6b8b4', stone: '#9facb0', roof: '#536977', foliage: ['#4e6c6f', '#91aba6', '#d6ddd1'], accent: '#c6dbde' },
  hollowvale: { ground: '#849184', patches: '#778077', stone: '#a3a7a1', roof: '#605963', foliage: ['#414d52', '#64766c', '#a2ab90'], accent: '#b7a4bd' },
};

export function themeAt(world: WorldBlueprint, point: Vec2): RegionTheme {
  const region = world.exploration?.regions.find(r => point.x >= r.bounds.minX && point.x <= r.bounds.maxX
    && point.z >= r.bounds.minZ && point.z <= r.bounds.maxZ);
  return regionThemes[region?.id ?? 'heartlands'] ?? regionThemes.heartlands!;
}

function ledger(resources: ViewResources, root: THREE.Group, radius: number, height: number): void {
  part(resources, root, 'box', palette.parchment, [0, height * 0.48, radius * 0.71], [radius * 0.6, height * 0.32, 0.08]);
  for (let row = 0; row < 3; row++) {
    part(resources, root, 'box', palette.ink, [0, height * (0.41 + row * 0.065), radius * 0.73], [radius * 0.43, 0.055, 0.08]);
  }
  part(resources, root, 'box', '#995847', [0, height * 0.48, radius * 0.75], [radius * 0.64, 0.09, 0.08], [0, 0, -0.48]);
}

function arch(resources: ViewResources, root: THREE.Group, r: number, h: number, color: string): void {
  const wooden = color === palette.timber;
  for (const side of [-1, 1]) {
    part(resources, root, 'box', color, [side * r * 0.65, h * 0.26, 0], [r * 0.25, h * 0.52, r * 0.45], [0, 0, 0], wooden ? 'wood' : 'stone');
    for (const level of [0.035, 0.5]) {
      part(resources, root, 'box', color, [side * r * 0.65, h * level, 0], [r * 0.32, h * 0.055, r * 0.54], [0, 0, 0], wooden ? 'wood' : 'stone');
    }
  }
  if (wooden) {
    part(resources, root, 'box', palette.timber, [0, h * 0.77, 0], [r * 1.65, h * 0.085, r * 0.45]);
    for (const side of [-1, 1]) {
      part(resources, root, 'box', palette.timber, [side * r * 0.65, h * 0.64, 0], [r * 0.25, h * 0.26, r * 0.4]);
      beam(resources, root, [side * r * 0.65, h * 0.53, 0], [side * r * 0.18, h * 0.75, 0], r * 0.095, palette.timberLight);
    }
    return;
  }
  const geometry = resources.geometry('arch-voussoir', () => {
    const halfAngle = Math.PI / 18 - 0.012;
    const outline = new THREE.Shape();
    outline.absarc(0, 0, 0.5, -halfAngle, halfAngle, false);
    outline.lineTo(Math.cos(halfAngle) * 0.34, Math.sin(halfAngle) * 0.34);
    outline.absarc(0, 0, 0.34, halfAngle, -halfAngle, true);
    outline.closePath();
    return new THREE.ExtrudeGeometry(outline, { depth: 1, bevelEnabled: false, curveSegments: 3 }).translate(0, 0, -0.5);
  });
  const crown = new THREE.Group();
  crown.name = 'segmented-arch';
  crown.position.y = h * 0.52;
  crown.scale.set(r * 1.56, h * 0.6, r * 0.5);
  root.add(crown);
  for (let index = 0; index < 9; index++) {
    const stone = new THREE.Mesh(geometry, resources.material(color, { side: THREE.FrontSide, surface: 'stone' }));
    stone.rotation.z = (index + 0.5) * Math.PI / 9;
    stone.castShadow = stone.receiveShadow = true;
    stone.customDepthMaterial = resources.depthMaterial();
    crown.add(stone);
  }
}

function gabledRoof(resources: ViewResources, root: THREE.Group, r: number, eave: number, rise: number, color: string): void {
  const roof = part(resources, root, 'roof', color, [0, eave + rise * 0.5, 0], [r * 1.44, rise, r * 1.28], [0, 0, 0], 'roof');
  roof.name = 'gabled-roof';
  part(resources, root, 'box', palette.timber, [0, eave + rise, 0], [r * 0.075, r * 0.07, r * 1.32]);
  for (const side of [-1, 1]) {
    part(resources, root, 'box', palette.timber, [side * r * 0.69, eave, 0], [r * 0.07, r * 0.075, r * 1.31]);
    beam(resources, root, [side * r * 0.695, eave, r * 0.645], [0, eave + rise, r * 0.645], r * 0.045, palette.timberLight);
  }
}

function framedWindow(resources: ViewResources, root: THREE.Group, x: number, y: number, z: number, width: number, height: number): void {
  const window = new THREE.Group();
  window.name = 'framed-window';
  window.position.set(x, y, z);
  root.add(window);
  part(resources, window, 'box', palette.bark, [0, 0, 0], [width * 1.24, height * 1.18, 0.12]);
  const pane = part(resources, window, 'box', palette.sun, [0, 0, 0.07], [width, height, 0.035]);
  pane.material = resources.material(palette.sun, { emissive: '#9b541f' });
  part(resources, window, 'box', palette.timber, [0, 0, 0.1], [width * 0.09, height, 0.04]);
  part(resources, window, 'box', palette.timber, [0, 0, 0.1], [width, height * 0.07, 0.04]);
  part(resources, window, 'box', palette.timberLight, [0, -height * 0.6, 0.08], [width * 1.42, height * 0.1, 0.24]);
  for (const side of [-1, 1]) {
    part(resources, window, 'box', palette.timber, [side * width * 0.78, 0, 0.01], [width * 0.27, height * 1.08, 0.07], [0, side * 0.15, 0]);
  }
}

function buttresses(resources: ViewResources, root: THREE.Group, r: number, h: number, color: string): void {
  for (const side of [-1, 1]) {
    for (const z of [-0.36, 0.36]) {
      part(resources, root, 'box', color, [side * r * 0.66, h * 0.17, z * r], [r * 0.22, h * 0.34, r * 0.26], [0, 0, 0], 'stone');
      part(resources, root, 'box', color, [side * r * 0.64, h * 0.39, z * r], [r * 0.16, h * 0.17, r * 0.2], [0, 0, 0], 'stone');
    }
  }
}

/** Every silhouette stays inside its authoritative circular building footprint. */
export function locationStructure(resources: ViewResources, obstacle: Obstacle, place: WorldLocation, theme: RegionTheme): THREE.Group {
  const root = new THREE.Group();
  root.name = `location:${place.id}:${obstacle.variant}`;
  root.position.set(obstacle.x, 0, obstacle.z);
  root.rotation.y = Math.atan2(place.x - obstacle.x, place.z - obstacle.z);
  const r = obstacle.radius, h = obstacle.height;
  part(resources, root, 'disc', theme.stone, [0, 0.08, 0], [r * 1.96, 0.16, r * 1.96], [0, 0, 0], 'stone');

  if (place.id === 'glass-quarry') {
    part(resources, root, 'rock', '#596a62', [0, 0.5, 0], [r * 1.9, 1, r * 1.9], [0, 0, 0], 'rock');
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2;
      part(resources, root, 'cone', i % 2 ? '#94b2a0' : '#6e958b',
        [Math.sin(angle) * r * 0.4, h * (0.25 + i * 0.045), Math.cos(angle) * r * 0.4],
        [r * 0.62, h * (0.5 + i * 0.09), r * 0.62]);
    }
  } else if (place.id === 'old-orchard') {
    part(resources, root, 'cylinder', palette.bark, [0, h * 0.38, 0], [r * 0.35, h * 0.76, r * 0.35]);
    for (const side of [-1, 1]) {
      beam(resources, root, [0, h * 0.38, 0], [side * r * 0.64, h * 0.82, 0], r * 0.15, palette.bark);
      part(resources, root, 'foliage', theme.foliage[1], [side * r * 0.4, h * 0.84, 0], [r, h * 0.36, r * 1.25]);
      part(resources, root, 'box', theme.accent, [side * r * 0.4, h * 0.45, r * 0.13], [0.24, 0.32, 0.05]);
    }
  } else if (place.id === 'name-well' || place.id === 'cinderwell' && obstacle.variant === 0) {
    part(resources, root, 'cylinder', theme.stone, [0, 0.72, 0], [r * 1.4, 1.35, r * 1.4], [0, 0, 0], 'stone');
    part(resources, root, 'disc', palette.ink, [0, 1.405, 0], [r, 0.04, r]);
    part(resources, root, 'torus', theme.stone, [0, 1.4, 0], [r * 1.45, r * 1.45, r * 0.6], [Math.PI / 2, 0, 0], 'stone');
    arch(resources, root, r, h, palette.timber);
    gabledRoof(resources, root, r, h * 0.8, h * 0.2, theme.roof);
    part(resources, root, 'cylinder', palette.timberLight, [0, h * 0.51, 0], [0.16, r * 1.3, 0.16], [0, 0, Math.PI / 2]);
    part(resources, root, 'box', palette.bark, [0, h * 0.4, 0], [0.055, h * 0.34, 0.055]);
    part(resources, root, 'cylinder', palette.timber, [0, h * 0.22, 0], [r * 0.2, r * 0.23, r * 0.2]);
    for (const side of [-1, 1]) part(resources, root, 'cloth', theme.accent, [side * r * 0.32, h * 0.61, 0], [r * 0.21, h * 0.26, 1]);
  } else if (place.id === 'ash-cairn') {
    for (let tier = 0; tier < 5; tier++) {
      const width = r * (1.9 - tier * 0.3);
      part(resources, root, 'rock', tier % 2 ? theme.stone : '#d0cab4', [0, 0.5 + tier * 0.8, 0],
        [width, 1.3, width], [0, tier * 1.3, 0], 'rock');
    }
    part(resources, root, 'box', palette.timber, [0, h * 0.62, 0], [0.12, h * 0.75, 0.12]);
    part(resources, root, 'cloth', theme.accent, [r * 0.28, h * 0.87, 0], [r * 0.6, h * 0.12, 1]);
  } else if (place.id === 'tide-observatory' || place.id === 'star-monastery' && obstacle.variant === 0) {
    part(resources, root, 'cylinder', theme.stone, [0, h * 0.26, 0], [r * 0.8, h * 0.52, r * 0.8], [0, 0, 0], 'stone');
    for (const tier of [0.06, 0.43, 0.51]) {
      part(resources, root, 'cylinder', theme.stone, [0, h * tier, 0], [r * 0.99, h * 0.055, r * 0.99], [0, 0, 0], 'stone');
    }
    for (const side of [-1, 1]) {
      part(resources, root, 'box', theme.stone, [side * r * 0.46, h * 0.19, 0], [r * 0.17, h * 0.38, r * 0.38], [0, 0, 0], 'stone');
    }
    const geometry = resources.geometry('armillary-ring', () => new THREE.TorusGeometry(1, 0.055, 6, 28));
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(geometry, resources.material(theme.accent, { side: THREE.FrontSide }));
      ring.position.y = h * 0.58;
      ring.scale.setScalar(r * 0.81);
      ring.rotation.set(i * Math.PI / 3, i * Math.PI / 4, 0.4);
      ring.castShadow = true;
      ring.customDepthMaterial = resources.depthMaterial();
      ring.receiveShadow = true;
      root.add(ring);
    }
    part(resources, root, 'sphere', theme.accent, [0, h * 0.58, 0], [0.45, 0.45, 0.45]);
    beam(resources, root, [0, h * 0.45, 0], [0, h * 0.75, 0], r * 0.045, theme.accent);
  } else if (place.id === 'frozen-beacon') {
    part(resources, root, 'cylinder', theme.stone, [0, h * 0.39, 0], [r * 1.15, h * 0.78, r * 1.15], [0, 0, 0], 'stone');
    buttresses(resources, root, r, h, theme.stone);
    for (const level of [0.15, 0.44, 0.76]) {
      part(resources, root, 'cylinder', theme.stone, [0, h * level, 0], [r * 1.26, h * 0.035, r * 1.26], [0, 0, 0], 'stone');
    }
    part(resources, root, 'cylinder', theme.roof, [0, h * 0.8, 0], [r * 1.75, h * 0.08, r * 1.75], [0, 0, 0], 'roof');
    for (let merlon = 0; merlon < 8; merlon++) {
      const angle = merlon * Math.PI / 4;
      part(resources, root, 'box', theme.stone, [Math.sin(angle) * r * 0.75, h * 0.87, Math.cos(angle) * r * 0.75],
        [r * 0.2, h * 0.1, r * 0.17], [0, angle, 0], 'stone');
    }
    part(resources, root, 'box', palette.ink, [0, h * 0.55, r * 0.568], [r * 0.12, h * 0.16, 0.035]);
    part(resources, root, 'rock', theme.accent, [0, h * 0.93, 0], [r * 0.85, h * 0.2, r * 0.85]);
    for (const side of [-1, 1]) part(resources, root, 'box', palette.iron, [side * r * 0.54, h * 0.95, 0], [0.1, h * 0.3, 0.1]);
  } else if (place.id === 'bell-foundry' || place.id === 'reed-chapel') {
    arch(resources, root, r, h, place.id === 'reed-chapel' ? palette.timber : theme.stone);
    part(resources, root, 'cone', theme.accent, [0, h * 0.59, 0], [r * 0.92, h * 0.28, r * 0.92]);
    part(resources, root, 'disc', theme.accent, [0, h * 0.46, 0], [r * 1.02, 0.18, r * 1.02]);
    part(resources, root, 'sphere', palette.iron, [0, h * 0.43, 0], [r * 0.12, h * 0.12, r * 0.12]);
    beam(resources, root, [0, h * 0.6, 0], [0, h * 0.76, 0], r * 0.07, palette.iron);
    gabledRoof(resources, root, r, h * 0.83, h * 0.23, theme.roof);
  } else if (place.kind === 'shrine') {
    arch(resources, root, r, h, theme.stone);
    part(resources, root, 'box', theme.accent, [0, h * 0.18, r * 0.18], [r * 0.7, h * 0.33, r * 0.7]);
    if (place.id === 'stag-shrine') {
      for (const side of [-1, 1]) {
        beam(resources, root, [side * r * 0.25, h * 0.81, 0], [side * r * 0.68, h * 1.17, 0], 0.14, palette.parchment);
        beam(resources, root, [side * r * 0.49, h, 0], [side * r * 0.17, h * 1.16, 0], 0.12, palette.parchment);
      }
    } else {
      gabledRoof(resources, root, r, h * 0.84, h * 0.2, theme.roof);
    }
  } else if (place.kind === 'ruin') {
    for (const side of [-1, 1]) {
      part(resources, root, 'box', theme.stone, [side * r * 0.56, h * (side === 1 ? 0.38 : 0.5), 0],
        [r * 0.45, h * (side === 1 ? 0.76 : 1), r * 0.9], [0, 0, 0], 'stone');
      for (const level of [0.08, 0.38, 0.7]) {
        part(resources, root, 'box', theme.stone, [side * r * 0.56, h * level, 0], [r * 0.51, h * 0.045, r * 0.95], [0, 0, 0], 'stone');
      }
      part(resources, root, 'rock', theme.stone, [side * r * 0.4, h * (side === 1 ? 0.78 : 1), -r * 0.15],
        [r * 0.56, h * 0.18, r * 0.6], [0, side * 0.3, 0], 'stone');
    }
    for (let shelf = 0; shelf < 4; shelf++) {
      part(resources, root, 'box', theme.stone, [0, 0.35 + shelf * h * 0.18, -r * 0.18], [r * 1.5, 0.18, r * 0.5], [0, 0, 0], 'stone');
      part(resources, root, 'box', shelf % 2 ? palette.parchment : theme.accent,
        [(shelf % 3 - 1) * r * 0.22, 0.63 + shelf * h * 0.18, -r * 0.18], [r * 0.18, 0.4, r * 0.3]);
    }
    if (place.id === 'tax-vault') {
      part(resources, root, 'box', palette.iron, [0, h * 0.4, r * 0.53], [r * 1.08, h * 0.73, 0.12]);
      ledger(resources, root, r, h);
    }
  } else {
    const stoneHouse = place.regionId === 'crownlands' || place.regionId === 'frostspine';
    const wall = stoneHouse ? theme.stone : palette.timber;
    part(resources, root, 'box', theme.stone, [0, h * 0.07, 0], [r * 1.3, h * 0.14, r * 1.2], [0, 0, 0], 'stone');
    part(resources, root, 'box', wall, [0, h * 0.37, 0], [r * 1.22, h * 0.57, r * 1.12], [0, 0, 0], stoneHouse ? 'stone' : 'wood');
    gabledRoof(resources, root, r, h * 0.66, h * 0.37, theme.roof);
    for (const level of [0.15, 0.61]) {
      part(resources, root, 'box', palette.bark, [0, h * level, r * 0.577], [r * 1.28, r * 0.065, r * 0.075]);
    }
    for (const side of [-1, 1]) {
      for (const end of [-1, 1]) {
        part(resources, root, 'box', palette.bark, [side * r * 0.595, h * 0.37, end * r * 0.55], [r * 0.075, h * 0.61, r * 0.09]);
      }
      beam(resources, root, [side * r * 0.61, h * 0.18, -r * 0.43], [side * r * 0.61, h * 0.59, r * 0.38], r * 0.06, palette.bark);
      framedWindow(resources, root, side * r * 0.38, h * 0.42, r * 0.565, r * 0.22, h * 0.19);
      part(resources, root, 'box', palette.timberLight, [side * r * 0.18, h * 0.25, r * 0.585], [r * 0.065, h * 0.38, r * 0.075]);
    }
    part(resources, root, 'box', palette.bark, [0, h * 0.245, r * 0.565], [r * 0.3, h * 0.37, 0.09]);
    part(resources, root, 'box', palette.timberLight, [0, h * 0.455, r * 0.59], [r * 0.46, h * 0.055, r * 0.11]);
    for (const level of [0.16, 0.34]) {
      part(resources, root, 'box', palette.iron, [-r * 0.065, h * level, r * 0.618], [r * 0.16, h * 0.025, 0.025]);
    }
    part(resources, root, 'box', palette.timberLight, [0, h * 0.76, r * 0.65], [r * 0.065, h * 0.21, r * 0.04]);
    part(resources, root, 'box', theme.stone, [-r * 0.39, h * 0.83, -r * 0.22], [r * 0.21, h * 0.57, r * 0.24], [0, 0, 0], 'stone');
    part(resources, root, 'box', theme.stone, [-r * 0.39, h * 1.11, -r * 0.22], [r * 0.28, h * 0.055, r * 0.3], [0, 0, 0], 'stone');
    part(resources, root, 'box', palette.ink, [-r * 0.39, h * 1.139, -r * 0.22], [r * 0.14, 0.014, r * 0.16]);
    if (stoneHouse) buttresses(resources, root, r, h, theme.stone);
    if (place.kind === 'inn') {
      part(resources, root, 'box', palette.timberLight, [r * 0.46, h * 0.67, r * 0.62], [r * 0.055, r * 0.055, r * 0.39]);
      part(resources, root, 'box', theme.accent, [r * 0.46, h * 0.59, r * 0.73], [r * 0.26, h * 0.12, r * 0.045]);
      const dormer = new THREE.Group();
      dormer.position.set(r * 0.25, h * 0.78, r * 0.25);
      root.add(dormer);
      part(resources, dormer, 'box', palette.timber, [0, 0, 0], [r * 0.37, h * 0.14, r * 0.42]);
      const dormerRoof = part(resources, dormer, 'roof', theme.roof, [0, h * 0.14, 0], [r * 0.46, h * 0.16, r * 0.46], [0, 0, 0], 'roof');
      dormerRoof.name = 'dormer-roof';
      framedWindow(resources, dormer, 0, h * 0.006, r * 0.21, r * 0.14, h * 0.11);
    } else if (obstacle.variant === 0) {
      const notice = new THREE.Group();
      notice.position.set(0, h * 0.47, r * 0.27);
      root.add(notice);
      ledger(resources, notice, r * 0.45, h * 0.24);
    }
    if (place.id === 'wreckers-rest') {
      part(resources, root, 'roof', palette.bark, [0, h * 1.1, 0], [r * 0.62, h * 0.23, r * 1.22], [Math.PI, 0, 0], 'wood');
      part(resources, root, 'box', palette.timber, [0, h * 1.27, 0], [r * 0.035, h * 0.38, r * 0.035]);
      part(resources, root, 'cloth', palette.parchment, [r * 0.15, h * 1.32, 0], [r * 0.29, h * 0.17, 0.4]);
    }
  }
  return root;
}
