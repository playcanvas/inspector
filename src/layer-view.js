import {
    SORTMODE_BACK2FRONT, SORTMODE_CUSTOM, SORTMODE_FRONT2BACK, SORTMODE_MANUAL, SORTMODE_MATERIALMESH, SORTMODE_NONE
} from 'playcanvas';

import { describeValue } from './describe.js';
import { nodeLabel } from './memory-view.js';
import { makeSection, push, read } from './model.js';

/** @import { AppBase, Layer, LayerComposition } from 'playcanvas' */
/** @import { ListRow } from './list-view.js' */
/** @import { PropertySection } from './model.js' */

/**
 * What the Layers tab offers on a layer, supplied by the inspector.
 *
 * @typedef {object} LayerActions
 * @property {(layer: Layer, hidden: boolean) => void} hide - Hides the layer from the view, or shows
 * it again.
 * @property {(layer: Layer) => boolean} hidden - Whether the inspector hides the layer.
 * @ignore
 */

const SORT_MODES = new Map([
    [SORTMODE_NONE, 'none'],
    [SORTMODE_MANUAL, 'manual (draw order)'],
    [SORTMODE_MATERIALMESH, 'material, mesh'],
    [SORTMODE_BACK2FRONT, 'back to front'],
    [SORTMODE_FRONT2BACK, 'front to back'],
    [SORTMODE_CUSTOM, 'custom']
]);

/**
 * @param {number} mode - A sort mode.
 * @returns {string} Its name.
 */
function sortModeName(mode) {
    return SORT_MODES.get(mode) ?? String(mode);
}

/**
 * One entry of the composition: a layer's opaque or transparent half, which the composition orders
 * on its own, so a layer's halves can render far apart.
 *
 * @typedef {object} SubLayer
 * @property {Layer} layer - The layer.
 * @property {boolean} transparent - Whether it is the transparent half.
 * @property {boolean} enabled - Whether the composition renders it: the layer and the half enabled.
 * @property {number} index - Its place in the composition.
 * @ignore
 */

/**
 * The entries of the composition, in the order it renders them.
 *
 * @param {LayerComposition|null|undefined} composition - The scene's composition.
 * @returns {SubLayer[]} The entries.
 */
function collectSubLayers(composition) {
    if (!composition) return [];
    return composition.layerList.map((layer, index) => {
        const transparent = !!composition.subLayerList[index];
        return { layer, transparent, enabled: layer.enabled && !!composition.subLayerEnabled[index], index };
    });
}

/**
 * @param {Layer} layer - A layer.
 * @param {boolean} transparent - Whether to count the transparent half.
 * @returns {number} How many of its mesh instances that half draws.
 */
function instanceCount(layer, transparent) {
    let count = 0;
    for (const instance of layer.meshInstances) {
        if (!!instance.transparent === transparent) count++;
    }
    return count;
}

/**
 * The mesh instances of a half of a layer the last frame drew for a camera, after culling, as the
 * renderer left them. Read without {@link Layer#getCulledInstances}, which would add an entry for a
 * camera that never rendered the layer.
 *
 * @param {Layer} layer - A layer.
 * @param {import('playcanvas').CameraComponent} camera - A camera rendering it. The layer keeps its
 * culled instances by the component's engine camera.
 * @param {boolean} transparent - Which half.
 * @returns {number|null} The count, or null when the layer kept none for the camera.
 */
function visibleCount(layer, camera, transparent) {
    const culled = /** @type {any} */ (layer)._visibleInstances?.get(camera.camera);
    if (!culled) return null;
    return (transparent ? culled.transparent : culled.opaque)?.length ?? 0;
}

/**
 * @param {Layer} layer - A layer.
 * @returns {import('playcanvas').Light[]} The lights lighting it.
 */
function layerLights(layer) {
    return /** @type {any} */ (layer)._lights ?? [];
}

/**
 * Makes labels unique within a section, as the rows of a section are keyed by their label, and two
 * cameras or lights can share a name.
 *
 * @returns {(label: string) => string} Gives a label, numbered from its second use.
 */
function uniqueLabels() {
    const used = new Map();
    return (label) => {
        const n = (used.get(label) ?? 0) + 1;
        used.set(label, n);
        return n === 1 ? label : `${label} (${n})`;
    };
}

/**
 * One row per entry of the composition, in render order, dimmed when it does not render.
 *
 * @param {AppBase} app - The app.
 * @param {(layer: Layer) => boolean} [hidden] - Whether the inspector hides a layer.
 * @returns {ListRow[]} The rows.
 */
