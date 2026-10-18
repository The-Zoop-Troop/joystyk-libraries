import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AutoQuality, PIXEL_RATIO, type Graphics, type Quality } from './quality.ts';
export type Disposable = {
  dispose(): void;
};
export type SceneContext = {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  track<T extends Disposable>(resource: T): T;
};
export type SceneDrawing<View> = {
  readonly camera: THREE.Camera;
  draw(view: View, alpha: number, quality: Quality): void;
  resize?(width: number, height: number): void;
};
export type RenderOptions<View> = {
  readonly host: HTMLElement;
  readonly build: (context: SceneContext) => SceneDrawing<View>;
  readonly pause: () => void;
  readonly announce: (message: string) => void;
  readonly development?: boolean;
  readonly now?: () => number;
};
export function roomEnvironment({ renderer, scene, track }: SceneContext): void {
  const room = new RoomEnvironment(),
    pmrem = new THREE.PMREMGenerator(renderer);
  const target = track(pmrem.fromScene(room, 0.04));
  scene.environment = target.texture;
  room.dispose();
  pmrem.dispose();
}
export function createRenderStage<View>(o: RenderOptions<View>) {
  const quality = new AutoQuality(),
    now = o.now ?? (() => performance.now());
  let renderer: THREE.WebGLRenderer | null = null,
    drawing: SceneDrawing<View> | null = null;
  let scene: THREE.Scene | null = null,
    canvas: HTMLCanvasElement | null = null;
  let resources = new Set<Disposable>(),
    events: AbortController | null = null;
  let last: {
      view: View;
      alpha: number;
      key: string;
    } | null = null,
    drawn = '',
    disposed = false,
    lost = false;
  let width = 1,
    height = 1;
  const notice = document.createElement('p'),
    retry = document.createElement('button'),
    overlay = document.createElement('output');
  retry.type = 'button';
  retry.textContent = 'Try 3D again';
  retry.hidden = true;
  overlay.hidden = !o.development;
  overlay.setAttribute('aria-label', 'Rendering performance');
  o.host.append(notice, retry, overlay);
  const release = (): void => {
    events?.abort();
    events = null;
    if (scene !== null)
      scene.traverse((object) => {
        if (object instanceof THREE.InstancedMesh) resources.add(object);
        const mesh = object as THREE.Mesh;
        if (mesh.geometry !== undefined) resources.add(mesh.geometry);
        const materials =
          mesh.material === undefined ? [] : Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          resources.add(material);
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.add(value);
        }
      });
    for (const resource of resources) resource.dispose();
    resources = new Set();
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer = null;
    drawing = null;
    scene = null;
    canvas?.remove();
    canvas = null;
  };
  const resize = (): void => {
    width = Math.max(1, o.host.clientWidth);
    height = Math.max(1, o.host.clientHeight || width * 0.7);
    if (renderer !== null) renderer.shadowMap.enabled = quality.level === 'high';
    renderer?.setPixelRatio(Math.min(devicePixelRatio || 1, PIXEL_RATIO[quality.level]));
    renderer?.setSize(width, height, false);
    drawing?.resize?.(width, height);
    drawn = '';
    redraw();
  };
  const redraw = (): void => {
    if (disposed || lost || renderer === null || drawing === null || scene === null || last === null) return;
    const key = `${last.key}:${last.alpha}:${quality.level}:${width}:${height}`;
    if (key === drawn) return;
    const started = now();
    drawing.draw(last.view, last.alpha, quality.level);
    renderer.render(scene, drawing.camera);
    if (quality.sample(now() - started, now())) {
      renderer.shadowMap.enabled = quality.level === 'high';
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, PIXEL_RATIO[quality.level]));
      renderer.setSize(width, height, false);
    }
    overlay.textContent = `p95 ${quality.p95.toFixed(1)} ms · ${renderer.info.render.calls} calls · ${renderer.info.render.triangles} triangles · ${quality.level}`;
    drawn = key;
  };
  const rebuild = (): void => {
    if (disposed) return;
    release();
    lost = false;
    drawn = '';
    try {
      canvas = document.createElement('canvas');
      const context = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'low-power' });
      if (context === null) throw new Error('WebGL 2 unavailable');
      renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      canvas.setAttribute('aria-hidden', 'true');
      canvas.classList.add('render3d-canvas');
      o.host.prepend(canvas);
      scene = new THREE.Scene();
      drawing = o.build({
        renderer,
        scene,
        track: (resource) => {
          resources.add(resource);
          return resource;
        },
      });
      events = new AbortController();
      canvas.addEventListener(
        'webglcontextlost',
        (e) => {
          e.preventDefault();
          lost = true;
          o.pause();
          notice.textContent = 'Graphics interrupted. Your game is paused.';
          retry.hidden = false;
          o.announce(notice.textContent);
        },
        { signal: events.signal },
      );
      canvas.addEventListener(
        'webglcontextrestored',
        () => {
          rebuild();
          o.announce('Graphics restored. Resume when ready.');
        },
        { signal: events.signal },
      );
      notice.textContent = '';
      retry.hidden = true;
      resize();
    } catch {
      release();
      lost = true;
      o.pause();
      notice.textContent = 'This game needs WebGL 2. Enable hardware acceleration, then try again.';
      retry.hidden = false;
    }
  };
  retry.addEventListener('click', rebuild);
  const observer = new ResizeObserver(resize);
  observer.observe(o.host);
  rebuild();
  return {
    get canvas(): HTMLCanvasElement | null {
      return canvas;
    },
    get available(): boolean {
      return renderer !== null && !lost;
    },
    get measurement() {
      return {
        p95: quality.p95,
        calls: renderer?.info.render.calls ?? 0,
        triangles: renderer?.info.render.triangles ?? 0,
        quality: quality.level,
      };
    },
    draw(view: View, alpha = 1, key = JSON.stringify(view)): void {
      last = { view, alpha, key };
      redraw();
    },
    graphics(value: Graphics): void {
      quality.set(value);
      resize();
    },
    retry: rebuild,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      release();
      retry.removeEventListener('click', rebuild);
      notice.remove();
      retry.remove();
      overlay.remove();
    },
  };
}
/** Camera-space pointer picking on a game's plane. */
export function pickPlane(
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  x: number,
  y: number,
  plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
): THREE.Vector3 | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(
    new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, 1 - ((y - rect.top) / rect.height) * 2),
    camera,
  );
  return ray.ray.intersectPlane(plane, new THREE.Vector3());
}
export function project(point: THREE.Vector3, camera: THREE.Camera): THREE.Vector3 {
  return point.clone().project(camera);
}
