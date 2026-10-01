# PlayCanvas Inspector

A debug panel for running [PlayCanvas](https://github.com/playcanvas/engine) apps. It shows the entity
hierarchy and every component's properties, and tabs for the cameras, assets, frame graph, render
targets, textures, meshes, materials, scripts, memory, shaders and physics of the app, with live
previews of textures and render targets, picking and flying in the view, and a debug frame mode
that steps through the draw calls of a render pass.

The inspector is read-only, apart from toggling entities on and off, pausing and stepping the app,
and view-only overrides (render modes, wireframe, a flown camera) it removes when it closes.

## Install

```sh
npm install @playcanvas/inspector
```

It requires PlayCanvas Engine 2.23 or newer. `playcanvas` is a peer dependency: the inspector works
on your app's own engine, so it must be the same `playcanvas` package your app imports.

## Use

```javascript
import { Inspector } from '@playcanvas/inspector';

const inspector = new Inspector(app, { dock: 'left', width: 480 });
```

Press <kbd>`</kbd> to show or hide the panel, <kbd>F9</kbd> to pause and <kbd>F10</kbd> to step a
frame while paused. The keys, dock side, width and more are options of the constructor.

Or, from the Editor or a scripted scene, as a script on an entity:

```javascript
import { EntityInspector } from '@playcanvas/inspector';

const entity = new Entity('inspector');
entity.addComponent('script');
entity.script.create(EntityInspector, { properties: { dock: 'left' } });
app.root.addChild(entity);
```

## Engine versions

Each inspector release names the engine versions it supports in its `playcanvas` peer dependency.
The inspector reads engine internals to show what it shows, so it is tied to engine releases
rather than claiming a wide version range.

## The devtools hook

From engine 2.23, every PlayCanvas app announces itself to a hook defined on the global object,
which is how the upcoming browser extension finds apps on any page:

```javascript
globalThis[Symbol.for('playcanvas.inspector')] = {
    register(app, { version, revision, protocol }) {},
    unregister(app) {}
};
```

The hook must be defined before the engine creates the app. `register` is called once each app is
initialized, and `unregister` when it is destroyed. `protocol` is `1`.

## Development

Node 22.19 or newer.

```sh
npm install
npm run lint
npm test
```

The tests run against the `playcanvas` version in `devDependencies`, on the engine's null graphics
device under jsdom.

A few engine helpers the inspector draws with are copied into `src/renderers`, `src/picker` and
`src/input`, so the inspector does not depend on them being in the app's engine build. See
[COPIED_FROM.md](COPIED_FROM.md).

## Releasing

Releases are published to npm from GitHub Actions when a version tag is pushed. Only repository
admins can push `v*` tags, and each publish waits for approval in the `npm` environment.

1. Update your `main` to the commit to release, with CI green.
2. Bump the version and tag it:

   ```sh
   npm version minor # or major, or patch
   ```

3. Push the commit and the tag:

   ```sh
   git push --follow-tags
   ```

4. Approve the **Publish** run in the Actions tab. It runs the lint and tests, publishes to npm
   with provenance, and creates a GitHub release with generated notes.

A tag that does not match the `package.json` version fails the run without publishing.

## License

MIT
