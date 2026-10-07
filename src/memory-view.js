import {
    BUFFER_DYNAMIC, BUFFER_GPUDYNAMIC, BUFFER_STATIC, BUFFER_STREAM, IndexBuffer, INDEXFORMAT_UINT16, INDEXFORMAT_UINT32, INDEXFORMAT_UINT8, StorageBuffer, VertexBuffer
} from 'playcanvas';

import { describeValue, isUniformBuffer } from './describe.js';
import { collectMeshInstances } from './instance-survey.js';
import { formatBytes, makeSection, push, read, reflectRows } from './model.js';
import { vertexFormatValue } from './node-model.js';
import { formatUniformBuffer } from './shader-view.js';

/** @import { AppBase } from 'playcanvas' */
/** @import { UniformBuffer } from 'playcanvas' */
/** @import { Asset } from 'playcanvas' */
/** @import { GraphicsDevice } from 'playcanvas' */
/** @import { GraphNode } from 'playcanvas' */
/** @import { Material } from 'playcanvas' */
/** @import { Described } from './describe.js' */
/** @import { ListRow } from './list-view.js' */
/** @import { PropertySection } from './model.js' */

/**
 * @typedef {VertexBuffer|IndexBuffer|UniformBuffer|StorageBuffer} Buffer
 * @ignore
 */

/**
 * Something a buffer was found to belong to.
 *
 * @typedef {object} BufferOwner
 * @property {string} role - What the buffer holds for it, such as 'vertices'.
 * @property {string} label - The owner's name.
 * @property {GraphNode|Asset|Material|null} target - What to link to, or null when there is nothing to
 * show.
 * @ignore
 */

// buffer properties the model shows explicitly, or that are plumbing
const SKIP_BUFFER = [
    'device', 'impl', 'storage', 'format', 'numBytes', 'numVertices', 'numIndices', 'byteSize', 'usage', 'persistent',
    'id', 'allocation', 'vaoKeyPart'
];

/** The groups the buffers are listed in, in order. */
const BUFFER_GROUPS = [
    ['vertex', 'Vertex buffers'], ['index', 'Index buffers'], ['uniform', 'Uniform buffers'], ['storage', 'Storage buffers']
];

const KIND_NAMES = { vertex: 'VertexBuffer', index: 'IndexBuffer', uniform: 'UniformBuffer', storage: 'StorageBuffer' };

// what a buffer of each kind usually holds for its owner, which its row leaves unsaid
const PLAIN_ROLES = { vertex: 'vertices', index: 'indices' };

// the device caches that grow with the variety of what is drawn, by their resource count key
const CACHE_NAMES = [
    ['renderPipelines', 'render pipelines'], ['computePipelines', 'compute pipelines'], ['bindGroups', 'bind groups'],
    ['bindGroupFormats', 'bind group formats'], ['drawCommands', 'draw commands'], ['shaders', 'shaders']
];

const USAGE_NAMES = {
    [BUFFER_STATIC]: 'BUFFER_STATIC',
    [BUFFER_DYNAMIC]: 'BUFFER_DYNAMIC',
    [BUFFER_STREAM]: 'BUFFER_STREAM',
    [BUFFER_GPUDYNAMIC]: 'BUFFER_GPUDYNAMIC'
};

// what each index buffer of a mesh holds, by render style: triangles, then the lazily built edges
// and points
const INDEX_ROLES = ['indices', 'wireframe indices', 'point indices'];

const INDEX_FORMAT_NAMES = {
    [INDEXFORMAT_UINT8]: 'UINT8',
    [INDEXFORMAT_UINT16]: 'UINT16',
    [INDEXFORMAT_UINT32]: 'UINT32'
};

/** @type {WeakMap<object, number>} */
const ids = new WeakMap();
let nextId = 1;

/**
 * @param {Buffer} buffer - A buffer.
 * @returns {number} An id that stays the same for the lifetime of the buffer, since buffers carry
 * no name of their own.
 */
function idOf(buffer) {
    let id = ids.get(buffer);
    if (id === undefined) {
        id = nextId++;
        ids.set(buffer, id);
    }
    return id;
}

/**
 * @param {*} buffer - A buffer.
 * @returns {'vertex'|'index'|'uniform'|'storage'|null} Its kind, or null for anything else.
 */
