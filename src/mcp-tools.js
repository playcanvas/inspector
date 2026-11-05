import { Material, revision, version } from 'playcanvas';

import { assetRows } from './asset-view.js';
import { cameraRows } from './camera-view.js';
import { copyListRow, copySubject } from './copy-json.js';
import { passRows } from './frame-graph-view.js';
import { matchesFilter } from './hierarchy-view.js';
import { materialListRows, surveyMaterials } from './material-view.js';
import { bufferOwners, memoryRows, videoMemory } from './memory-view.js';
import { meshListRows, surveyMeshes } from './mesh-view.js';
import { renderTargetRows } from './render-target-view.js';
import { scriptListRows, surveyScripts } from './script-view.js';
import { shaderRows } from './shader-view.js';
import { kindOf } from './ref-registry.js';
import { textureRows } from './texture-view.js';

/** @import { AppBase, GraphNode } from 'playcanvas' */
/** @import { CopyOptions } from './copy-json.js' */
/** @import { FrameSnapshot } from './frame-graph-view.js' */
/** @import { ListRow } from './list-view.js' */
/** @import { PropertyRow, PropertySection } from './model.js' */
/** @import { RefRegistry } from './ref-registry.js' */

/**
 * What the tools read the app through, provided by the inspector.
 *
 * @typedef {object} McpHost
 * @ignore
 * @property {AppBase} app - The app.
 * @property {RefRegistry} refs - The ids of the objects the tools return.
 * @property {(obj: object, subject: boolean) => PropertySection[]|PropertyRow[]|null} modelFor -
 * The model of an object as its tab shows it; for the subject of a request, with the lists of what
 * uses it.
 * @property {(obj: object) => boolean} opaque - Whether an object is never followed, see
 * {@link CopyOptions#opaque}.
 * @property {(obj: object) => boolean} exclude - Whether a node belongs to the inspector rather
 * than the app.
 * @property {() => FrameSnapshot} frame - The frame graph of the frame rendered last.
 */

/**
 * A tool, described the way WebMCP and MCP describe one.
 *
 * @typedef {object} McpTool
 * @property {string} name - The name the tool is called by.
 * @property {string} description - What the tool does, for the agent choosing it.
 * @property {object} inputSchema - The JSON schema of its arguments.
 * @property {{ readOnlyHint: boolean }} annotations - Hints about its effects: every tool of the
 * inspector only reads.
 */

/**
 * @typedef {McpTool & { execute: (host: McpHost, args: any) => any }} McpToolImpl
 * @ignore
 */

// the most entries a list or search returns at once, and how many links a get follows at most
const MAX_LIMIT = 500;
const MAX_DEPTH = 4;

// how many objects a get copies in full, so a deep get of a big scene stays a sensible size
const MAX_GET_OBJECTS = 2000;

/**
 * The lists of the inspector's tabs, by the kind a list tool names them.
 *
 * @type {Record<string, (host: McpHost) => ListRow[]>}
 */
const LISTS = {
    textures: ({ app }) => textureRows(app.graphicsDevice),
    shaders: ({ app }) => shaderRows(app.graphicsDevice),
    materials: ({ app }) => materialListRows(surveyMaterials(app)),
    meshes: ({ app }) => meshListRows(surveyMeshes(app)),
    scripts: ({ app }) => scriptListRows(surveyScripts(app)),
    cameras: ({ app }) => cameraRows(app, null),
    assets: ({ app }) => assetRows(app.assets, 'type'),
    renderTargets: host => renderTargetRows(host.app.graphicsDevice, host.frame()),
    passes: host => passRows(host.frame(), host.app.graphicsDevice),
    memory: ({ app }) => memoryRows(app.graphicsDevice, bufferOwners(app))
};

// the lists whose objects the app may rebuild every frame, which get ids by row key instead
const KEYED_LISTS = new Set(['passes', 'renderTargets']);

