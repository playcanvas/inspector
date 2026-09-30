# Agent guidelines for the PlayCanvas Inspector

A debug panel for running PlayCanvas apps, published as `@playcanvas/inspector`. It will also be
the core of a browser extension that finds PlayCanvas apps on any page.

## Rules

- **Engine classes come only from `playcanvas`.** Never import engine source by path. The package
  must work on the app's own engine instance, so `instanceof` against page objects holds, and the
  extension build points `playcanvas` at classes read from the page's live objects.
- **Only public engine exports.** If something the inspector needs is not exported, recognize it by
  shape or reach it through a live object; do not ask the engine to export it for us. The engine
  carries nothing for the inspector except the devtools hook (see README).
- **Read-only by default.** The inspector may toggle entities, pause and step the app, and apply
  view-only overrides (render modes, wireframe, a flown camera) that it removes when it closes.
  Nothing else changes the app.
- **No module side effects** (`"sideEffects": false`): no top-level calls, globals or registrations.
- **Copied engine helpers** (`src/renderers`, `src/picker`, `src/input`): keep them close to the
  engine originals and record any change in `COPIED_FROM.md`.
- **Performance:** the panel runs inside someone else's frame. Refresh lists on intervals, not every
  frame; avoid per-frame allocations in code that runs every frame.

## Code style

- JavaScript (ES2022) with JSDoc, like the engine. Run `npm run lint`.
- JSDoc on every function and class member. Explain why, not what.
- Match the style of the surrounding code.

## Tests

- Mocha + Chai under jsdom, on the engine's `NullGraphicsDevice`: `npm test`. Node 22.19 or newer.
- Write tests for new behavior. Browser-only behavior (pointer hover, real rendering) is verified in
  the engine examples browser.

## Commits and PRs

- Conventional commits: `feat:`, `fix:`, `perf:`, `docs:`, `refactor:`, `test:`.
- Small, focused commits.
