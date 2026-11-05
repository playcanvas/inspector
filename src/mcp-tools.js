import { Material, RenderTarget, Texture, revision, version } from 'playcanvas';

import { assetRows } from './asset-view.js';
import { cameraRows } from './camera-view.js';
import { copyListRow, copySubject } from './copy-json.js';
import { passRows } from './frame-graph-view.js';
import { matchesFilter } from './hierarchy-view.js';
import { LEVELS } from './log-capture.js';
import { materialListRows, surveyMaterials } from './material-view.js';
import { bufferOwners, memoryRows, videoMemory } from './memory-view.js';
import { meshListRows, surveyMeshes } from './mesh-view.js';
import { SERIES, frameJson, header, loadJson, passesOf, seriesRows, toCsv } from './perf-copy.js';
import { captureNorms, isHitch, rangeStats } from './perf-view.js';
import { renderTargetRows } from './render-target-view.js';
import { scriptListRows, surveyScripts } from './script-view.js';
import { shaderRows } from './shader-view.js';
import { kindOf } from './ref-registry.js';
import { textureRows } from './texture-view.js';

/** @import { AppBase, GraphNode } from 'playcanvas' */
/** @import { CopyOptions } from './copy-json.js' */
/** @import { FrameSnapshot } from './frame-graph-view.js' */
/** @import { ListRow } from './list-view.js' */
/** @import { PerfCapture } from './perf-capture.js' */
/** @import { PropertyRow, PropertySection } from './model.js' */
/** @import { RefRegistry } from './ref-registry.js' */
/** @import { LogCapture } from './log-capture.js' */
/** @import { ImageCapture } from './image-capture.js' */

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
 * @property {McpPerfHost} perf - The capture of the Performance tab, and its controls.
 * @property {LogCapture} logs - The messages the page logged since the tools were turned on.
 * @property {() => ImageCapture} images - Captures textures and the canvas into images.
 * @property {McpTimeHost} time - Pausing and stepping the app, as the Pause and Step buttons do.
 */

/**
 * The Pause and Step buttons, as the time tools drive them.
 *
 * @typedef {object} McpTimeHost
 * @ignore
 * @property {() => boolean} paused - Whether the app is paused.
 * @property {(paused: boolean) => void} setPaused - Pauses or resumes the app.
 * @property {(frames: number, timeout: number) => Promise<number>} step - Pauses the app if it is
 * not, then runs that many frames with time moving, and resolves with how many ran before the
 * timeout, in milliseconds.
 * @property {() => number} frame - The number of the app frame now.
 */

/**
 * The Performance tab as the perf tools drive it: its capture, and the switches the panel shows,
 * set through the panel so its controls follow.
 *
 * @typedef {object} McpPerfHost
 * @ignore
 * @property {PerfCapture} capture - The capture.
 * @property {(on: boolean) => void} setRecording - Starts or stops recording, as the Record button.
 * @property {(on: boolean) => void} setGpuTimings - Turns the GPU timings on or off.
 * @property {(on: boolean) => void} setScriptTiming - Turns the timing of scripts on or off.
 * @property {() => void} clear - Forgets every frame, as the Clear button.
 * @property {() => boolean} gpuSupported - Whether the device can time the GPU.
 * @property {() => boolean} gpuTimings - Whether the GPU is being timed.
 * @property {() => boolean} paused - Whether the inspector has paused the app.
 * @property {() => object} device - What to say about the device in a capture.
 * @property {boolean} byAgent - Whether the frames kept were recorded by the tools, rather than by
 * the user, whose capture the tools do not clear unasked. Starting to record from the panel or
 * from code clears it.
 * @property {PerfSession|null} session - The recording the tools are stopping after a number of
 * frames, if any.
 */

/**
 * A recording the perf tools stop after a number of frames.
 *
 * @typedef {object} PerfSession
 * @ignore
 * @property {number} from - The first frame it records.
 * @property {number} target - The frame it stops before.
 * @property {boolean} hidden - Whether the page was hidden while it recorded.
 * @property {() => void} onFrame - Stops it once the frames are recorded.
 * @property {() => void} onVisibility - Notes the page being hidden.
 * @property {ReturnType<typeof setTimeout>} timer - Stops it when it takes too long.
 * @property {((reason: string) => void)|null} done - Hands the reason it ended to a caller waiting.
 */

/**
 * A tool, described the way WebMCP and MCP describe one.
 *
 * @typedef {object} McpTool
 * @property {string} name - The name the tool is called by.
 * @property {string} description - What the tool does, for the agent choosing it.
 * @property {object} inputSchema - The JSON schema of its arguments.
 * @property {{ readOnlyHint: boolean, destructiveHint?: boolean }} annotations - Hints about its
 * effects: most tools only read; the perf tools change the inspector's capture, never the app.
 */