// the properties of a material that describe its class rather than itself
const MATERIAL_TABLES = new Set(['propertyDescriptors', 'textureDescriptors', 'textureIdentifiers']);

/**
 * Leaves out of a material what says nothing about it: the settings of each texture slot left
 * empty (its tiling, offset, rotation, uv set and channel), the channel of a vertex color not
 * used, and the tables its class keeps. A material otherwise lists some 300 properties.
 *
 * @param {PropertySection[]|PropertyRow[]|null} model - The model of a material.
 * @returns {PropertySection[]|PropertyRow[]|null} The model, trimmed.
 */
function trimMaterial(model) {
    if (!model) return model;
    const trimRows = (rows) => {
        const raw = new Map(rows.map(row => [row.label, 'raw' in row.value ? row.value.raw : row.value.target]));
        return rows.filter((row) => {
            if (MATERIAL_TABLES.has(row.label)) return false;
            const slot = /^(.+Map)(?:Tiling|Offset|Rotation|Uv|Channel)$/.exec(row.label);
            if (slot && raw.has(slot[1]) && !raw.get(slot[1])) return false;
            const vertex = /^(.+VertexColor)Channel$/.exec(row.label);
            if (vertex && raw.has(vertex[1]) && !raw.get(vertex[1])) return false;
            return true;
        });
    };
    if (model.length && Array.isArray(/** @type {any} */ (model[0]).rows)) {
        return /** @type {PropertySection[]} */ (model).map(section => ({ ...section, rows: trimRows(section.rows) }));
    }
    return trimRows(/** @type {PropertyRow[]} */ (model));
}

/**
 * @param {McpHost} host - The host.
 * @param {object} obj - An object.
 * @param {boolean} subject - Whether it is the object asked for.
 * @returns {PropertySection[]|PropertyRow[]|null} Its model, as the tools show it.
 */
function modelOf(host, obj, subject) {
    const model = host.modelFor(obj, subject);
    return obj instanceof Material ? trimMaterial(model) : model;
}

/**
 * Checks arguments against a tool's input schema: required properties, and the type, range and
 * allowed values of each property given. The browser passes arguments on as they are.
 *
 * @param {McpTool} tool - The tool.
 * @param {any} args - The arguments.
 */
function validate(tool, args) {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('The arguments must be an object');
    const schema = /** @type {any} */ (tool.inputSchema);
    for (const name of schema.required ?? []) {
        if (args[name] === undefined) throw new Error(`"${name}" is required`);
    }
    for (const [name, value] of Object.entries(args)) {
        const prop = schema.properties?.[name];
        if (!prop) throw new Error(`Unknown argument "${name}". Arguments: ${Object.keys(schema.properties ?? {}).join(', ') || 'none'}`);
        const ok = prop.type === 'integer' ? Number.isInteger(value) : typeof value === prop.type;
        if (!ok) throw new Error(`"${name}" must be ${prop.type === 'integer' ? 'an integer' : `a ${prop.type}`}`);
        if (prop.enum && !prop.enum.includes(value)) throw new Error(`"${name}" must be one of: ${prop.enum.join(', ')}`);
        if (prop.minimum !== undefined && value < prop.minimum) throw new Error(`"${name}" must be at least ${prop.minimum}`);
        if (prop.maximum !== undefined && value > prop.maximum) throw new Error(`"${name}" must be at most ${prop.maximum}`);
    }
}

/**
 * @param {*} value - A number argument.
 * @param {number} fallback - Its default.
 * @param {number} max - Its largest value.
 * @returns {number} The number, a whole one between 0 and max.
 */
function clampInt(value, fallback, max) {
    const n = Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(0, Math.min(max, n));
}

/**
 * @param {GraphNode} node - A node.
 * @returns {string[]} The types of its components.
 */
function componentsOf(node) {
    const c = /** @type {any} */ (node).c;
    return c ? Object.keys(c) : [];
}

/**
 * @param {McpHost} host - The host.
 * @returns {object} What the app is, and how it runs.
 */
