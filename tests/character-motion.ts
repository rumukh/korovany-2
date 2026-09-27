import * as THREE from 'three';

/** Motion contract checked on every 60 Hz frame of the exported skin. */
export interface MotionContract {
  fps: number;
  clips: Record<string, {
    minSeconds: number; maxSeconds: number; loop: boolean; minMotion: number; speed?: number; planted?: boolean; ground?: boolean;
    /** Transitional frames may use a looser strain limit; a held final pose (a corpse) must meet the global one. */
    maxQuantileStretch?: number; minQuantileCompression?: number; holdsFinalPose?: boolean;
  }>;
  feet: readonly [string, string];
  /** Largest horizontal distance of body vertices from the entity origin (standing clips). */
  bodyRadius: number;
  /** Largest horizontal reach of attached items (weapon tips during a strike). */
  itemRadius: number;
  minY: number;
  maxY: number;
  /** Rest-pose band that identifies rigid sole vertices. */
  contactHeight: number;
  /** A foot is planted while its sole stays within this height of its lowest point. */
  plantedHeight: number;
  maxSlideSpeed: number;
  maxMeanSlideSpeed: number;
  minSwingLift: number;
  loopTolerance: number;
  /** Absolute per-edge limits on every frame: anything beyond these is a torn or collapsed triangle. */
  maxEdgeRatio: number;
  minEdgeRatio: number;
  /**
   * Joint-region strain on every frame: at `strainQuantile` of all edges the length ratio must stay within
   * [minQuantileCompression, maxQuantileStretch]. Linear blend skinning stretches creases (armpit, knee, hem);
   * this bounds how much of the surface may do so. Clips may tighten or loosen it individually.
   */
  strainQuantile: number;
  maxQuantileStretch: number;
  minQuantileCompression: number;
  /** Edges whose two vertices are fully bound to one joint must keep their length within this fraction. */
  rigidTolerance: number;
  maxWeightError: number;
}

export interface MotionReport {
  vertices: number;
  edges: number;
  joints: number;
  soles: [number, number];
  weightError: number;
  maxInfluences: number;
  clips: ClipReport[];
  failures: string[];
}

export interface ClipReport {
  name: string;
  seconds: number;
  frames: number;
  maxDisplacement: number;
  loopError: number | null;
  rootDrift: number;
  minY: number;
  maxY: number;
  bodyRadius: number;
  itemRadius: number;
  maxEdgeRatio: number;
  minEdgeRatio: number;
  /** Worst per-frame edge ratio at the contract quantile (stretch) and its mirror (compression). */
  quantileStretch: number;
  quantileCompression: number;
  /** Largest length change of an edge rigidly bound to one joint, and that joint. */
  rigidError: number;
  rigidJoint: string | null;
  /** Largest deviation of any joint's world scale from 1, and that joint. */
  jointScaleError: number;
  scaledJoint: string | null;
  /** Strain at the contract quantile on the last frame (the pose a corpse holds). */
  finalQuantileStretch: number;
  finalQuantileCompression: number;
  /** Dominant joints at both ends of the most stretched edge, for diagnosis. */
  worstEdge: { frame: number; ratio: number; joints: [string, string] } | null;
  contact: { fraction: number; maxSlide: number; meanSlide: number; lift: number }[];
}

interface Rig {
  root: THREE.Object3D;
  body: THREE.SkinnedMesh;
  items: THREE.Mesh[];
  rootBone: THREE.Bone;
}

function rig(root: THREE.Object3D): Rig {
  let body: THREE.SkinnedMesh | undefined;
  const items: THREE.Mesh[] = [];
  root.traverse(object => {
    if (object instanceof THREE.SkinnedMesh) {
      if (body) throw new Error('Expected exactly one skinned body');
      body = object;
    } else if (object instanceof THREE.Mesh) items.push(object);
  });
  if (!body) throw new Error('No skinned body');
  const rootBone = body.skeleton.bones.find(bone => !(bone.parent instanceof THREE.Bone));
  if (!rootBone) throw new Error('Skeleton has no root joint');
  return { root, body, items, rootBone };
}

