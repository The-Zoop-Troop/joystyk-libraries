# @joystyk/render3d

Three.js lifecycle helpers, imported only from a game's `render/` layer.

`createRenderStage({ host, build, pause, announce })` creates a strict WebGL 2 surface. The
`build` callback receives a renderer, scene and `track(resource)` disposal helper, and returns
`{ camera, draw(view, alpha, quality), resize? }`. Feed snapshots through `stage.draw`;
identical view/alpha keys are skipped. The host's CSS sizes `.render3d-canvas` to its viewport.
`stage.dispose()` releases the observer, listeners, geometries, materials, textures and context.

A lost context calls `pause`, blocks drawing and offers **Try 3D again**. Restoring or retrying
runs `build` again, so GPU resources are recreated. It never resumes the simulation.
`stage.graphics('auto' | 'low' | 'medium' | 'high')` selects adaptive or pinned quality.
Auto starts at medium and steps down after three seconds with render-time p95 over 16 ms;
it never steps up during a run. Pixel-ratio caps are 1, 1.5 and 2. The `development` option
shows p95, draw calls and triangles. Quality never changes the simulation.

`roomEnvironment`, `pickPlane` and `project` support game scenes. Existing scene classes can
use `createRenderer`, `webgl2Available` and `bindGraphicsRecovery` to share the same WebGL 2
boundary and full resource rebuild while retaining their own drawing APIs.

See host policy (Joystyk host reference) for reference-phone budgets. Desktop software
WebGL tests do not replace measurements on the reference phone.