function appSummary(host) {
    const app = /** @type {any} */ (host.app);
    const device = app.graphicsDevice;

    let entities = 0;
    const count = (node) => {
        if (host.exclude(node)) return;
        entities++;
        for (const child of node.children) count(child);
    };
    count(app.root);

    const frame = app.stats?.frame ?? {};
    const stats = {};
    for (const key of ['fps', 'ms', 'triangles', 'shaders', 'materials', 'cullTime', 'renderTime', 'updateTime']) {
        if (typeof frame[key] === 'number') stats[key] = frame[key];
    }
    if (typeof app.stats?.drawCalls?.total === 'number') stats.drawCalls = app.stats.drawCalls.total;

    return {
        engine: { version, revision },
        device: {
            type: device.deviceType,
            width: device.width,
            height: device.height,
            maxPixelRatio: device.maxPixelRatio,
            videoMemoryBytes: videoMemory(device)
        },
        root: host.refs.idOf(app.root),
        entities,
        assets: app.assets?.list().length ?? 0,
        timeScale: app.timeScale,
        stats,
        lists: Object.keys(LISTS)
    };
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - The search.
 * @returns {object} The entities found.
 */
function findEntities(host, args) {
    const name = typeof args?.name === 'string' ? args.name.toLowerCase() : '';
    const component = typeof args?.component === 'string' ? args.component.toLowerCase() : '';
    const script = typeof args?.script === 'string' ? args.script.toLowerCase() : '';
    const tag = typeof args?.tag === 'string' ? args.tag : '';
    const limit = clampInt(args?.limit, 50, MAX_LIMIT);

    const found = [];
    let total = 0;
    const visit = (node) => {
        if (host.exclude(node)) return;
        const match = (!name || matchesFilter(node, name, 'name')) &&
            (!component || matchesFilter(node, component, 'component')) &&
            (!script || matchesFilter(node, script, 'script')) &&
            (!tag || node.tags.has(tag));
        if (match) {
            total++;
            if (found.length < limit) {
                found.push({
                    $id: host.refs.idOf(node),
                    name: node.name,
                    path: node.path,
                    enabled: node.enabled,
                    components: componentsOf(node)
                });
            }
        }
        for (const child of node.children) visit(child);
    };
    visit(host.app.root);
    return { total, entities: found, truncated: total > found.length };
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - Which list, and which part of it.
 * @returns {object} The entries.
 */
function list(host, args) {
    const make = LISTS[args?.kind];
    if (!make) throw new Error(`Unknown list "${args?.kind}". One of: ${Object.keys(LISTS).join(', ')}`);
    const filter = typeof args?.filter === 'string' ? args.filter.toLowerCase() : '';
    const offset = clampInt(args?.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(args?.limit, 100, MAX_LIMIT);

    const keyed = KEYED_LISTS.has(args.kind);
    const entries = [];
    let total = 0;
    let group = null;
    for (const row of make(host)) {
        if (row.header) {
            group = row.name;
            continue;
        }
        if (filter && !(row.matches ? row.matches(filter) : row.name.toLowerCase().includes(filter))) continue;
        if (total++ < offset || entries.length >= limit) continue;

        const entry = {};
        const item = row.item;
        if ((typeof item === 'object' && item !== null) || typeof item === 'function') {
            // a pass rebuilt every frame keeps its id, which finds the pass at its place in the frame
            entry.$id = keyed ? host.refs.keyedId(kindOf(item), row.key, () => make(host).find(r => r.key === row.key)?.item ?? null) : host.refs.idOf(item);
            entry.$type = typeof item === 'function' ? 'Script' : item.constructor?.name ?? 'Object';
        }
        if (group) entry.group = group;
        const figures = copyListRow(row).json;
        // a row naming no object of its own, such as a step of a pass, is named by what it belongs to
        if (!figures.name && row.name) entry.name = row.name;
        // the separators the panel puts between cells mean nothing here
        for (const [key, value] of Object.entries(figures)) entry[key] = typeof value === 'string' ? value.replace(/^·\s*/, '') : value;
        entries.push(entry);
    }
    return { kind: args.kind, total, offset, entries, truncated: offset + entries.length < total };
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - The id, and how far to follow links.
 * @returns {object} The object, as its tab shows it.
 */
function get(host, args) {
    const id = typeof args?.id === 'string' ? args.id : '';
    const obj = host.refs.get(id);
    if (!obj) throw new Error(`No object with id "${id}": it is unknown, or the app has let go of it`);
    const depth = clampInt(args?.depth, 0, MAX_DEPTH);
    const result = copySubject(obj, /** @type {any} */ (modelOf(host, obj, true)), {
        depth,
        maxObjects: MAX_GET_OBJECTS,
        backlinks: true,
        code: args?.sources === true,
        idOf: o => host.refs.idOf(o),
        modelFor: o => modelOf(host, o, false),
        opaque: host.opaque,
        exclude: host.exclude
    });
    // an object found by a stable key is named by the id it was asked for
    const json = { ...result.json, $id: id };
    if (result.truncated) json.$truncated = true;
    return json;
}

/**
 * The tools of the inspector. Every one of them only reads the app.
 *
 * @type {McpToolImpl[]}
 */
const TOOLS = [{
    name: 'playcanvas_app_summary',
    description: 'Summarize the running PlayCanvas app: engine version, graphics device and its video memory, ' +
        'entity and asset counts, frame stats, the id of the scene root, and the lists playcanvas_list can return.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: appSummary
}, {
    name: 'playcanvas_find_entities',
    description: 'Find entities in the scene hierarchy by name, component type, script name and tag, all ' +
        'optional and combined. Matching is by case-insensitive substring except the tag, which is exact. ' +
        'Returns each entity with its id, to pass to playcanvas_get.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Part of the entity name.' },
            component: { type: 'string', description: 'Part of a component type, such as "render" or "camera".' },
            script: { type: 'string', description: 'Part of the name of a script on the entity.' },
            tag: { type: 'string', description: 'A tag the entity has.' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 }
        }
    },
    annotations: { readOnlyHint: true },
    execute: findEntities
}, {
    name: 'playcanvas_list',
    description: 'List what one tab of the inspector lists: textures, shaders, materials, meshes, scripts, ' +
        'cameras, assets, renderTargets, passes (the frame graph of the last frame) or memory (GPU buffers ' +
        'and textures by kind). Each entry has an id to pass to playcanvas_get, and the figures the list shows.',
    inputSchema: {
        type: 'object',
        properties: {
            kind: { type: 'string', enum: Object.keys(LISTS) },
            filter: { type: 'string', description: 'Only entries whose name contains this, case-insensitive.' },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 100 }
        },
        required: ['kind']
    },
    annotations: { readOnlyHint: true },
    execute: list
}, {
    name: 'playcanvas_get',
    description: 'Get an object by id, as the inspector shows it: an entity with its components, a mesh ' +
        'instance, material, shader, texture, mesh, render target, pass, asset, script or buffer. Every object ' +
        'it links to carries an $id to get next, so links can be followed, such as entity -> render component ' +
        '-> mesh instance -> material -> shader. Lists of what uses the object, and a node\'s parent, are ' +
        'included as references. depth follows links in place, up to 4 away: 0 returns the object alone. ' +
        'Source code, such as a shader\'s, is summarized unless sources is true.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'An $id returned by any of the tools, such as "material:12".' },
            depth: { type: 'integer', minimum: 0, maximum: MAX_DEPTH, default: 0 },
            sources: { type: 'boolean', default: false, description: 'Include source code, such as the sources of a shader.' }
        },
        required: ['id']
    },
    annotations: { readOnlyHint: true },
    execute: get
}];

export { TOOLS, validate };