function bufferKind(buffer) {
    if (buffer instanceof VertexBuffer) return 'vertex';
    if (buffer instanceof IndexBuffer) return 'index';
    if (isUniformBuffer(buffer)) return 'uniform';
    if (buffer instanceof StorageBuffer) return 'storage';
    return null;
}

/**
 * @param {Buffer} buffer - A buffer.
 * @returns {number} Its size in bytes.
 */
function bufferBytes(buffer) {
    const b = /** @type {any} */ (buffer);
    return b.numBytes ?? b.byteSize ?? b.format?.byteSize ?? 0;
}

/**
 * @param {number} n - A count.
 * @param {string} one - The word for one.
 * @param {string} [many] - The word for any other count, the singular with an s by default.
 * @returns {string} The count with its word.
 */
function plural(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * @param {Buffer} buffer - A buffer.
 * @returns {string} What it holds, in a few words, or an empty string for a storage buffer, whose
 * contents only its user knows.
 */
function contentText(buffer) {
    const b = /** @type {any} */ (buffer);
    switch (bufferKind(buffer)) {
        case 'vertex':
            return `${plural(b.numVertices, 'vertex', 'vertices')}, ${plural(b.format?.elements?.length ?? 0, 'element')}` +
                `${b.format?.instancing ? ', instancing' : ''}`;
        case 'index':
            return `${plural(b.numIndices, 'index', 'indices')}, ${INDEX_FORMAT_NAMES[b.format] ?? b.format}`;
        case 'uniform':
            return plural(b.format?.uniforms?.length ?? 0, 'uniform');
        default:
            return '';
    }
}

/**
 * @param {GraphNode|null} node - The node a mesh instance draws at.
 * @returns {string} Its name, after its parent's when it has one below the root: imported models
 * often give every mesh node the same name, and the parent tells them apart.
 */
function nodeLabel(node) {
    if (!node) return '(no node)';
    const parent = node.parent;
    return parent?.parent ? `${parent.name} › ${node.name}` : node.name;
}

/**
 * Finds what the buffers on the device belong to. No buffer records its owner, so the owners are
 * found from the other end: every mesh instance of the components and layers, see
 * {@link collectMeshInstances}, gives its mesh's geometry and its material's uniforms, the
 * immediate renderer gives the batches of debug lines,
 * loaded render assets give the geometry of meshes not drawn right now, and the device gives its
 * own quad. Storage buffers and the per-draw uniform pool are
 * held privately by their users and stay unattributed.
 *
 * @param {AppBase} app - The app.
 * @returns {Map<Buffer, BufferOwner[]>} The owners of each attributed buffer.
 */
function bufferOwners(app) {
    /** @type {Map<Buffer, BufferOwner[]>} */
    const owners = new Map();
    const add = (buffer, owner) => {
        if (!buffer) return;
        let list = owners.get(buffer);
        if (!list) {
            list = [];
            owners.set(buffer, list);
        }
        list.push(owner);
    };

    // a material shared by many instances owns one buffer, so it is listed once
    const materials = new Set();
    for (const { instance } of collectMeshInstances(app)) {
        const node = instance.node ?? null;
        const label = nodeLabel(node);
        const mesh = instance.mesh;
        if (mesh) {
            add(mesh.vertexBuffer, { role: 'vertices', label, target: node });
            mesh.indexBuffer?.forEach((indexBuffer, style) => {
                add(indexBuffer, { role: INDEX_ROLES[style] ?? 'indices', label, target: node });
            });
            add(mesh.morph?.vertexBufferIds, { role: 'morph target ids', label, target: node });
        }
        add(/** @type {any} */ (instance)._materialUniformBuffer, { role: 'material uniforms of the instance', label, target: node });
        const material = instance.material;
        if (material && !materials.has(material)) {
            materials.add(material);
            add(/** @type {any} */ (material)._uniformBuffer, { role: 'material uniforms', label: `Material "${material.name}"`, target: material });
        }
    }

    // debug lines are pushed straight into the visible list each frame rather than added to a
    // layer, so their batches are found through the immediate renderer that owns them
    for (const [layer, batches] of app.scene?.immediate?.batchesMap ?? []) {
        for (const batch of batches.map?.values() ?? []) {
            add(batch.mesh?.vertexBuffer, { role: 'debug lines', label: `Lines on "${layer.name}"`, target: null });
        }
    }

    for (const asset of app.assets?.list() ?? []) {
        if (asset.type !== 'render' || !asset.loaded) continue;
        const label = `Asset "${asset.name}"`;
        for (const mesh of asset.resource?.meshes ?? []) {
            add(mesh?.vertexBuffer, { role: 'vertices', label, target: asset });
            mesh?.indexBuffer?.forEach((indexBuffer, style) => {
                add(indexBuffer, { role: INDEX_ROLES[style] ?? 'indices', label, target: asset });
            });
        }
    }

    // the quad every full screen pass draws
    const device = /** @type {any} */ (app.graphicsDevice);
    add(device?.quadVertexBuffer, { role: 'full screen quad vertices', label: 'Graphics device', target: null });
    add(device?.quadIndexBuffer, { role: 'full screen quad indices', label: 'Graphics device', target: null });
    return owners;
}

/**
 * Every buffer the device tracks, largest first. Uniform buffers appear only when persistent, as
 * the rest are slices of the per-draw pool.
 *
 * @param {GraphicsDevice} device - The device.
 * @param {'all'|'vertex'|'index'|'uniform'|'storage'} [kind] - The kind to collect.
 * @returns {Buffer[]} The buffers.
 */
function collectBuffers(device, kind = 'all') {
    const buffers = [...(device.buffers ?? [])].filter(buffer => bufferKind(buffer) && (kind === 'all' || bufferKind(buffer) === kind));
    return buffers.sort((a, b) => bufferBytes(b) - bufferBytes(a) || idOf(a) - idOf(b));
}

/**
 * @param {BufferOwner[]|undefined} owners - What a buffer belongs to.
 * @returns {string} A name for it, from its first owner, since buffers carry none of their own.
 */
function bufferName(owners) {
    return owners?.length ? owners[0].label : '(owner not found)';
}

/**
 * @param {GraphicsDevice} device - The device.
 * @returns {number} The video memory the device counts for its textures and buffers.
 */
function videoMemory(device) {
    const vram = /** @type {any} */ (device)._vram ?? {};
    return (vram.tex ?? 0) + (vram.vb ?? 0) + (vram.ib ?? 0) + (vram.ub ?? 0) + (vram.sb ?? 0);
}

/**
 * @param {string} key - The group's key.
 * @param {string} title - The group's name.
 * @param {string} count - How many it holds, or an empty string.
 * @param {string} size - Their total size, or an empty string.
 * @param {string} tip - What the group holds.
 * @returns {ListRow} The row heading a group of the memory list.
 */
function headerRow(key, title, count, size, tip) {
    return {
        key: `group:${key}`,
        item: null,
        name: title,
        header: true,
        title: tip,
        cells: [{ text: title, cls: 'pci-cell-name' }, { text: count, cls: 'pci-cell-count' }, { text: size, cls: 'pci-cell-size' }]
    };
}

/**
 * @param {string} key - A key unique within the list.
 * @param {string} name - What the row counts or measures.
 * @param {object} values - What it shows.
 * @param {string} [values.info] - A few words about it.
 * @param {string} [values.count] - A count, in the column of the group counts.
 * @param {string} [values.size] - A size, in the column of the group sizes.
 * @param {string} [values.tip] - A tooltip.
 * @returns {ListRow} A row of a group that shows figures and has nothing to select.
 */
function infoRow(key, name, { info = '', count = '', size = '', tip }) {
    return {
        key,
        item: null,
        name,
        indent: 1,
        inert: true,
        title: tip,
        cells: [
            { text: name, cls: 'pci-cell-name' }, { text: info, cls: 'pci-cell-info' },
            { text: count, cls: 'pci-cell-count' }, { text: size, cls: 'pci-cell-size' }
        ]
    };
}

/**
 * @param {Buffer} buffer - A buffer.
 * @param {BufferOwner[]|undefined} users - What it belongs to.
 * @returns {ListRow} Its row, named after what uses it and dimmed when nothing was found.
 */
function bufferRow(buffer, users) {
    const kind = bufferKind(buffer);
    const name = bufferName(users);
    const content = contentText(buffer);
    const notes = content ? [content] : [];
    const role = users?.[0].role;
    if (role && role !== PLAIN_ROLES[kind]) notes.push(role);
    if (users && users.length > 1) notes.push(`${users.length} users`);
    const size = formatBytes(bufferBytes(buffer));
    const title = [KIND_NAMES[kind], content ? `${content}, ${size}` : size,
        users ? `${users[0].role} of ${users[0].label}${users.length > 1 ? `, ${users.length} users` : ''}` : 'owner not found'].join('\n');
    return {
        key: `buffer${idOf(buffer)}`,
        item: buffer,
        name,
        indent: 1,
        dim: !users,
        title,
        cells: [
            { text: name, cls: 'pci-cell-name' }, { text: notes.join(' · '), cls: 'pci-cell-info' },
            { text: size, cls: 'pci-cell-info pci-cell-right' }
        ]
    };
}

/**
 * The textures on the device, in total, and split by what they are for where the engine tracks
 * that, which only profiler builds do. They are listed one by one on the Textures tab.
 *
 * @param {GraphicsDevice} device - The device.
 * @returns {ListRow[]} The rows of the group.
 */
function textureGroup(device) {
    const vram = /** @type {any} */ (device)._vram ?? {};
    const total = vram.tex ?? 0;
    const rows = [headerRow('textures', 'Textures', String(device.textures?.size ?? 0), formatBytes(total),
        'Every texture on the device, including the render target attachments. The Textures tab lists them')];
    const split = [['assets', vram.texAsset], ['shadow maps', vram.texShadow], ['lightmaps', vram.texLightmap]];
    if (split.some(([, bytes]) => bytes)) {
        for (const [name, bytes] of split) {
            rows.push(infoRow(`textures:${name}`, name, { size: formatBytes(bytes ?? 0) }));
        }
        const rest = total - split.reduce((sum, [, bytes]) => sum + (bytes ?? 0), 0);
        rows.push(infoRow('textures:other', 'other', { info: 'render targets and textures made at runtime', size: formatBytes(Math.max(0, rest)) }));
    }
    return rows;
}

/**
 * The persistent uniform buffers, and the pool that the uniforms set for each draw are written
 * into every frame. The pool has no buffer object to list, so it is counted from the device: its
 * size is what the device counts for uniform buffers beyond the persistent ones.
 *
 * @param {GraphicsDevice} device - The device.
 * @param {Buffer[]} buffers - The persistent uniform buffers, largest first.
 * @param {Map<Buffer, BufferOwner[]>} owners - The owners of each buffer.
 * @returns {ListRow[]} The rows of the group.
 */
function uniformGroup(device, buffers, owners) {
    const vram = /** @type {any} */ (device)._vram ?? {};
    const persistent = buffers.reduce((sum, buffer) => sum + bufferBytes(buffer), 0);
    const rows = buffers.map(buffer => bufferRow(buffer, owners.get(buffer)));

    let count = buffers.length;
    let bytes = persistent;
    const pool = /** @type {any} */ (device).dynamicBuffers;
    if (pool?.bufferCount) {
        const poolBytes = Math.max(0, (vram.ub ?? 0) - persistent);
        count += pool.bufferCount;
        bytes += poolBytes;
        // WebGPU carves the draws out of large fixed blocks, each written through a staging copy;
        // WebGL2 keeps whole buffers of each size requested, so only their count says anything there
        let info = plural(pool.bufferCount, 'buffer');
        if (pool.bufferSize) {
            const staging = pool.stagingBuffers?.length;
            info = `${info}${staging ? ` + ${staging} staging` : ''}, ${formatBytes(pool.bufferSize)} each`;
        }
        rows.unshift(infoRow('uniform:pool', 'per-draw uniform pool', {
            info,
            size: formatBytes(poolBytes),
            tip: 'The buffers the uniforms set for each draw are written into, every frame'
        }));
    }
    if (!count) return [];
    return [headerRow('uniform', 'Uniform buffers', String(count), formatBytes(bytes),
        'The persistent uniform buffers, such as those of the materials, and the per-draw pool'), ...rows];
}

/**
 * @param {GraphicsDevice} device - The device.
 * @returns {ListRow[]} The rows of the group counting the device caches, which grow with the
 * variety of what is drawn, or none when the device reports none.
 */
function cacheGroup(device) {
    const counts = new Map();
    /** @type {any} */ (device).getResourceCounts?.(counts);
    const rows = CACHE_NAMES.filter(([key]) => counts.has(key))
    .map(([key, name]) => infoRow(`caches:${key}`, name, { count: String(counts.get(key)) }));
    if (!rows.length) return [];
    return [headerRow('caches', 'Device caches', '', '', 'The pipelines, bind groups and shaders the device has created and keeps for reuse'), ...rows];
}

/**
 * The rows of the memory list: one group per kind of resource, headed by its count and total size
 * and closed until opened, holding its buffers largest first, named after what uses each. The
 * device caches come last. Kinds with nothing on the device are left out.
 *
 * @param {GraphicsDevice} device - The device.
 * @param {Map<Buffer, BufferOwner[]>} owners - The owners of each buffer.
 * @returns {ListRow[]} The rows.
 */
function memoryRows(device, owners) {
    const rows = textureGroup(device);
    const buffers = collectBuffers(device);
    for (const [kind, title] of BUFFER_GROUPS) {
        const members = buffers.filter(buffer => bufferKind(buffer) === kind);
        if (kind === 'uniform') {
            rows.push(...uniformGroup(device, members, owners));
        } else if (members.length) {
            const bytes = members.reduce((sum, buffer) => sum + bufferBytes(buffer), 0);
            rows.push(headerRow(kind, title, String(members.length), formatBytes(bytes), `The ${title.toLowerCase()} on the device`));
            for (const buffer of members) rows.push(bufferRow(buffer, owners.get(buffer)));
        }
    }
    rows.push(...cacheGroup(device));
    return rows;
}

/**
 * Everything the property view shows for a buffer: its size and layout, what it was found to
 * belong to (linked), and every other public property.
 *
 * @param {Buffer} buffer - The buffer.
 * @param {{ app: AppBase }} ctx - The app, to find the buffer's owners.
 * @returns {PropertySection[]} The sections.
 */
function buildBufferModel(buffer, ctx) {
    const sections = [];
    const b = /** @type {any} */ (buffer);
    const kind = bufferKind(buffer);

    const general = makeSection('buffer', KIND_NAMES[kind] ?? 'Buffer');
    push(general, 'id', describeValue(idOf(buffer)));
    push(general, 'size', { text: formatBytes(bufferBytes(buffer)), cls: 'num' });
    if (kind === 'vertex') {
        push(general, 'vertices', describeValue(b.numVertices));
        if (b.format) push(general, 'vertex format', vertexFormatValue(b.format));
    } else if (kind === 'index') {
        push(general, 'indices', describeValue(b.numIndices));
        push(general, 'index format', { text: INDEX_FORMAT_NAMES[b.format] ?? String(b.format), cls: 'obj' });
    } else if (kind === 'uniform') {
        push(general, 'persistent', read(b, 'persistent'));
        if (b.format) {
            push(general, 'layout', { text: `${b.format.uniforms.length} uniforms`, cls: 'num', code: formatUniformBuffer(b.format) });
        }
    }
    if (b.usage !== undefined) push(general, 'usage', { text: USAGE_NAMES[b.usage] ?? String(b.usage), cls: 'obj' });
    sections.push(general);

    const owners = bufferOwners(ctx.app).get(buffer) ?? [];
    const usage = makeSection('users', 'Used by');
    push(usage, 'owners', {
        text: owners.length ? `${owners.length} user${owners.length === 1 ? '' : 's'}` :
            'not found: held by something the panel cannot reach, such as a storage buffer',
        cls: owners.length ? 'obj' : 'null',
        items: owners.slice(0, 50).map(owner => ({
            label: owner.role,
            ...(owner.target ? describeValue(owner.target) : { text: owner.label, cls: 'obj' })
        }))
    });
    if (owners.length > 50) usage.rows.push({ key: 'more', label: '', value: { text: `… ${owners.length - 50} more`, cls: 'null' }, depth: 1 });
    sections.push(usage);

    const rest = makeSection('props', 'Properties');
    reflectRows(rest, buffer, [], SKIP_BUFFER);
    if (rest.rows.length) sections.push(rest);

    return sections;
}

export {
    bufferKind, bufferOwners, buildBufferModel, collectBuffers, idOf, KIND_NAMES, memoryRows, nodeLabel, videoMemory
};
