// Compiled by `npm run test:types` against the declarations from `npm run build:types`, through the
// package's own name, so the `exports` map is checked too.
import { Entity } from 'playcanvas';
import type { AppBase } from 'playcanvas';

import { EntityInspector, Inspector } from '@playcanvas/inspector';
import type { InspectorOptions } from '@playcanvas/inspector';

declare const app: AppBase;

const options: InspectorOptions = {
    visible: false,
    dock: 'left',
    width: 480,
    top: 40,
    toggleKey: 'Backquote',
    pauseKey: 'F9',
    stepKey: 'F10',
    lockedNode: null,
    onVisibleChange: (visible: boolean) => console.log(visible),
    storageKey: null
};

const inspector = new Inspector(app, options);
inspector.visible = !inspector.visible;
inspector.paused = true;
inspector.step();
inspector.onVisibleChange = null;
inspector.destroy();

const entity = new Entity('inspector');
entity.addComponent('script');
const script = entity.script?.create(EntityInspector, { properties: { dock: 'right' } });
const hosted: Inspector | null = script?.inspector ?? null;
console.log(hosted);

// @ts-expect-error - only 'left' and 'right' dock
new Inspector(app, { dock: 'top' });

// @ts-expect-error - internals are not part of the types
inspector._refresh();