function skinnedPositions(body: THREE.SkinnedMesh, out: Float32Array): void {
  body.skeleton.update();
  const position = body.geometry.getAttribute('position');
  const vertex = new THREE.Vector3();
  for (let index = 0; index < position.count; index++) {
    vertex.fromBufferAttribute(position, index);
    body.applyBoneTransform(index, vertex);
    vertex.applyMatrix4(body.matrixWorld);
    out[index * 3] = vertex.x;
    out[index * 3 + 1] = vertex.y;
    out[index * 3 + 2] = vertex.z;
  }
}

function edgesOf(geometry: THREE.BufferGeometry, rest: Float32Array, rigidJoint: (vertex: number) => number):
  { a: Uint32Array; b: Uint32Array; length: Float32Array; rigid: Int32Array } {
  const index = geometry.getIndex();
  if (!index) throw new Error('Skinned body must be indexed');
  const seen = new Set<number>();
  const a: number[] = [], b: number[] = [], length: number[] = [], rigid: number[] = [];
  const count = geometry.getAttribute('position').count;
  for (let at = 0; at < index.count; at += 3) {
    for (const [p, q] of [[index.getX(at), index.getX(at + 1)], [index.getX(at + 1), index.getX(at + 2)], [index.getX(at + 2), index.getX(at)]] as const) {
      const low = Math.min(p, q), high = Math.max(p, q);
      const key = low * count + high;
      if (seen.has(key)) continue;
      seen.add(key);
      const d = Math.hypot(rest[low * 3]! - rest[high * 3]!, rest[low * 3 + 1]! - rest[high * 3 + 1]!, rest[low * 3 + 2]! - rest[high * 3 + 2]!);
      if (d < 0.004) continue;
      a.push(low); b.push(high); length.push(d);
      const joint = rigidJoint(low);
      rigid.push(joint >= 0 && joint === rigidJoint(high) ? joint : -1);
    }
  }
  return { a: Uint32Array.from(a), b: Uint32Array.from(b), length: Float32Array.from(length), rigid: Int32Array.from(rigid) };
}

