import * as THREE from 'three';
import { brokenVariants, type MotionContract } from './character-motion';

/**
 * The cooked residents' presentation contract, checked on every 60 Hz frame of the shipped skin. Residents never
 * travel: both clips are planted loops, Idle a quiet standing loop and Talk the conversation loop with gestures.
 */
export function residentMotion(height: number): MotionContract {
  return {
    fps: 60, feet: ['foot_l', 'foot_r'], bodyRadius: 1.0, itemRadius: 0.01, minY: -0.03, maxY: height + 0.4,
    contactHeight: 0.025, plantedHeight: 0.012, maxSlideSpeed: 0.3, maxMeanSlideSpeed: 0.1, minSwingLift: 0.08, loopTolerance: 0.003,
    maxEdgeRatio: 8, minEdgeRatio: 0.02, strainQuantile: 0.995, maxQuantileStretch: 2.0, minQuantileCompression: 0.5,
    rigidTolerance: 0.01, maxWeightError: 0.002,
    clips: {
      Idle: { minSeconds: 4, maxSeconds: 6, loop: true, minMotion: 0.004, planted: true },
      Talk: { minSeconds: 4, maxSeconds: 8, loop: true, minMotion: 0.08, planted: true },
    },
  };
}

/**
 * Deliberately broken copies of a resident's clips that the verifier must reject: no motion, root drift in Talk,
 * both planted feet dragged across the ground through Talk (the pelvis drifts sideways with the legs while the root
 * stays still), a cut Idle loop, a forearm stretched by scale and unnormalized skin weights.
 */
export function residentBrokenVariants(clips: readonly THREE.AnimationClip[]):
  Record<string, { clips: THREE.AnimationClip[]; mutateWeights?: boolean }> {
  const variants = brokenVariants(clips, 'root', 'forearm_r', 'Talk', 'Talk');
  variants.sliding = { clips: clips.map(clip => {
    const copy = clip.clone();
    if (copy.name !== 'Talk') return copy;
    const track = copy.tracks.find(candidate => candidate.name === 'pelvis.position');
    if (!track) throw new Error('Talk has no pelvis translation track');
    for (let index = 0; index < track.times.length; index++) track.values[index * 3]! += 0.9 * track.times[index]! / copy.duration;
    return copy;
  }) };
  return variants;
}
