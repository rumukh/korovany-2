import { palette } from './palette';

export const surfaceNames = ['ground', 'stone', 'wood', 'roof', 'bark', 'cloth', 'rock'] as const;
export type Surface = typeof surfaceNames[number];

export function surfaceForColor(color: string): Surface | undefined {
  if (color === palette.timber || color === palette.timberLight) return 'wood';
  if (color === palette.bark) return 'bark';
  if (color === palette.stone || color === palette.stoneLight) return 'stone';
  if (color === palette.slate || color === palette.slateLight) return 'roof';
  return undefined;
}

export function surfaceUrl(surface: Surface, map: 'color' | 'normal' | 'roughness'): string {
  return `${import.meta.env.BASE_URL}textures/frontier/${surface}-${map}.webp`;
}
