import * as THREE from 'three';
import { PIXEL_RATIO, type Quality } from './quality.ts';
/** Existing game scenes share the same strict WebGL 2 renderer boundary. */
export function createRenderer(
  options: Omit<THREE.WebGLRendererParameters, 'canvas'> & {
    canvas?: HTMLCanvasElement;
  } = {},
  quality: Quality = 'medium',
): THREE.WebGLRenderer {
  const canvas = options.canvas ?? document.createElement('canvas');
  const context = canvas.getContext('webgl2', {
    antialias: options.antialias ?? true,
    alpha: options.alpha ?? false,
    powerPreference: options.powerPreference ?? 'low-power',
  });
  if (context === null) throw Error('This game needs WebGL 2. Enable hardware acceleration, then try again.');
  const renderer = new THREE.WebGLRenderer({ ...options, canvas, context: context as WebGL2RenderingContext });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, PIXEL_RATIO[quality]));
  renderer.domElement.setAttribute('aria-hidden', 'true');
  return renderer;
}
export function webgl2Available(): boolean {
  const canvas = document.createElement('canvas'),
    context = canvas.getContext('webgl2');
  if (context === null) return false;
  context.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}
/** Rebuilds all resources using the game's scene factory; it never resumes game time. */
export function bindGraphicsRecovery(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  o: {
    pause(): void;
    rebuild(): void;
    announce?: (message: string) => void;
  },
): () => void {
  const abort = new AbortController(),
    { signal } = abort;
  const notice = document.createElement('p'),
    retry = document.createElement('button');
  notice.hidden = true;
  retry.hidden = true;
  retry.className = 'retry-graphics';
  retry.type = 'button';
  retry.textContent = 'Try 3D again';
  const rebuild = (): void => {
    o.rebuild();
  };
  canvas.addEventListener(
    'webglcontextlost',
    (e) => {
      e.preventDefault();
      o.pause();
      if (signal.aborted) return;
      notice.hidden = false;
      retry.hidden = false;
      if (!retry.isConnected) host.append(notice, retry);
      notice.textContent = 'Graphics interrupted. Try 3D again to restore the scene.';
      o.announce?.(notice.textContent);
    },
    { signal },
  );
  canvas.addEventListener('webglcontextrestored', rebuild, { signal });
  retry.addEventListener(
    'click',
    (event) => {
      event.stopPropagation();
      rebuild();
    },
    { signal },
  );
  return () => {
    abort.abort();
    notice.remove();
    retry.remove();
  };
}
