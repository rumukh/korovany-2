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

/** The compressed formats and rasterizer of a WebGL 2 context. */
export function contextTextureSupport(gl: WebGL2RenderingContext): TextureSupport {
  const supported = new Set<string>(COMPRESSED_TEXTURE_EXTENSIONS.filter(name => gl.getExtension(name) !== null));
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  return { has: name => supported.has(name), software: SOFTWARE_RENDERER.test(renderer) };
}

/**
 * Support read from a short-lived WebGL 2 context like the game renderer's, for pages that load models without the
 * game's renderer. Creating a context waits for the GPU process, which can stall a page whose GPU work queues behind
 * another tab's, so the game reads its own renderer instead (`useRendererTextureSupport`).
 */
export function probeTextureSupport(): TextureSupport {
  const gl = document.createElement('canvas').getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL 2 is not available in this browser.');
  try {
    return contextTextureSupport(gl);
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

let rendererSupport: (() => TextureSupport) | undefined;

/**
 * Lets the transcoder read the GPU's formats from the game's renderer (`createRenderer`) instead of a probe context,
 * and starts its workers, so they are ready before the first GPU-compressed map arrives.
 */
export function useRendererTextureSupport(renderer: THREE.WebGLRenderer): void {
  rendererSupport = () => contextTextureSupport(renderer.getContext() as WebGL2RenderingContext);
  shared?.startWorkers();
}

/** Transcoder workers: on a four-core machine two were as fast as four, with half the start-up competing with loading. */
const WORKERS = 2;

/** A KTX2Loader that reads GPU support when first needed, so model libraries can be built before the renderer. */
class GameKTX2Loader extends KTX2Loader {
  private supportRead = false;
  private spares: Worker[] = [];
  private disposed = false;

  constructor(private readonly support: () => TextureSupport) {
    super(new THREE.LoadingManager());
    // KTX2Loader fetches fixed file names under its transcoder path; the build serves them as hashed assets.
    this.manager.setURLModifier(url => url === 'basis_transcoder.js' ? transcoderScriptUrl
      : url === 'basis_transcoder.wasm' ? transcoderBinaryUrl : url);
    this.setTranscoderPath('').setWorkerLimit(WORKERS);
  }

  private readSupport(): void {
    if (this.supportRead) return;
    this.detectSupport({ extensions: transcodeTargets(this.support()) } as unknown as THREE.WebGLRenderer);
    this.supportRead = true;
  }

  /**
   * Creates the workers ahead of the first texture. A fresh worker compiles the transcoder before it can transcode,
   * which delayed the landmarks' first maps by about a quarter of a second on a busy four-core machine.
   */
  startWorkers(): void {
    if (this.supportRead) return;
    this.readSupport();
    this.init().then(() => {
      if (this.disposed) return;
      // KTX2Loader's own worker creator, which hands each worker the transcoder and the GPU's formats.
      const create = this.workerPool.workerCreator.bind(this.workerPool);
      while (this.spares.length < WORKERS) this.spares.push(create());
      this.workerPool.setWorkerCreator(() => this.spares.shift() ?? create());
    }, () => undefined);
  }

  override load(url: string, onLoad: (texture: THREE.CompressedTexture) => void, onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void): void {
    this.readSupport();
    super.load(url, onLoad, onProgress, onError);
  }

  override dispose(): this {
    this.disposed = true;
    super.dispose();
    for (const worker of this.spares) worker.terminate();
    this.spares = [];
    return this;
  }
}

let shared: GameKTX2Loader | undefined;

/**
 * The page's one KTX2 (Basis Universal) transcoder for cooked models and world assets. Transcoding runs in its worker
 * pool. In a browser it fetches the transcoder at once, ahead of the model and world downloads that would otherwise
 * queue in front of it. GPU support comes from the game's renderer when it has registered (it exists before the first
 * texture arrives), otherwise from a probe context. A texture or transcoder that cannot be fetched or transcoded fails
 * its model's load (that load awaits the same fetch); there is no fallback.
 */
export function textureTranscoder(support: () => TextureSupport = () => rendererSupport?.() ?? probeTextureSupport()): KTX2Loader {
  if (!shared) {
    shared = new GameKTX2Loader(support);
    if (typeof document !== 'undefined') {
      shared.init().catch(() => undefined);
      if (rendererSupport) shared.startWorkers();
    }
  }
  return shared;
}

/** Terminates the transcoder's workers (page teardown). */
export function disposeTextureTranscoder(): void {
  shared?.dispose();
  shared = undefined;
  rendererSupport = undefined;
}