function layerRows(app, hidden = () => false) {
    return collectSubLayers(app.scene?.layers).map(({ layer, transparent, enabled, index }) => {
        const half = transparent ? 'transparent' : 'opaque';
        const cells = [
            { text: String(index), cls: 'pci-cell-index' },
            { text: layer.name, cls: 'pci-cell-name' },
            { text: half, cls: `pci-cell-tag${transparent ? '' : ' pci-cell-tag-info'}` }
        ];
        if (hidden(layer)) cells.push({ text: 'hidden', cls: 'pci-cell-tag' });
        else if (!layer.enabled) cells.push({ text: 'off', cls: 'pci-cell-tag' });
        else if (!enabled) cells.push({ text: `${half} off`, cls: 'pci-cell-tag' });
        const cameras = layer.cameras.length;
        const instances = instanceCount(layer, transparent);
        const splats = /** @type {any} */ (layer).gsplatPlacements?.length ?? 0;
        const info = [`id ${layer.id}`, `${instances} instances`];
        if (splats) info.push(`${splats} splats`);
        info.push(`${cameras} ${cameras === 1 ? 'camera' : 'cameras'}`);
        cells.push({ text: info.join(' · '), cls: 'pci-cell-info' });
        return {
            key: `layer${layer.id}${transparent ? 't' : 'o'}`,
            item: layer,
            name: layer.name,
            // drawing nothing for no camera, the entry costs nothing and shows nothing
            dim: !enabled || cameras === 0,
            title: `${layer.name} (id ${layer.id}), ${half}, ${index} in the composition`,
            cells
        };
    });
}

/**
 * Everything the property view shows for a layer: where its halves render in the composition, how
 * each sorts, the cameras rendering it with what each drew of it last frame, its lights and its mesh
 * instances, and a way to hide it from the view.
 *
 * @param {Layer} layer - The layer.
 * @param {{ app: AppBase, layerActions: LayerActions }} ctx - The app, and what the tab offers.
 * @returns {PropertySection[]} The sections.
 */
function buildLayerModel(layer, ctx) {
    const composition = ctx.app.scene?.layers ?? null;
    const halves = collectSubLayers(composition).filter(sub => sub.layer === layer);
    const hidden = ctx.layerActions.hidden(layer);

    const general = makeSection('layer', `Layer "${layer.name}"`);
    push(general, 'id', read(layer, 'id'));
    push(general, 'enabled', { text: String(layer.enabled), cls: 'bool' });
    push(general, 'view', {
        text: hidden ? 'hidden by the inspector' : (layer.enabled ? 'drawn' : 'off in the app'),
        cls: 'obj',
        actions: [{
            text: hidden ? 'Show' : 'Hide',
            title: hidden ? 'Draw the layer again, as the app had it' :
                'Turn the layer off to see what the view is without it. Reset or closing the panel turns it back on',
            disabled: !hidden && !layer.enabled,
            run: () => ctx.layerActions.hide(layer, !hidden)
        }]
    });
    for (const { transparent, enabled, index } of halves) {
        push(general, transparent ? 'transparent' : 'opaque', {
            text: `${index} in the composition${enabled ? '' : ', off'}`,
            cls: 'obj'
        });
    }
    if (halves.length === 0) push(general, 'composition', { text: 'not in the composition', cls: 'err' });
    push(general, 'opaque sort', { text: sortModeName(layer.opaqueSortMode), cls: 'obj' });
    push(general, 'transparent sort', { text: sortModeName(layer.transparentSortMode), cls: 'obj' });
    push(general, 'clear', {
        text: [layer.clearColorBuffer && 'color', layer.clearDepthBuffer && 'depth', layer.clearStencilBuffer && 'stencil'].filter(Boolean).join(', ') || 'nothing',
        cls: 'obj'
    });

    const cameras = makeSection('cameras', `Cameras (${layer.cameras.length})`);
    const cameraLabel = uniqueLabels();
    for (const camera of layer.cameras) {
        const entity = camera.entity;
        const drawn = halves.map(({ transparent }) => {
            const count = visibleCount(layer, camera, transparent);
            return count === null ? null : `${count} ${transparent ? 'transparent' : 'opaque'}`;
        }).filter(Boolean);
        push(cameras, cameraLabel(entity ? nodeLabel(entity) : 'camera'), {
            text: drawn.length ? `drew ${drawn.join(', ')}` : 'drew nothing yet',
            cls: 'obj',
            target: entity ?? undefined
        });
    }
    if (layer.cameras.length === 0) push(cameras, 'none', { text: 'no camera renders this layer', cls: 'null' });

    const lights = layerLights(layer);
    const lightSection = makeSection('lights', `Lights (${lights.length})`);
    const lightLabel = uniqueLabels();
    for (const light of lights) {
        const node = /** @type {any} */ (light)._node;
        push(lightSection, lightLabel(node ? nodeLabel(node) : 'light'), {
            text: `${['directional', 'omni', 'spot'][light.type] ?? light.type}${light.enabled ? '' : ', off'}${light.castShadows ? ', shadows' : ''}`,
            cls: 'obj',
            target: node ?? undefined
        });
    }

    const content = makeSection('content', 'Content');
    push(content, 'mesh instances', describeValue(layer.meshInstances));
    push(content, 'shadow casters', { text: String(layer.shadowCasters.length), cls: 'num' });
    const splats = /** @type {any} */ (layer).gsplatPlacements;
    if (splats?.length) push(content, 'splat placements', { text: String(splats.length), cls: 'num' });

    return [general, cameras, lightSection, content];
}

export { buildLayerModel, collectSubLayers, layerRows };
