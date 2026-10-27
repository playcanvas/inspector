import { EVENT_KINDS, captureNorms, eventLines, eventMask, isHitch, rangeStats } from './perf-view.js';

/** @import { PerfCapture } from './perf-capture.js' */

/**
 * The series a chart, or a section under the charts, copies: the figures of each frame, by the
 * name they are copied under and the channel they are read from.
 *
 * @type {Record<string, [string, string][]>}
 */
const SERIES = {
    frame: [['interval', 'interval']],
    cpu: [
        ['total', 'cpu'], ['update', 'update'], ['systems', 'cpuSystems'], ['physics', 'physics'],
        ['animation', 'anim'], ['postUpdate', 'post'], ['otherUpdate', 'cpuOther'], ['render', 'render'],
        ['inspector', 'inspector']
    ],
    gpu: [['gpu', 'gpu']],
    draws: [
        ['total', 'draws'], ['forward', 'drawsForward'], ['shadow', 'drawsShadow'], ['other', 'drawsMisc'],
        ['skinned', 'drawsSkinned'], ['primitives', 'primitives'], ['materialSwitches', 'materialSwitches'],
        ['shaderSwitches', 'shaderSwitches'], ['computeDispatches', 'dispatches'], ['computePasses', 'computePasses']
    ],
    memory: [
        ['jsHeap', 'heap'], ['video', 'vram'], ['textures', 'vramTex'], ['vertexBuffers', 'vramVb'],
        ['indexBuffers', 'vramIb'], ['uniformBuffers', 'vramUb'], ['storageBuffers', 'vramSb']
    ],
    resources: [
        ['textures', 'textures'], ['renderTargets', 'targets'], ['shaders', 'shaders'], ['buffers', 'buffers'],
        ['pipelines', 'pipelines']
    ]
};

// the render phases a profiler or debug engine times, by the name they are copied under
const RENDER_PHASES = [
    ['culling', 'cull'], ['sorting', 'sort'], ['skinning', 'skin'], ['morphing', 'morph'],
    ['shadowMaps', 'shadows'], ['forward', 'forward'], ['lightClusters', 'clusters']
];

/**
 * Sets the figures of a frame on an object, leaving out those the engine did not provide.
 *
 * @param {object} out - The object.
 * @param {PerfCapture} capture - The capture.
 * @param {number} slot - The slot of the frame.
 * @param {[string, string][]} figures - The names to set and the channels to read.
 * @returns {object} The object.
 */
