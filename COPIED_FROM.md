# Files copied from the engine

The inspector draws with a few engine helpers that are not part of every app's engine build, and
the browser extension cannot rely on the page's engine carrying them. They are copied here and
import engine classes from `playcanvas`, so they work on the app's own engine.

Copied from [playcanvas/engine](https://github.com/playcanvas/engine) `v2.23.0-beta.24`
(`55ce8a4a6`).

| file here | engine source |
|---|---|
| `src/renderers/wire-renderer.js` | `src/extras/renderers/wire-renderer.js` |
| `src/renderers/texture-renderer.js` | `src/extras/renderers/texture-renderer.js` |
| `src/renderers/texture-renderer-shaders.js` | `src/extras/renderers/texture-renderer-shaders.js` |
| `src/picker/picker.js` | `src/framework/graphics/picker.js` |
| `src/picker/render-pass-picker.js` | `src/framework/graphics/render-pass-picker.js` |
| `src/input/fly-controller.js` | `src/extras/input/controllers/fly-controller.js` |
| `src/input/orbit-controller.js` | `src/extras/input/controllers/orbit-controller.js` |
| `src/input/input.js` | `src/extras/input/input.js` |
| `src/input/pose.js` | `src/extras/input/pose.js` |
| `src/input/math.js` | `src/extras/input/math.js` |

Local changes, kept to a minimum so a re-sync is a copy and a diff:

- Engine imports are merged into one `import { … } from 'playcanvas'`.
- `Debug` and `DebugGraphics` come from `src/debug.js`, as the engine does not export them.
  Assertions and GPU markers are dropped, as a release engine build drops them.
- In `wire-renderer.js`, `_scene` and `_immediate` are marked `@private`. Unmarked, the generated
  declarations would publish their types, and through them the engine's unexported `LineWriter`.

On each engine release: copy the files again, reapply the changes above, run the tests, and
update the version and commit at the top of this file.
