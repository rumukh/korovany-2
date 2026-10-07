import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import transcoderScriptUrl from 'three/addons/libs/basis/basis_transcoder.js?url';
import transcoderBinaryUrl from 'three/addons/libs/basis/basis_transcoder.wasm?url';

/** The WebGL compressed-texture extensions three.js's KTX2Loader can transcode Basis Universal textures to. */
export const COMPRESSED_TEXTURE_EXTENSIONS = [
  'WEBGL_compressed_texture_astc', 'EXT_texture_compression_bptc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1',
  'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_pvrtc', 'WEBKIT_WEBGL_compressed_texture_pvrtc',
] as const;

export interface TextureSupport {
  has(name: string): boolean;
  /** A software rasterizer (SwiftShader, llvmpipe, WARP), which emulates compressed formats by decoding them on first use. */
  readonly software?: boolean;
}

/**
 * The formats the transcoder may target. BC7 is preferred to ASTC where a GPU offers both: from UASTC both are near
 * lossless at one byte per texel, and ASTC is slower to decode where it is emulated. Otherwise three.js's order applies
 * (ASTC, BC7, ETC2, ETC1, S3TC, PVRTC, then uncompressed RGBA8). A software rasterizer gets uncompressed RGBA8: it keeps
 * textures in system memory either way and pays for decoding a compressed one when it is first drawn (BC7 on SwiftShader
 * cost the landmarks' first frame about 0.4 s more than RGBA8), while the precomputed mip levels still spare it the
 * mipmap generation a WebP upload needs.
 */
export function transcodeTargets(support: TextureSupport): TextureSupport {
  if (support.software) return { has: () => false };
  const bc7 = support.has('EXT_texture_compression_bptc');
  return { has: name => !(bc7 && name === 'WEBGL_compressed_texture_astc') && support.has(name) };
}

/** Renderer strings of software rasterizers: SwiftShader (Chrome), llvmpipe and softpipe (Mesa), WARP (Windows). */
const SOFTWARE_RENDERER = /SwiftShader|llvmpipe|softpipe|Basic Render Driver/i;

/** Compressed-texture support of this browser's WebGL 2, read from a short-lived context like the game renderer's. */
export function probeTextureSupport(): TextureSupport {
  const gl = document.createElement('canvas').getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL 2 is not available in this browser.');
  const supported = new Set<string>(COMPRESSED_TEXTURE_EXTENSIONS.filter(name => gl.getExtension(name) !== null));
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { has: name => supported.has(name), software: SOFTWARE_RENDERER.test(renderer) };
}

/** A KTX2Loader that reads GPU support on its first texture, so model libraries can be built before the renderer. */
class GameKTX2Loader extends KTX2Loader {
  private supportRead = false;

  constructor(private readonly support: () => TextureSupport) {
    const manager = new THREE.LoadingManager();
    // KTX2Loader fetches fixed file names under its transcoder path; the build serves them as hashed assets.
    manager.setURLModifier(url => url === 'basis_transcoder.js' ? transcoderScriptUrl
      : url === 'basis_transcoder.wasm' ? transcoderBinaryUrl : url);
    super(manager);
    this.setTranscoderPath('');
  }

  override load(url: string, onLoad: (texture: THREE.CompressedTexture) => void, onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void): void {
    if (!this.supportRead) {
      this.detectSupport({ extensions: transcodeTargets(this.support()) } as unknown as THREE.WebGLRenderer);
      this.supportRead = true;
    }
    super.load(url, onLoad, onProgress, onError);
  }
}

let shared: GameKTX2Loader | undefined;

/**
 * The page's one KTX2 (Basis Universal) transcoder for cooked models and world assets. Transcoding runs in its worker
 * pool. A texture or transcoder that cannot be fetched or transcoded fails its model's load; there is no fallback.
 */
export function textureTranscoder(support: () => TextureSupport = probeTextureSupport): KTX2Loader {
  shared ??= new GameKTX2Loader(support);
  return shared;
}

/** Terminates the transcoder's workers (page teardown). */
export function disposeTextureTranscoder(): void {
  shared?.dispose();
  shared = undefined;
}