/**
 * @typedef {McpTool & { execute: (host: McpHost, args: any) => any }} McpToolImpl
 * @ignore
 */

// the most entries a list or search returns at once, and how many links a get follows at most
const MAX_LIMIT = 500;
const MAX_DEPTH = 4;

// the lists an index holds, and the most entries of each, so even a huge app gives a bounded index
const INDEX_LISTS = ['cameras', 'materials', 'textures', 'shaders', 'meshes', 'renderTargets', 'scripts', 'assets', 'passes'];
const MAX_INDEX_ENTRIES = 2000;

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
        if (prop.pattern && !new RegExp(prop.pattern).test(value)) throw new Error(`"${name}" must match ${prop.pattern}`);
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
 * @param {string} kind - Which list, one of {@link LISTS}.
 * @param {string} filter - The lower-cased text names must contain, or empty for every entry.
 * @param {number} offset - How many matching entries to skip.
 * @param {number} limit - The most entries to return.
 * @returns {{ total: number, entries: object[] }} The entries, and how many match in all.
 */
function listEntries(host, kind, filter, offset, limit) {
    const make = LISTS[kind];
    const keyed = KEYED_LISTS.has(kind);
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
        for (const [key, value] of Object.entries(figures)) {
            // the separators the panel puts between cells mean nothing here
            const text = typeof value === 'string' ? value.replace(/^·\s*/, '') : value;
            // a row's tags, such as 'skinned' and 'morph', make one list
            if (/^tag(?: \(\d+\))?$/.test(key)) (entry.tags ??= []).push(text);
            else entry[key] = text;
        }
        entries.push(entry);
    }
    return { total, entries };
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - Which list, and which part of it.
 * @returns {object} The entries.
 */