function put(out, capture, slot, figures) {
    for (const [name, key] of figures) {
        const v = capture.data[key][slot];
        if (Number.isFinite(v)) out[name] = v;
    }
    return out;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {number} seq - A kept frame.
 * @returns {Record<string, number>} Its GPU passes by name, empty until its timings resolved.
 */
function passesOf(capture, seq) {
    /** @type {Record<string, number>} */
    const passes = {};
    for (const pass of capture.passesInOrder(seq)) passes[pass.name] = pass.time;
    return passes;
}

/**
 * Everything recorded for a frame. Durations are in milliseconds, memory in bytes; a figure the
 * engine did not provide is left out.
 *
 * @param {PerfCapture} capture - The capture.
 * @param {number} seq - A kept frame.
 * @returns {object} The frame.
 */
function frameJson(capture, seq) {
    const d = capture.data;
    const s = capture.slot(seq);
    const first = capture.slot(capture.first);
    /** @type {any} */
    const frame = { frame: seq + 1 };
    put(frame, capture, s, [['appFrame', 'appFrame']]);
    frame.time = (d.tick[s] - d.tick[first]) / 1000;
    frame.rendered = d.version[s] >= 0;
    put(frame, capture, s, SERIES.frame);
    frame.hitch = isHitch(capture, seq, captureNorms(capture).median);

    frame.cpu = put({}, capture, s, SERIES.cpu);
    if (capture.detailed) frame.cpu.renderPhases = put({}, capture, s, RENDER_PHASES);
    if (d.splatSort[s] > 0) frame.cpu.splatSortOnWorker = d.splatSort[s];

    if (Number.isFinite(d.gpu[s])) frame.gpu = { frame: d.gpu[s], passes: passesOf(capture, seq) };
    frame.draws = put({}, capture, s, SERIES.draws);
    frame.memory = put({}, capture, s, SERIES.memory);
    frame.resources = put({}, capture, s, SERIES.resources);
    if (d.compiles[s] > 0) frame.shaderCompiles = { count: d.compiles[s], time: d.compileTime[s] };

    const events = capture.events(seq);
    if (events.length) {
        frame.events = events.map(event => ({
            kind: event.kind,
            name: event.name,
            start: event.start - d.tick[s],
            duration: event.duration,
            ...(event.detail ? { detail: event.detail } : {})
        }));
    }
    return frame;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {number} from - The first frame.
 * @param {number} to - The last frame, inclusive.
 * @returns {object} What the frames have in common: how many, and the norms they are judged by.
 */
function header(capture, from, to) {
    const { budget, median } = captureNorms(capture);
    return {
        range: { from: from + 1, to: to + 1, frames: to - from + 1 },
        medianFrame: median,
        displayInterval: budget,
        engineBuild: capture.detailed ? 'profiler or debug' : 'release',
        gpuTimingsExact: capture.gpuExact
    };
}

/**
 * The whole capture, or a span of it: a header and every frame.
 *
 * @param {PerfCapture} capture - The capture.
 * @param {number} from - The first frame.
 * @param {number} to - The last frame, inclusive.
 * @param {object} [device] - What to say about the device.
 * @returns {object} The capture.
 */
function captureJson(capture, from, to, device) {
    const frames = [];
    for (let seq = from; seq <= to; seq++) frames.push(frameJson(capture, seq));
    return { ...header(capture, from, to), ...(device ? { device } : {}), frames };
}

/**
 * The series of a chart or section, a row per frame: the frame and its figures. The GPU series
 * has a column per pass, and the events series lists only the frames that had events, with what
 * happened by kind.
 *
 * @param {PerfCapture} capture - The capture.
 * @param {string} key - The chart or section: 'frame', 'cpu', 'gpu', 'draws', 'memory',
 * 'resources' or 'events'.
 * @param {number} from - The first frame.
 * @param {number} to - The last frame, inclusive.
 * @returns {object[]} The rows.
 */
function seriesRows(capture, key, from, to) {
    const rows = [];
    for (let seq = from; seq <= to; seq++) {
        const s = capture.slot(seq);
        if (key === 'events') {
            const mask = eventMask(capture, seq);
            if (!mask) continue;
            /** @type {any} */
            const row = { frame: seq + 1 };
            EVENT_KINDS.forEach((kind, i) => {
                if (mask & (1 << i)) row[kind.key] = eventLines(capture, seq, kind.key);
            });
            rows.push(row);
            continue;
        }
        /** @type {any} */
        const row = put({ frame: seq + 1 }, capture, s, SERIES[key]);
        if (key === 'cpu' && capture.detailed) put(row, capture, s, RENDER_PHASES);
        if (key === 'gpu') {
            for (const [name, time] of Object.entries(passesOf(capture, seq))) row[`pass ${name}`] = time;
        }
        rows.push(row);
    }
    return rows;
}

/**
 * @param {*} value - A cell.
 * @returns {string} The cell as CSV: numbers at full precision, lists joined, text quoted when it
 * has to be.
 */
function csvCell(value) {
    if (value === undefined || value === null) return '';
    const text = Array.isArray(value) ? value.join('; ') : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {object[]} rows - Rows of the same kind, as {@link seriesRows} makes them.
 * @returns {string} The rows as CSV, with a header of every column any row has, in the order
 * they first appear.
 */
function toCsv(rows) {
    const columns = [];
    const seen = new Set();
    for (const row of rows) {
        for (const column of Object.keys(row)) {
            if (!seen.has(column)) {
                seen.add(column);
                columns.push(column);
            }
        }
    }
    const lines = [columns.map(csvCell).join(',')];
    for (const row of rows) lines.push(columns.map(column => csvCell(row[column])).join(','));
    return `${lines.join('\n')}\n`;
}

/**
 * The figures of frames selected together: their averages, 95th percentiles and largest.
 *
 * @param {PerfCapture} capture - The capture.
 * @param {number} from - The first frame.
 * @param {number} to - The last frame, inclusive.
 * @returns {object} The figures.
 */
function rangeJson(capture, from, to) {
    const { median } = captureNorms(capture);
    let hitches = 0;
    for (let seq = from; seq <= to; seq++) {
        if (isHitch(capture, seq, median)) hitches++;
    }
    const stats = (key) => {
        const { count, avg, p95, max } = rangeStats(capture, key, from, to);
        return count ? { avg, p95, max } : null;
    };
    const interval = stats('interval');
    /** @type {any} */
    const out = { ...header(capture, from, to), fps: interval ? 1000 / interval.avg : null, hitches };
    for (const [name, key] of [['interval', 'interval'], ['cpu', 'cpu'], ['gpu', 'gpu'], ['inspector', 'inspector'], ['draws', 'draws'], ['videoMemory', 'vram'], ['jsHeap', 'heap']]) {
        const figure = stats(key);
        if (figure) out[name] = figure;
    }
    return out;
}

export { SERIES, captureJson, frameJson, rangeJson, seriesRows, toCsv };