/** Sample every frame of every clip on the actual skinned vertices; broken assets must fail. */
export function verifyMotion(scene: THREE.Object3D, clips: readonly THREE.AnimationClip[], contract: MotionContract): MotionReport {
  const failures: string[] = [];
  const { body, items, rootBone } = rig(scene);
  scene.updateMatrixWorld(true);
  const geometry = body.geometry;
  const count = geometry.getAttribute('position').count;
  const weights = geometry.getAttribute('skinWeight');
  const joints = geometry.getAttribute('skinIndex');
  let weightError = 0, maxInfluences = 0;
  for (let index = 0; index < count; index++) {
    let sum = 0, used = 0;
    for (let k = 0; k < 4; k++) {
      const value = weights.getComponent(index, k);
      sum += value;
      if (value > 1e-4) used++;
    }
    weightError = Math.max(weightError, Math.abs(sum - 1));
    maxInfluences = Math.max(maxInfluences, used);
  }
  if (weightError > contract.maxWeightError) failures.push(`skin weights are not normalized (max error ${weightError.toFixed(4)})`);
  const rest = new Float32Array(count * 3);
  skinnedPositions(body, rest);
  const rigidJoint = (vertex: number): number => {
    for (let k = 0; k < 4; k++) if (weights.getComponent(vertex, k) >= 0.999) return joints.getComponent(vertex, k);
    return -1;
  };
  const edges = edgesOf(geometry, rest, rigidJoint);
  const ratios = new Float32Array(edges.a.length);
  let restMinY = Infinity;
  for (let index = 0; index < count; index++) restMinY = Math.min(restMinY, rest[index * 3 + 1]!);
  const bones = body.skeleton.bones;
  const soles: number[][] = [[], []];
  contract.feet.forEach((name, side) => {
    const jointIndex = bones.findIndex(bone => bone.name === name);
    if (jointIndex < 0) failures.push(`missing foot joint ${name}`);
    for (let index = 0; index < count; index++) {
      if (rest[index * 3 + 1]! > restMinY + contract.contactHeight) continue;
      let weight = 0;
      for (let k = 0; k < 4; k++) if (joints.getComponent(index, k) === jointIndex) weight += weights.getComponent(index, k);
      if (weight > 0.98) soles[side]!.push(index);
    }
    if (soles[side]!.length < 6) failures.push(`foot ${name} has ${soles[side]!.length} rigid sole vertices`);
  });
  const reports: ClipReport[] = [];
  const current = new Float32Array(count * 3);
  const first = new Float32Array(count * 3);
  const itemPoint = new THREE.Vector3();
  const jointPosition = new THREE.Vector3(), jointScale = new THREE.Vector3(), jointRotation = new THREE.Quaternion();
  for (const [name, expected] of Object.entries(contract.clips)) {
    const clip = clips.find(candidate => candidate.name === name);
    if (!clip) {
      failures.push(`missing clip ${name}`);
      continue;
    }
    if (clip.duration < expected.minSeconds - 1e-3 || clip.duration > expected.maxSeconds + 1e-3) {
      failures.push(`${name} lasts ${clip.duration.toFixed(3)} s, outside ${expected.minSeconds}-${expected.maxSeconds} s`);
    }
    const mixer = new THREE.AnimationMixer(scene);
    const action = mixer.clipAction(clip);
    action.play();
    const frames = Math.max(1, Math.round(clip.duration * contract.fps));
    const report: ClipReport = {
      name, seconds: clip.duration, frames, maxDisplacement: 0, loopError: null, rootDrift: 0,
      minY: Infinity, maxY: -Infinity, bodyRadius: 0, itemRadius: 0, maxEdgeRatio: 0, minEdgeRatio: Infinity,
      quantileStretch: 0, quantileCompression: Infinity, rigidError: 0, rigidJoint: null, jointScaleError: 0, scaledJoint: null,
      finalQuantileStretch: 0, finalQuantileCompression: Infinity, worstEdge: null, contact: [],
    };
    const dominant = (vertex: number): string => {
      let best = 0, bestWeight = -1;
      for (let k = 0; k < 4; k++) {
        if (weights.getComponent(vertex, k) > bestWeight) {
          bestWeight = weights.getComponent(vertex, k);
          best = joints.getComponent(vertex, k);
        }
      }
      return bones[best]?.name ?? String(best);
    };
    const rootStart = new THREE.Vector3();
    const soleTracks: { x: number; y: number; z: number }[][] = [[], []];
    for (let frame = 0; frame <= frames; frame++) {
      mixer.setTime(Math.min(clip.duration, frame / contract.fps));
      scene.updateMatrixWorld(true);
      skinnedPositions(body, current);
      if (frame === 0) {
        first.set(current);
        rootBone.getWorldPosition(rootStart);
      }
      const rootNow = rootBone.getWorldPosition(new THREE.Vector3());
      report.rootDrift = Math.max(report.rootDrift, rootNow.distanceTo(rootStart), Math.hypot(rootNow.x, rootNow.z));
      for (let index = 0; index < count; index++) {
        const x = current[index * 3]!, y = current[index * 3 + 1]!, z = current[index * 3 + 2]!;
        report.maxDisplacement = Math.max(report.maxDisplacement,
          Math.hypot(x - rest[index * 3]!, y - rest[index * 3 + 1]!, z - rest[index * 3 + 2]!));
        report.minY = Math.min(report.minY, y);
        report.maxY = Math.max(report.maxY, y);
        report.bodyRadius = Math.max(report.bodyRadius, Math.hypot(x, z));
      }
      for (let edge = 0; edge < edges.a.length; edge++) {
        const p = edges.a[edge]!, q = edges.b[edge]!;
        const ratio = Math.hypot(current[p * 3]! - current[q * 3]!, current[p * 3 + 1]! - current[q * 3 + 1]!,
          current[p * 3 + 2]! - current[q * 3 + 2]!) / edges.length[edge]!;
        ratios[edge] = ratio;
        if (ratio > report.maxEdgeRatio) {
          report.maxEdgeRatio = ratio;
          report.worstEdge = { frame, ratio, joints: [dominant(p), dominant(q)] };
        }
        if (ratio < report.minEdgeRatio) report.minEdgeRatio = ratio;
        const rigid = edges.rigid[edge]!;
        if (rigid >= 0 && Math.abs(ratio - 1) > report.rigidError) {
          report.rigidError = Math.abs(ratio - 1);
          report.rigidJoint = bones[rigid]?.name ?? String(rigid);
        }
      }
      const sorted = Float32Array.from(ratios).sort();
      const tail = Math.min(sorted.length - 1, Math.floor(sorted.length * contract.strainQuantile));
      report.quantileStretch = Math.max(report.quantileStretch, sorted[tail]!);
      report.quantileCompression = Math.min(report.quantileCompression, sorted[sorted.length - 1 - tail]!);
      if (frame === frames) {
        report.finalQuantileStretch = sorted[tail]!;
        report.finalQuantileCompression = sorted[sorted.length - 1 - tail]!;
      }
      for (const bone of bones) {
        bone.matrixWorld.decompose(jointPosition, jointRotation, jointScale);
        const error = Math.max(Math.abs(jointScale.x - 1), Math.abs(jointScale.y - 1), Math.abs(jointScale.z - 1));
        if (error > report.jointScaleError) {
          report.jointScaleError = error;
          report.scaledJoint = bone.name;
        }
      }
      for (const item of items) {
        const position = item.geometry.getAttribute('position');
        for (let index = 0; index < position.count; index++) {
          itemPoint.fromBufferAttribute(position, index).applyMatrix4(item.matrixWorld);
          report.itemRadius = Math.max(report.itemRadius, Math.hypot(itemPoint.x, itemPoint.z));
          report.minY = Math.min(report.minY, itemPoint.y);
        }
      }
      soles.forEach((vertices, side) => {
        let x = 0, z = 0, y = Infinity;
        for (const index of vertices) {
          x += current[index * 3]!;
          z += current[index * 3 + 2]!;
          y = Math.min(y, current[index * 3 + 1]!);
        }
        soleTracks[side]!.push({ x: x / Math.max(1, vertices.length), y, z: z / Math.max(1, vertices.length) });
      });
    }
    if (expected.loop) {
      let error = 0;
      for (let index = 0; index < count * 3; index++) error = Math.max(error, Math.abs(current[index]! - first[index]!));
      report.loopError = error;
      if (error > contract.loopTolerance) failures.push(`${name} does not close its loop (${(error * 1000).toFixed(1)} mm)`);
    }
    const speed = expected.speed ?? 0;
    for (const track of soleTracks) {
      let contacts = 0, slides = 0, maxSlide = 0, lift = 0;
      const ground = Math.min(...track.map(sample => sample.y));
      for (let frame = 1; frame < track.length; frame++) {
        const a = track[frame - 1]!, b = track[frame]!;
        lift = Math.max(lift, b.y - ground);
        if (a.y - ground > contract.plantedHeight || b.y - ground > contract.plantedHeight) continue;
        contacts++;
        // A planted foot is fixed in the world, so in the entity frame it moves backwards at ground speed.
        const slide = Math.hypot((b.x - a.x) * contract.fps, (b.z - a.z) * contract.fps + speed);
        maxSlide = Math.max(maxSlide, slide);
        slides += slide;
      }
      report.contact.push({ fraction: contacts / Math.max(1, track.length - 1), maxSlide, meanSlide: slides / Math.max(1, contacts), lift });
    }
    if (report.maxDisplacement < expected.minMotion) {
      failures.push(`${name} barely deforms (${(report.maxDisplacement * 1000).toFixed(1)} mm < ${expected.minMotion * 1000} mm)`);
    }
    if (report.rootDrift > 0.002) failures.push(`${name} moves its root joint by ${(report.rootDrift * 1000).toFixed(1)} mm`);
    if (report.minY < contract.minY) failures.push(`${name} goes below the ground (${report.minY.toFixed(3)} m)`);
    if (report.maxY > contract.maxY) failures.push(`${name} rises above its envelope (${report.maxY.toFixed(3)} m)`);
    if (expected.ground !== false && report.bodyRadius > contract.bodyRadius) {
      failures.push(`${name} body leaves its ${contract.bodyRadius} m envelope (${report.bodyRadius.toFixed(3)} m)`);
    }
    if (report.itemRadius > contract.itemRadius) failures.push(`${name} items reach ${report.itemRadius.toFixed(2)} m`);
    if (report.maxEdgeRatio > contract.maxEdgeRatio) failures.push(`${name} stretches an edge ${report.maxEdgeRatio.toFixed(2)}x`);
    if (report.minEdgeRatio < contract.minEdgeRatio) failures.push(`${name} crushes an edge to ${report.minEdgeRatio.toFixed(2)}x`);
    const stretchLimit = expected.maxQuantileStretch ?? contract.maxQuantileStretch;
    const compressionLimit = expected.minQuantileCompression ?? contract.minQuantileCompression;
    const percent = (contract.strainQuantile * 100).toFixed(1);
    if (report.quantileStretch > stretchLimit) {
      failures.push(`${name} stretches an edge beyond ${stretchLimit}x at the ${percent}th percentile (${report.quantileStretch.toFixed(2)}x)`);
    }
    if (report.quantileCompression < compressionLimit) {
      failures.push(`${name} crushes edges below ${compressionLimit}x at the ${percent}th percentile (${report.quantileCompression.toFixed(2)}x)`);
    }
    if (report.rigidError > contract.rigidTolerance) {
      failures.push(`${name} stretches an edge rigidly bound to ${report.rigidJoint} by ${(report.rigidError * 100).toFixed(1)}%`);
    }
    if (report.jointScaleError > contract.rigidTolerance) {
      failures.push(`${name} stretches an edge by scaling joint ${report.scaledJoint} ${(report.jointScaleError * 100).toFixed(1)}%`);
    }
    if (expected.holdsFinalPose && (report.finalQuantileStretch > contract.maxQuantileStretch
      || report.finalQuantileCompression < contract.minQuantileCompression)) {
      failures.push(`${name} holds a final pose outside the strain limits (${report.finalQuantileCompression.toFixed(2)}-${report.finalQuantileStretch.toFixed(2)}x at the ${percent}th percentile)`);
    }
    if (expected.planted || expected.speed) {
      report.contact.forEach((contact, side) => {
        if (contact.maxSlide > contract.maxSlideSpeed || contact.meanSlide > contract.maxMeanSlideSpeed) {
          failures.push(`${name} slides ${contract.feet[side]} (max ${contact.maxSlide.toFixed(2)} m/s, mean ${contact.meanSlide.toFixed(2)} m/s)`);
        }
      });
    }
    if (expected.speed) {
      report.contact.forEach((contact, side) => {
        if (contact.fraction < 0.2 || contact.fraction > 0.75) failures.push(`${name} ${contract.feet[side]} contact fraction ${contact.fraction.toFixed(2)}`);
        if (contact.lift < contract.minSwingLift) failures.push(`${name} ${contract.feet[side]} lifts only ${(contact.lift * 1000).toFixed(0)} mm`);
      });
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(scene);
    reports.push(report);
  }
  scene.updateMatrixWorld(true);
  return { vertices: count, edges: edges.a.length, joints: bones.length, soles: [soles[0]!.length, soles[1]!.length],
    weightError, maxInfluences, clips: reports, failures };
}

/** Deliberately broken copies of an asset; each must fail verification. */
export function brokenVariants(clips: readonly THREE.AnimationClip[], rootBone: string, stretchBone: string, runClip = 'Run'):
  Record<string, { clips: THREE.AnimationClip[]; mutateWeights?: boolean }> {
  const copy = () => clips.map(clip => clip.clone());
  const withClip = (name: string, change: (clip: THREE.AnimationClip) => THREE.AnimationClip) =>
    copy().map(clip => clip.name === name ? change(clip) : clip);
  return {
    static: { clips: copy().map(clip => new THREE.AnimationClip(clip.name, clip.duration, [])) },
    rootMotion: { clips: withClip(runClip, clip => {
      const track = new THREE.VectorKeyframeTrack(`${rootBone}.position`, [0, clip.duration], [0, 0, 0, 0, 0, 3.5 * clip.duration]);
      return new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks.filter(t => t.name !== track.name), track]);
    }) },
    sliding: { clips: withClip(runClip, clip => {
      const slowed = clip.clone();
      for (const track of slowed.tracks) track.scale(1 / 0.75);
      slowed.duration = clip.duration / 0.75;
      return slowed;
    }) },
    openLoop: { clips: withClip('Idle', clip => {
      const cut = clip.clone();
      for (const track of cut.tracks) track.trim(0, clip.duration * 0.55);
      cut.duration = clip.duration * 0.55;
      return cut;
    }) },
    stretched: { clips: withClip('Windup', clip => {
      const track = new THREE.VectorKeyframeTrack(`${stretchBone}.scale`, [0, clip.duration], [1, 1, 1, 1, 1.9, 1]);
      return new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks.filter(t => t.name !== track.name), track]);
    }) },
    unnormalizedWeights: { clips: copy(), mutateWeights: true },
  };
}