function list(host, args) {
    if (!LISTS[args?.kind]) throw new Error(`Unknown list "${args?.kind}". One of: ${Object.keys(LISTS).join(', ')}`);
    const filter = typeof args?.filter === 'string' ? args.filter.toLowerCase() : '';
    const offset = clampInt(args?.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(args?.limit, 100, MAX_LIMIT);
    const { total, entries } = listEntries(host, args.kind, filter, offset, limit);
    return { kind: args.kind, total, offset, entries, truncated: offset + entries.length < total };
}

/**
 * @param {McpHost} host - The host.
 * @returns {object} Everything the app holds, an entry each with its id: the summary, every
 * entity with its path and components, and the entries of every list but memory.
 */
function index(host) {
    const entities = [];
    let total = 0;
    const visit = (node) => {
        if (host.exclude(node)) return;
        // the root is the summary's, and has no path
        if (node !== host.app.root && total++ < MAX_INDEX_ENTRIES) {
            const entry = { $id: host.refs.idOf(node), path: node.path, components: componentsOf(node) };
            if (!node.enabled) entry.enabled = false;
            entities.push(entry);
        }
        for (const child of node.children) visit(child);
    };
    visit(host.app.root);

    const out = { summary: appSummary(host), entities: { total, entries: entities, truncated: total > entities.length } };
    for (const kind of INDEX_LISTS) {
        const result = listEntries(host, kind, '', 0, MAX_INDEX_ENTRIES);
        out[kind] = { total: result.total, entries: result.entries, truncated: result.total > result.entries.length };
    }
    return out;
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

// the series playcanvas_perf_series returns, and the most rows of one at once
const PERF_SERIES = [...Object.keys(SERIES), 'scripts', 'counters', 'loading', 'events'];
const MAX_SERIES_ROWS = 300;

// how many of each kind of entry a summary lists, so it stays a few KB
const SUMMARY_PASSES = 15;
const SUMMARY_SCRIPTS = 10;
const SUMMARY_HITCHES = 10;
const SUMMARY_LOADS = 10;

// how long a recording of a number of frames may take by default, and at most, in seconds
const PERF_TIMEOUT = 30;
const MAX_PERF_TIMEOUT = 300;

/**
 * @param {number} v - A figure.
 * @returns {number} It to three decimals, which is a microsecond for a time in milliseconds.
 */
function round(v) {
    return Math.round(v * 1000) / 1000;
}

/**
 * @returns {string} Whether the page is visible, hidden or else, as the browser says; frames stop
 * while it is hidden.
 */
function visibility() {
    return typeof document !== 'undefined' ? document.visibilityState : 'unknown';
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {number} frame - A frame number, as the frames are numbered in what the tools return.
 * @returns {number} Its sequence number.
 */
function seqOf(capture, frame) {
    return capture.startedAtStartup ? frame : frame - 1;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {any} args - The first and last frame numbers asked for, both optional.
 * @returns {{ from: number, to: number }} The frames, as sequence numbers, within those kept.
 */
function rangeOf(capture, args) {
    if (!capture.count) throw new Error('Nothing is recorded: start a capture with playcanvas_perf_record');
    const first = capture.first;
    const last = capture.end - 1;
    const from = args?.from === undefined ? first : Math.max(first, seqOf(capture, args.from));
    const to = args?.to === undefined ? last : Math.min(last, seqOf(capture, args.to));
    if (from > to) throw new Error(`No frames kept in that range. Frames kept: ${capture.frameNumber(first)} to ${capture.frameNumber(last)}`);
    return { from, to };
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {string|Float64Array} key - The channel, or a ring of values like one.
 * @param {number} from - The first frame.
 * @param {number} to - The last frame, inclusive.
 * @returns {object|null} The smallest, mean, 95th percentile and largest of the figure over the
 * frames, with how many frames had it where some did not, or null where none did.
 */
function figureStats(capture, key, from, to) {
    const { count, avg, p95, max } = rangeStats(capture, key, from, to);
    if (!count) return null;
    const data = typeof key === 'string' ? capture.data[key] : key;
    let min = Infinity;
    for (let seq = from; seq <= to; seq++) {
        const v = data[capture.slot(seq)];
        if (v < min) min = v;
    }
    /** @type {any} */
    const out = { min: round(min), avg: round(avg), p95: round(p95), max: round(max) };
    if (count < to - from + 1) out.frames = count;
    return out;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {number} from - The first frame.
 * @param {number} to - The last frame, inclusive.
 * @param {(seq: number) => number} value - The figure of a frame.
 * @returns {Float64Array} A ring of the figure, like the channels of the capture, for
 * {@link figureStats}.
 */
function ringOf(capture, from, to, value) {
    const ring = new Float64Array(capture.slots).fill(NaN);
    for (let seq = from; seq <= to; seq++) ring[capture.slot(seq)] = value(seq);
    return ring;
}

/**
 * @param {Record<string, object|null>} figures - Figures by name.
 * @returns {Record<string, object>} Those that some frame had.
 */
function present(figures) {
    return Object.fromEntries(Object.entries(figures).filter(([, v]) => v));
}

/**
 * The capture, or a span of it, in a few KB: for each series the smallest, mean, 95th percentile
 * and largest figure, the GPU passes and script types that took longest, the hitches, what loaded
 * and the shader compiles. Durations are in milliseconds, memory in bytes.
 *
 * @param {McpHost} host - The host.
 * @param {number} from - The first frame.
 * @param {number} to - The last frame, inclusive.
 * @param {boolean} [withInspector] - Whether to count the inspector's own time in the CPU figures.
 * @returns {object} The summary.
 */
function perfSummary(host, from, to, withInspector = false) {
    const perf = host.perf;
    const capture = perf.capture;
    const d = capture.data;
    const stats = key => figureStats(capture, key, from, to);

    const head = header(capture, from, to);
    const interval = rangeStats(capture, 'interval', from, to);
    /** @type {any} */
    const out = {
        ...head,
        medianFrame: round(head.medianFrame),
        displayInterval: round(head.displayInterval),
        fps: interval.count ? round(1000 / interval.avg) : null,
        device: perf.device(),
        recording: capture.recording,
        options: { gpuTimings: perf.gpuTimings(), scriptTiming: capture.timeScripts },
        visibility: visibility()
    };
    if (perf.session?.hidden) out.hiddenWhileRecording = true;
    if (perf.paused()) out.paused = true;

    const inspector = rangeStats(capture, 'inspector', from, to);
    out.inspectorTime = withInspector ?
        'included in the CPU figures' :
        `left out of the CPU figures: ${round(inspector.count ? inspector.avg : 0)} ms a frame on average; pass includeInspector to count it`;

    const update = withInspector ? 'update' : ringOf(capture, from, to, seq => d.update[capture.slot(seq)] - d.inspector[capture.slot(seq)]);
    out.frameTime = stats('interval');
    out.cpu = present({
        total: stats(withInspector ? 'cpu' : 'cpuApp'),
        update: stats(update),
        render: stats('render'),
        scripts: stats('scripts'),
        physics: stats('physics'),
        animation: stats('anim'),
        ...(withInspector ? { inspector: stats('inspector') } : {})
    });

    // the GPU passes by name, those that took longest on average first
    const gpu = stats('gpu');
    if (gpu) {
        const names = new Set();
        for (let seq = from; seq <= to; seq++) {
            for (const pass of capture.passesInOrder(seq)) names.add(pass.name);
        }
        const passes = [...names].map((name) => {
            const ring = ringOf(capture, from, to, seq => (Number.isFinite(d.gpu[capture.slot(seq)]) ? passesOf(capture, seq)[name] ?? 0 : NaN));
            return { name, ...figureStats(capture, ring, from, to) };
        }).sort((a, b) => b.avg - a.avg);
        out.gpu = { frame: gpu, passes: passes.slice(0, SUMMARY_PASSES) };
        if (passes.length > SUMMARY_PASSES) out.gpu.morePasses = passes.length - SUMMARY_PASSES;
    }

    // the script types that took longest on average, over the frames scripts were timed in
    const scripts = stats('scriptsTotal');
    if (scripts) {
        const types = capture.scriptNames.map((name, id) => ({ name, ...figureStats(capture, ringOf(capture, from, to, seq => capture.scriptTime(seq, id)), from, to) }))
        .filter(type => type.avg > 0)
        .sort((a, b) => b.avg - a.avg);
        out.scripts = { total: scripts, calls: stats('scriptCalls'), timingCost: stats('scriptCost'), top: types.slice(0, SUMMARY_SCRIPTS) };
        if (types.length > SUMMARY_SCRIPTS) out.scripts.moreTypes = types.length - SUMMARY_SCRIPTS;
    }

    out.draws = present({
        total: stats('draws'),
        forward: stats('drawsForward'),
        shadow: stats('drawsShadow'),
        primitives: stats('primitives'),
        computeDispatches: stats('dispatches')
    });
    out.memory = present({ jsHeap: stats('heap'), video: stats('vram'), textures: stats('vramTex') });

    // the frames that took far longer than the median one, the longest first
    const { median } = captureNorms(capture);
    const hitches = [];
    let compiles = 0;
    let compileTime = 0;
    const loads = [];
    for (let seq = from; seq <= to; seq++) {
        const s = capture.slot(seq);
        if (isHitch(capture, seq, median)) {
            /** @type {any} */
            const hitch = { frame: capture.frameNumber(seq), interval: round(d.interval[s]), cpu: round(d[withInspector ? 'cpu' : 'cpuApp'][s]) };
            if (Number.isFinite(d.gpu[s])) hitch.gpu = round(d.gpu[s]);
            if (d.compiles[s] > 0) hitch.shaderCompiles = d.compiles[s];
            if (capture.loads(seq).length) hitch.loads = capture.loads(seq).length;
            hitches.push(hitch);
        }
        if (d.compiles[s] > 0) {
            compiles += d.compiles[s];
            compileTime += d.compileTime[s];
        }
        for (const load of capture.loads(seq)) loads.push({ frame: capture.frameNumber(seq), ...loadJson(load, d.tick[s]) });
    }
    hitches.sort((a, b) => b.interval - a.interval);
    out.hitches = { count: hitches.length, longest: hitches.slice(0, SUMMARY_HITCHES) };
    if (compiles) out.shaderCompiles = { count: compiles, time: round(compileTime) };
    if (loads.length) {
        const timed = loads.filter(load => load.kind !== 'milestone').sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
        const bytes = timed.reduce((sum, load) => sum + (load.bytes ?? 0), 0);
        out.loads = {
            count: timed.length,
            bytes,
            failed: timed.filter(load => load.failed).length,
            longest: timed.slice(0, SUMMARY_LOADS).map(({ frame, kind, name, type, duration, bytes, failed }) => ({
                frame, kind, name, ...(type ? { type } : {}), ...(Number.isFinite(duration) ? { duration: round(duration) } : {}), ...(bytes ? { bytes } : {}), ...(failed ? { failed } : {})
            }))
        };
    }
    return out;
}

/**
 * @param {McpHost} host - The host.
 * @returns {object} Whether the inspector is recording, what it keeps, its options and whether the
 * page is visible.
 */
function perfStatus(host) {
    const perf = host.perf;
    const capture = perf.capture;
    /** @type {any} */
    const out = {
        recording: capture.recording,
        frames: capture.count,
        capacity: capture.capacity,
        recordedBy: capture.count || capture.recording ? (perf.byAgent ? 'agent' : 'user') : null
    };
    if (capture.count) out.range = { from: capture.frameNumber(capture.first), to: capture.frameNumber(capture.end - 1) };
    const session = perf.session;
    if (session) out.framesLeft = Math.max(0, session.target - capture.end);
    out.options = {
        gpuTimings: perf.gpuTimings(),
        gpuTimingsSupported: perf.gpuSupported(),
        scriptTiming: capture.timeScripts,
        scriptTimingSupported: capture.supports.scripts,
        engineBuild: capture.detailed ? 'profiler or debug' : 'release'
    };
    out.visibility = visibility();
    if (session?.hidden) out.hiddenWhileRecording = true;
    if (perf.paused()) out.paused = true;
    return out;
}

/**
 * Ends the recording the tools stop after a number of frames, telling a caller waiting for it why.
 * Stops recording too, unless only letting go of it.
 *
 * @param {McpHost} host - The host.
 * @param {string} reason - Why it ended.
 * @param {boolean} [stop] - Whether to stop recording.
 */
function endPerfSession(host, reason, stop = true) {
    const perf = host.perf;
    const session = perf.session;
    if (!session) return;
    perf.session = null;
    host.app.off('frameupdate', session.onFrame);
    clearTimeout(session.timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', session.onVisibility);
    if (stop && perf.capture.recording) perf.setRecording(false);
    session.done?.(reason);
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - How many frames to record, the options, whether to clear what is kept, and
 * whether to wait.
 * @returns {Promise<object>|object} Once the frames are recorded, how recording ended and the
 * summary of the frames recorded; or, without waiting, the status.
 */
function perfRecord(host, args) {
    const perf = host.perf;
    const capture = perf.capture;
    const userFrames = !perf.byAgent && (capture.count > 0 || capture.recording);
    if (userFrames && args.clear === undefined) {
        throw new Error(`The user ${capture.recording ? 'is recording' : `recorded the ${capture.count} frames kept`}. ` +
            'Pass clear: true to discard them and record afresh, or clear: false to add to them');
    }
    if (args.gpuTimings && !perf.gpuSupported()) throw new Error('This device cannot time the GPU');
    if (args.scriptTiming && !capture.supports.scripts) throw new Error('This app has no script system to time');

    endPerfSession(host, 'restarted', false);
    if (args.clear ?? true) {
        if (capture.recording) perf.setRecording(false);
        perf.clear();
    }
    if (args.gpuTimings !== undefined) perf.setGpuTimings(args.gpuTimings);
    if (args.scriptTiming !== undefined) perf.setScriptTiming(args.scriptTiming);
    if (!capture.recording) perf.setRecording(true);
    perf.byAgent = true;

    if (!args.frames) return { ...perfStatus(host), note: 'Recording until playcanvas_perf_stop, keeping the last frames up to the capacity' };

    const from = capture.end;
    /** @type {PerfSession} */
    const session = {
        from,
        target: from + args.frames,
        hidden: visibility() === 'hidden',
        onFrame: () => {
            // the capture completes a frame as the next begins, so it has it by now
            if (!capture.recording) endPerfSession(host, 'stopped from the panel', false);
            else if (capture.end >= session.target) endPerfSession(host, 'recorded');
        },
        onVisibility: () => {
            if (visibility() === 'hidden') session.hidden = true;
        },
        timer: setTimeout(() => endPerfSession(host, 'timed out'), (args.timeout ?? PERF_TIMEOUT) * 1000),
        done: null
    };
    perf.session = session;
    host.app.on('frameupdate', session.onFrame);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', session.onVisibility);

    if (args.wait === false) return { ...perfStatus(host), note: `Recording ${args.frames} frames, then stopping` };
    return new Promise((resolve) => {
        session.done = (reason) => {
            const recorded = capture.end - Math.max(from, capture.first);
            /** @type {any} */
            const out = { ended: reason, frames: recorded };
            if (reason === 'timed out') {
                out.note = `Only ${recorded} of ${args.frames} frames were recorded in ${args.timeout ?? PERF_TIMEOUT} s: ` +
                    'frames stop while the page is hidden, and slow down while the app is paused or busy';
            }
            if (recorded > 0) out.summary = perfSummary(host, Math.max(from, capture.first), capture.end - 1);
            else out.status = perfStatus(host);
            resolve(out);
        };
    });
}

/**
 * @param {McpHost} host - The host.
 * @returns {object} The summary of every frame kept, once recording is stopped.
 */
function perfStop(host) {
    const perf = host.perf;
    endPerfSession(host, 'stopped');
    if (perf.capture.recording) perf.setRecording(false);
    if (!perf.capture.count) return perfStatus(host);
    return perfSummary(host, perf.capture.first, perf.capture.end - 1);
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - The frames, and whether to count the inspector's time.
 * @returns {object} The summary.
 */
function perfSummaryTool(host, args) {
    const { from, to } = rangeOf(host.perf.capture, args);
    return perfSummary(host, from, to, args.includeInspector === true);
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - The frame number.
 * @returns {object} Everything recorded for the frame.
 */
function perfFrame(host, args) {
    const capture = host.perf.capture;
    const seq = seqOf(capture, args.frame);
    if (!capture.has(seq)) {
        throw new Error(capture.count ?
            `Frame ${args.frame} is not kept. Frames kept: ${capture.frameNumber(capture.first)} to ${capture.frameNumber(capture.end - 1)}` :
            'Nothing is recorded: start a capture with playcanvas_perf_record');
    }
    return frameJson(capture, seq);
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - The series, the frames and the format.
 * @returns {object|string} The rows of the series, as JSON or CSV.
 */
function perfSeries(host, args) {
    const capture = host.perf.capture;
    const range = rangeOf(capture, args);
    // a series with a row per frame stops after the most rows; the others, which skip frames, are
    // bounded by the frames kept
    const to = PERF_SERIES.indexOf(args.key) < Object.keys(SERIES).length ? Math.min(range.to, range.from + MAX_SERIES_ROWS - 1) : range.to;
    const rows = seriesRows(capture, args.key, range.from, to);
    /** @type {any} */
    const out = { series: args.key, range: { from: capture.frameNumber(range.from), to: capture.frameNumber(to) } };
    if (to < range.to) out.next = capture.frameNumber(to + 1);
    if (args.format === 'csv') out.csv = toCsv(rows);
    else out.rows = rows;
    return out;
}

/**
 * The tools of the inspector. None of them changes the app: most only read it, and the perf tools
 * drive the inspector's own capture.
 *
 * @type {McpToolImpl[]}
 */
/**
 * @param {McpHost} host - The host.
 * @param {any} args - Which messages.
 * @returns {object} The messages logged since the tools were turned on, newest last.
 */
function logs(host, args) {
    const capture = host.logs;
    const level = args.level ?? 'log';
    const allowed = new Set(LEVELS.slice(0, LEVELS.indexOf(level) + 1));
    const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
    const since = args.since ?? 0;
    const limit = clampInt(args.limit, 100, MAX_LIMIT);
    const counts = Object.fromEntries(LEVELS.map(l => [l, 0]));
    const matching = [];
    for (const entry of capture.entries) {
        // the counts cover the same messages as the entries, every level of them
        if (entry.seq <= since) continue;
        counts[entry.level] += entry.count;
        if (!allowed.has(entry.level)) continue;
        if (filter && !entry.text.toLowerCase().includes(filter)) continue;
        matching.push(entry);
    }
    const oldest = capture.entries[0]?.seq ?? capture.seq + 1;
    const out = {
        capturing: capture.capturing,
        // the newest of what matches, when there is more than the limit
        entries: matching.slice(-limit),
        total: matching.length,
        truncated: matching.length > limit,
        next: capture.seq,
        counts
    };
    if (since && since < oldest - 1) out.dropped = `Messages after ${since} up to ${oldest - 1} were dropped: only the last 1000 are kept`;
    return out;
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - What to capture.
 * @returns {Promise<object>} The image, under $image, with what it shows.
 */
async function screenshot(host, args) {
    const maxSize = args.maxSize ?? (args.id ? 512 : 1024);
    if (!args.id) {
        const image = await host.images().canvas({ maxSize });
        const device = host.app.graphicsDevice;
        return { $image: { mimeType: 'image/png', data: image.png }, width: image.width, height: image.height, source: { kind: 'canvas', width: device.width, height: device.height } };
    }

    const obj = host.refs.get(args.id);
    if (!obj) throw new Error(`No object with id "${args.id}": it is unknown, or the app has let go of it`);
    let texture = null;
    let attachment;
    if (obj instanceof Texture) {
        texture = obj;
    } else if (obj instanceof RenderTarget) {
        attachment = args.attachment ?? (obj.colorBuffer ? 'color0' : 'depth');
        texture = attachment === 'depth' ? obj.depthBuffer : obj.getColorBuffer(Number(attachment.slice(5)));
        if (!texture) throw new Error(`The render target has no ${attachment} attachment${obj.depth && !obj.depthBuffer ? ' it can be read from: its depth is a renderbuffer, not a texture' : ''}`);
    } else {
        throw new Error(`A screenshot takes the id of a texture or a render target, or no id for the canvas, not a ${obj.constructor?.name ?? 'value'}`);
    }

    const channels = args.channels ?? 'rgb';
    const image = await host.images().texture(texture, { maxSize, channels });
    const source = { $id: args.id, $type: obj.constructor?.name, name: obj.name, width: texture.width, height: texture.height, format: texture.format };
    if (attachment) source.attachment = attachment;
    if (channels !== 'rgb') source.channels = channels;
    return { $image: { mimeType: 'image/png', data: image.png }, width: image.width, height: image.height, source };
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - Whether to pause.
 * @returns {object} Whether the app is paused, and its frame.
 */
function pause(host, args) {
    host.time.setPaused(args.paused);
    return { paused: host.time.paused(), frame: host.time.frame() };
}

/**
 * @param {McpHost} host - The host.
 * @param {any} args - How many frames.
 * @returns {Promise<object>} How many frames ran, and the frame the app is paused on.
 */
async function step(host, args) {
    const frames = args.frames ?? 1;
    const from = host.time.frame();
    const ran = await host.time.step(frames, (args.timeout ?? 10) * 1000);
    const out = { paused: true, stepped: ran, frame: host.time.frame(), from };
    if (ran < frames) out.note = `Only ${ran} of ${frames} frames ran before the timeout: frames stop while the page is hidden`;
    return out;
}

const TOOLS = [{
    name: 'playcanvas_app_summary',
    description: 'Summarize the running PlayCanvas app: engine version, graphics device and its video memory, ' +
        'entity and asset counts, frame stats, the id of the scene root, and the lists playcanvas_list can return.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: appSummary
}, {
    name: 'playcanvas_index',
    description: 'Index everything the app holds in one call, to start from: the summary, every entity with its ' +
        'id, path and components, and every camera, material, texture, shader, mesh, render target, script class, ' +
        'asset and frame-graph pass with its id and the figures its list shows, such as size and format. Pass ' +
        'the ids to playcanvas_get for the details. Each list holds up to 2000 entries.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: index
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
}, {
    name: 'playcanvas_perf_record',
    description: 'Start recording frames on the inspector\'s Performance tab: CPU update and render times, GPU time ' +
        'per pass, script times, draw calls, memory, hitches and loads, a frame each, keeping the last 1000. ' +
        'With frames, it stops by itself after that many and, unless wait is false, returns the summary of ' +
        'those frames; it gives up after timeout seconds, as frames stop while the page is hidden. Without ' +
        'frames, it records until playcanvas_perf_stop. gpuTimings and scriptTiming turn those timings on or ' +
        'off; script timing costs about half a microsecond a script call, counted as the inspector\'s time. A ' +
        'capture the user recorded is not discarded unless clear is true; clear: false adds to what is kept. ' +
        'Changes the inspector\'s capture and switches, never the app.',
    inputSchema: {
        type: 'object',
        properties: {
            frames: { type: 'integer', minimum: 1, maximum: 1000, description: 'Stop after this many frames.' },
            gpuTimings: { type: 'boolean', description: 'Time the GPU passes, where the device can.' },
            scriptTiming: { type: 'boolean', description: 'Time each script type.' },
            clear: { type: 'boolean', description: 'Discard the frames kept first. Defaults to true, but a capture the user recorded is only discarded when this is given.' },
            wait: { type: 'boolean', default: true, description: 'With frames, wait for them and return their summary.' },
            timeout: { type: 'integer', minimum: 1, maximum: MAX_PERF_TIMEOUT, default: PERF_TIMEOUT, description: 'With frames, the seconds to wait for them before stopping.' }
        }
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    execute: perfRecord
}, {
    name: 'playcanvas_perf_stop',
    description: 'Stop recording frames on the Performance tab, keeping them, and return the summary of every ' +
        'frame kept, as playcanvas_perf_summary does.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false },
    execute: perfStop
}, {
    name: 'playcanvas_perf_status',
    description: 'Whether the Performance tab is recording, how many frames it keeps and which, who recorded ' +
        'them, how many frames a recording of playcanvas_perf_record has left, the timings on, and whether ' +
        'the page is visible, as frames stop while it is hidden.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: perfStatus
}, {
    name: 'playcanvas_perf_summary',
    description: 'Summarize the frames recorded, in a few KB: for frame time, CPU update and render, scripts, ' +
        'GPU time, draw calls and memory the min, average, 95th percentile and max, the GPU passes and script ' +
        'types that took longest, the hitches (frames over twice the median), what loaded and the shader ' +
        'compiles. Times are in ms, memory in bytes. The CPU figures leave out the inspector\'s own time ' +
        'unless includeInspector is true. from and to pick frames by number; then use playcanvas_perf_frame ' +
        'for one frame in full and playcanvas_perf_series for a figure frame by frame.',
    inputSchema: {
        type: 'object',
        properties: {
            from: { type: 'integer', minimum: 0, description: 'The first frame, by number. Defaults to the first kept.' },
            to: { type: 'integer', minimum: 0, description: 'The last frame, by number. Defaults to the last kept.' },
            includeInspector: { type: 'boolean', default: false, description: 'Count the inspector\'s own time in the CPU figures.' }
        }
    },
    annotations: { readOnlyHint: true },
    execute: perfSummaryTool
}, {
    name: 'playcanvas_perf_frame',
    description: 'Everything recorded for one frame, by number: CPU phases, GPU passes in the order they ran ' +
        'with the effect running each, script types, draw calls, memory, resources, shader compiles, events, ' +
        'counters and loads. Times are in ms, memory in bytes.',
    inputSchema: {
        type: 'object',
        properties: {
            frame: { type: 'integer', minimum: 0, description: 'The frame number, as the summary and series name frames.' }
        },
        required: ['frame']
    },
    annotations: { readOnlyHint: true },
    execute: perfFrame
}, {
    name: 'playcanvas_perf_series',
    description: 'One figure frame by frame, a row per frame: frame (the frame interval), cpu (its phases), gpu ' +
        '(a column per pass), draws, memory or resources; or scripts (a column per script type, frames timed ' +
        'only), counters (app.stats.user), loading (a row per load) or events (frames with any). A series with ' +
        `a row per frame returns up to ${MAX_SERIES_ROWS} rows; next is the frame to continue from. format csv ` +
        'returns the rows as CSV text, which is smaller.',
    inputSchema: {
        type: 'object',
        properties: {
            key: { type: 'string', enum: PERF_SERIES },
            from: { type: 'integer', minimum: 0, description: 'The first frame, by number. Defaults to the first kept.' },
            to: { type: 'integer', minimum: 0, description: 'The last frame, by number. Defaults to the last kept.' },
            format: { type: 'string', enum: ['json', 'csv'], default: 'json' }
        },
        required: ['key']
    },
    annotations: { readOnlyHint: true },
    execute: perfSeries
}, {
    name: 'playcanvas_logs',
    description: 'The messages the page logged to the console since the MCP tools were turned on, and the errors ' +
        'nothing caught: the engine\'s warnings and errors (in a debug build), shader compile errors, failed loads and ' +
        'the app\'s own messages. Newest last; a message repeated in a row is counted, not repeated. level is the least ' +
        'severe level returned (error, warn, info, log, debug). Pass the next number returned as since to get only ' +
        'what was logged after, such as around a step to reproduce; counts then cover only those messages too.',
    inputSchema: {
        type: 'object',
        properties: {
            level: { type: 'string', enum: LEVELS, default: 'log', description: 'The least severe level returned.' },
            filter: { type: 'string', description: 'Only messages containing this, case-insensitive.' },
            since: { type: 'integer', minimum: 0, description: 'Only messages numbered after this.' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 100 }
        }
    },
    annotations: { readOnlyHint: true },
    execute: logs
}, {
    name: 'playcanvas_screenshot',
    description: 'Capture an image. Without id, what the canvas shows. With the id of a texture or a render target ' +
        '(from playcanvas_list or playcanvas_get), that texture, or an attachment of the target, as the inspector ' +
        'previews it: encoded and HDR textures decoded, depth as grayscale, a single channel as grayscale. channels ' +
        'shows stored channels instead, such as "aaa" for alpha. Returns a PNG image.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'A texture or render target id. Omit for the canvas.' },
            attachment: { type: 'string', enum: ['color0', 'color1', 'color2', 'color3', 'color4', 'color5', 'color6', 'color7', 'depth'], description: 'The attachment of a render target. Defaults to color0, or depth for a depth-only target.' },
            channels: { type: 'string', pattern: '^[rgba]{3}$', default: 'rgb', description: 'Three of r, g, b and a: stored channels to show. rgb decodes the texture.' },
            maxSize: { type: 'integer', minimum: 16, maximum: 2048, description: 'The longest side of the image, at most. Defaults to 512 for a texture and 1024 for the canvas.' }
        }
    },
    annotations: { readOnlyHint: true },
    execute: screenshot
}, {
    name: 'playcanvas_pause',
    description: 'Pause or resume the app, as the inspector\'s Pause button does: time stands still while it keeps ' +
        'rendering, so what is on screen and in the lists holds still. Use playcanvas_step to move on frame by frame.',
    inputSchema: {
        type: 'object',
        properties: { paused: { type: 'boolean' } },
        required: ['paused']
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    execute: pause
}, {
    name: 'playcanvas_step',
    description: 'Run frames with time moving, then hold the app paused: pauses it first if it is not. Returns once ' +
        'the frames have run, or after timeout seconds, as frames stop while the page is hidden.',
    inputSchema: {
        type: 'object',
        properties: {
            frames: { type: 'integer', minimum: 1, maximum: 600, default: 1 },
            timeout: { type: 'integer', minimum: 1, maximum: 120, default: 10 }
        }
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    execute: step
}];

export { TOOLS, endPerfSession, validate };
