import { formatBytes, makeSection } from './model.js';
import { SCRIPT_CALLS, SCRIPT_STRIDE } from './perf-capture.js';

/** @import { PerfCapture, PerfGpuPass, PerfLoad } from './perf-capture.js' */
/** @import { Described } from './describe.js' */
/** @import { PropertyRow, PropertySection } from './model.js' */

/**
 * @typedef {object} PerfPart
 * @ignore
 * @property {string} key - A key unique among the parts.
 * @property {string} name - The display name.
 * @property {string} color - The CSS color it is drawn in.
 * @property {string} channel - The channel of the capture holding it, which the charts read
 * directly: a call per bar would box every figure it returns.
 * @property {string} [tip] - What it covers.
 */

/**
 * @typedef {object} PerfRangeStats
 * @ignore
 * @property {number} count - How many frames had the figure.
 * @property {number} avg - The mean.
 * @property {number} p95 - The 95th percentile.
 * @property {number} max - The largest.
 */

/**
 * @typedef {object} PerfSelection
 * @ignore
 * @property {PerfCapture} capture - The capture.
 * @property {number} seq - The frame shown, or -1 for none.
 * @property {{ from: number, to: number }|null} range - The frames selected together, inclusive,
 * or null.
 * @property {{ supported: boolean, enabled: boolean, enable: () => void }} gpu - The GPU profiler:
 * whether the device has one, whether it is on, and how to turn it on.
 * @property {{ enabled: boolean, enable: () => void, rows?: number, pinned?: ReadonlySet<string>, pin?: (name: string) => void }} [scripts] - Script
 * timing: whether it is on and how to turn it on; how many of the longest script types the
 * Scripts chart gives a band of their own, besides those pinned; the names of those pinned; and
 * how to pin or unpin one.
 */

/**
 * @typedef {object} PerfScriptLegend
 * @ignore
 * @property {{ id: number, name: string, color: string, pinned: boolean }[]} types - The script
 * types with a band of their own in the Scripts chart, top down: those pinned, then the longest of
 * the others, each by its index into {@link PerfCapture#scriptNames}.
 * @property {Map<number, string>} colors - The color of each of them, by id.
 * @property {number} others - How many more types took time, sharing one band.
 * @property {string} signature - The types in order, telling when the bands change.
 */

/**
 * The main-thread CPU time of a frame, part by part, bottom up as the CPU chart stacks them. They
 * add up to the update and the render, which hold the rest.
 *
 * @type {PerfPart[]}
 */
const CPU_PARTS = [
    {
        key: 'systems',
        name: 'Systems',
        color: '#3d8bff',
        tip: 'Component systems updating, with the scripts unless they are timed apart',
        channel: 'cpuSystems'
    },
    { key: 'scripts', name: 'Scripts', color: '#ffcc00', tip: 'Scripts updating and post-updating, while Script timing is on', channel: 'scripts' },
    { key: 'physics', name: 'Physics', color: '#ff9500', tip: 'The physics step, part of the systems update', channel: 'physics' },
    { key: 'anim', name: 'Animation', color: '#00c7be', tip: 'Anim components updating', channel: 'anim' },
    { key: 'post', name: 'Post-update', color: '#5ac8fa', tip: 'Systems post-updating, with the scripts unless they are timed apart', channel: 'cpuPost' },
    {
        key: 'other',
        name: 'Other update',
        color: '#af52de',
        tip: 'Update event listeners of the app and input devices',
        channel: 'cpuOther'
    },
    { key: 'render', name: 'Render', color: '#4cd964', tip: 'Culling, sorting and submitting the draws of every camera', channel: 'render' },
    { key: 'inspector', name: 'Inspector', color: '#8e8e93', tip: 'The inspector itself, inside the update', channel: 'inspector' }
];

/**
 * The render phases a profiler or debug engine times, part of the render.
 *
 * @type {[string, string][]}
 */
const RENDER_PHASES = [
    ['cull', 'Culling'], ['sort', 'Sorting'], ['skin', 'Skinning'], ['morph', 'Morphing'],
    ['shadows', 'Shadow maps'], ['forward', 'Forward'], ['clusters', 'Light clusters']
];

/**
 * @typedef {object} PerfEventKind
 * @ignore
 * @property {string} key - A key unique among the kinds.
 * @property {string} name - The display name.
 * @property {string} [short] - The name beside the charts, where the display name is too long.
 * @property {string} color - The CSS color its marks are drawn in.
 * @property {string} tip - What it marks.
 */

/**
 * What the events of a frame can be, each a row of its own under the charts.
 *
 * @type {PerfEventKind[]}
 */
const EVENT_KINDS = [
    {
        key: 'hitch',
        name: 'Hitches',
        color: '#ff3b30',
        tip: 'Frames that took over twice as long as the median frame, whatever held them back: what the user sees stutter. One ' +
            'also marked Thread blocked was held back by work on the main thread, one without it by the GPU, the browser or the ' +
            'display. Hover a hitch to see which'
    },
    {
        key: 'long',
        name: 'Main thread blocked',
        // what fits beside the charts
        short: 'Thread blocked',
        color: '#ff2d92',
        tip: 'Frames in which the browser\'s main thread was busy for 50 ms or more, with the script that ran longest, as Chromium ' +
            'browsers report them (long animation frames). It says why a frame was slow rather than whether it was: a shorter ' +
            'stall is not reported, and in an app slower than 50 ms a frame can be marked without being a hitch. It covers the ' +
            'work between frames too, as while loading'
    },
    { key: 'compile', name: 'Shaders', color: '#ff9500', tip: 'Shaders compiled or created, and render pipelines created' },
    { key: 'gc', name: 'Heap shrank', color: '#ffcc00', tip: 'The JavaScript heap shrank: a garbage collection' },
    { key: 'resource', name: 'Resources', color: '#3d8bff', tip: 'Textures, render targets or buffers created or destroyed' },
    { key: 'marker', name: 'Measures', color: '#e5e5ea', tip: 'Spans the app measured with performance.measure' }
];

// the bit of each kind of event in a frame's mask
const EVENT_BITS = Object.fromEntries(EVENT_KINDS.map((kind, i) => [kind.key, 1 << i]));

// how much the heap has to shrink between frames to count as collected
const GC_BYTES = 1024 * 1024;

// the resources whose changes are events, with their names
const RESOURCE_KINDS = [['textures', 'Textures'], ['targets', 'Render targets'], ['buffers', 'Buffers']];

// a frame taking this many times the median frame is a hitch
const HITCH_FACTOR = 2;

// the share of the frame interval a processor has to fill for the frame to be bound by it
const BOUND_SHARE = 0.85;

// how long the browser's main thread is busy in a frame before it reports a long animation frame
const LONG_FRAME = 50;

// room to sort the values of a channel for its percentiles in; longer spans are sampled evenly
const SCRATCH = new Float64Array(4096);

// the colors of the script types with a band of their own, top down; later ones cycle through
// them in lighter and then darker shades. The other types share one
const SCRIPT_COLORS = ['#ffcc00', '#ff6482', '#64d2ff', '#30d158', '#bf5af2', '#ff9f0a', '#0a84ff', '#ff453a', '#66d4cf', '#ac8e68'];
const OTHER_SCRIPTS_COLOR = '#8e8e93';

// the kinds of asset loading is drawn in a color each, by the asset types of each; red is kept
// for the assets that failed
const ASSET_KINDS = [
    { name: 'Textures', color: '#ff9f0a', types: ['texture', 'textureatlas', 'cubemap'] },
    { name: 'Models', color: '#30d158', types: ['container', 'model', 'render'] },
    { name: 'Gaussian splats', color: '#0a84ff', types: ['gsplat'] },
    { name: 'Scripts', color: '#bf5af2', types: ['script'] },
    { name: 'Data', color: '#ffd60a', types: ['json', 'template', 'material'] },
    { name: 'Animations', color: '#66d4cf', types: ['animation'] },
    { name: 'Audio', color: '#64d2ff', types: ['audio'] },
    { name: 'Fonts', color: '#e5e5ea', types: ['font'] },
    { name: 'WebAssembly', color: '#ac8e68', types: ['wasm'] }
];
const ASSET_COLORS = Object.fromEntries(ASSET_KINDS.flatMap(kind => kind.types.map(type => [type, kind.color])));
const ASSET_COLOR = '#8e8e93';
const FAILED_COLOR = '#ff453a';
const REQUEST_COLOR = '#64d2ff';
const MAIN_THREAD_COLOR = '#ff2d92';
const MILESTONE_COLOR = '#e5e5ea';

// how many of the longest script types get a band of their own at first, and how many more each
// Show more adds
const SCRIPT_ROWS = 10;

// no script types pinned, shared
const NO_PINS = /** @type {ReadonlySet<string>} */ (new Set());

// the most script types the frame details list one by one
const MAX_SCRIPT_ROWS = 40;

// a clock coarser than this, in milliseconds, makes the times of single script calls noisy
const COARSE_CLOCK = 0.02;

// the slowest assets and the longest tasks of the main thread the start of the app lists, and the
// assets and the requests a frame lists of each
const STARTUP_ASSETS = 10;
const STARTUP_BLOCKS = 5;
const FRAME_LOADS = 20;

/**
 * The norms of each capture, kept until it records more.
 *
 * @type {WeakMap<PerfCapture, { version: number, norms: { budget: number, median: number } }>}
 */
const normsCache = new WeakMap();

/**
 * The last legend of the Scripts chart made for each capture, kept while nothing it depends on
 * changes: the frames recorded, the frames it ranks over, how many types it lists and those
 * pinned.
 *
 * @type {WeakMap<PerfCapture, { key: string, legend: PerfScriptLegend }>}
 */
const legendCache = new WeakMap();

/**
 * @param {number} ms - A duration in milliseconds, which can be long.
 * @returns {string} The duration in milliseconds below a second, in seconds above.
 */
function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '–';
    return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

/**
 * @param {number} ms - A duration in milliseconds.
 * @returns {string} The duration, to two decimals below ten.
 */
function formatMs(ms) {
    if (!Number.isFinite(ms)) return '–';
    return `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
}

/**
 * @param {number} part - A part.
 * @param {number} whole - The whole.
 * @returns {string} The share, as a whole percentage.
 */
function formatShare(part, whole) {
    return whole > 0 && Number.isFinite(part) ? `${Math.round(100 * part / whole)}%` : '';
}

/**
 * @param {number} value - A count.
 * @returns {string} The count with thousands separators, or a dash when unknown.
 */
function formatCount(value) {
    if (!Number.isFinite(value)) return '–';
    // by hand: toLocaleString goes through Intl, slow for the many counts of a redraw
    const n = Math.round(value);
    const digits = String(Math.abs(n));
    let text = '';
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) text += ',';
        text += digits[i];
    }
    return n < 0 ? `-${text}` : text;
}

/**
 * Sorts the finite values of a channel over a span of frames into the scratch buffer, sampling the
 * span evenly when it holds more frames than the buffer.
 *
 * @param {PerfCapture} capture - The capture.
 * @param {string} key - The channel.
 * @param {number} from - The first frame.
 * @param {number} to - The last frame, inclusive.
 * @returns {Float64Array} The sorted values, a view of the scratch buffer valid until the next call.
 */
function sortedValues(capture, key, from, to) {
    const data = capture.data[key];
    const span = to - from + 1;
    const step = Math.max(1, span / SCRATCH.length);
    let n = 0;
    for (let i = 0; i < span && n < SCRATCH.length; i += step) {
        const value = data[capture.slot(from + Math.floor(i))];
        if (Number.isFinite(value)) SCRATCH[n++] = value;
    }
    return SCRATCH.subarray(0, n).sort();
}

/**
 * @param {Float64Array} sorted - Sorted values.
 * @param {number} q - The quantile, 0 to 1.
 * @returns {number} The value at that quantile, NaN when there are none.
 */
function quantile(sorted, q) {
    if (sorted.length === 0) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * @param {number} n - A count of calls, or their mean over frames.
 * @returns {string} The count, with a decimal for a mean that is not whole.
 */
function callCount(n) {
    return `${Number.isInteger(n) ? formatCount(n) : n.toFixed(1)} ${n === 1 ? 'call' : 'calls'}`;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {string} key - The channel.
 * @param {number} from - The first frame.
 * @param {number} to - The last frame, inclusive.
 * @returns {PerfRangeStats} Its mean, 95th percentile and largest over the frames.
 */
function rangeStats(capture, key, from, to) {
    const data = capture.data[key];
    let count = 0;
    let sum = 0;
    let max = -Infinity;
    for (let seq = from; seq <= to; seq++) {
        const value = data[capture.slot(seq)];
        if (!Number.isFinite(value)) continue;
        count++;
        sum += value;
        if (value > max) max = value;
    }
    const sorted = sortedValues(capture, key, from, to);
    return { count, avg: count ? sum / count : NaN, p95: quantile(sorted, 0.95), max: count ? max : NaN };
}

/**
 * The typical figures of a capture, against which a frame is judged: the frame interval the app
 * manages at best, normally the display's, and the median one.
 *
 * @param {PerfCapture} capture - The capture.
 * @returns {{ budget: number, median: number }} The 5th percentile and the median frame interval,
 * NaN while nothing is recorded.
 */
function captureNorms(capture) {
    const cached = normsCache.get(capture);
    if (cached?.version === capture.version) return cached.norms;
    const sorted = sortedValues(capture, 'interval', capture.first, capture.end - 1);
    const norms = { budget: quantile(sorted, 0.05), median: quantile(sorted, 0.5) };
    normsCache.set(capture, { version: capture.version, norms });
    return norms;
}

/**
 * @param {number} index - The place of a script type among those with a band of their own.
 * @returns {string} Its color: one of {@link SCRIPT_COLORS}, shaded lighter, then darker, on each
 * time round them.
 */
function scriptColorAt(index) {
    const base = SCRIPT_COLORS[index % SCRIPT_COLORS.length];
    const round = Math.floor(index / SCRIPT_COLORS.length);
    if (round === 0) return base;
    const toward = round % 2 ? 255 : 0;
    const amount = Math.min(0.6, Math.ceil(round / 2) * 0.3);
    const channel = i => Math.round(parseInt(base.slice(1 + i * 2, 3 + i * 2), 16) * (1 - amount) + toward * amount);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/**
 * The script types the Scripts chart gives a band of their own: those pinned, then the ones that
 * took the longest over a span of frames, the frames selected together or the whole capture, so a
 * selection around a spike brings forward the scripts behind it.
 *
 * @param {PerfCapture} capture - The capture.
 * @param {number} from - The first frame the types are ranked over.
 * @param {number} to - The last, inclusive.
 * @param {number} rows - How many of the longest types get a band, besides those pinned.
 * @param {ReadonlySet<string>} pinned - The names of the types pinned.
 * @returns {PerfScriptLegend} The legend.
 */
function scriptLegend(capture, from, to, rows, pinned) {
    const key = `${capture.version}|${from}|${to}|${rows}|${[...pinned].join('\n')}`;
    const cached = legendCache.get(capture);
    if (cached?.key === key) return cached.legend;
    const names = capture.scriptNames;
    const totals = new Float64Array(names.length);
    for (let seq = Math.max(from, capture.first); seq <= to && seq < capture.end; seq++) {
        const times = capture.scriptFigures(seq);
        if (!times) continue;
        for (let base = 0, id = 0; base < times.length; base += SCRIPT_STRIDE, id++) {
            totals[id] += times[base] + times[base + 1] + times[base + 2];
        }
    }
    const ids = [];
    for (let id = 0; id < names.length; id++) {
        if (totals[id] > 0 || pinned.has(names[id])) ids.push(id);
    }
    ids.sort((a, b) => totals[b] - totals[a]);
    /** @type {PerfScriptLegend['types']} */
    const types = [];
    for (const id of ids) {
        if (pinned.has(names[id])) types.push({ id, name: names[id], color: '', pinned: true });
    }
    let others = 0;
    let ranked = 0;
    for (const id of ids) {
        if (pinned.has(names[id])) continue;
        if (ranked < rows) {
            types.push({ id, name: names[id], color: '', pinned: false });
            ranked++;
        } else {
            others++;
        }
    }
    const colors = new Map();
    types.forEach((type, i) => {
        type.color = scriptColorAt(i);
        colors.set(type.id, type.color);
    });
    const legend = { types, colors, others, signature: types.map(type => type.id).join(',') };
    legendCache.set(capture, { key, legend });
    return legend;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {number} seq - A kept frame.
 * @param {number} median - The median frame interval of the capture.
 * @returns {boolean} Whether the frame took far longer than the median frame.
 */
function isHitch(capture, seq, median) {
    return capture.get('interval', seq) > HITCH_FACTOR * median;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {number} seq - A kept frame.
 * @returns {number} The kinds of event the frame had, a bit per kind of {@link EVENT_KINDS} in
 * its order.
 */
function eventMask(capture, seq) {
    const d = capture.data;
    const s = capture.slot(seq);
    const p = capture.has(seq - 1) ? capture.slot(seq - 1) : -1;
    // called for every frame on every redraw of the charts, so it is kept free of garbage
    let mask = isHitch(capture, seq, captureNorms(capture).median) ? EVENT_BITS.hitch : 0;
    const events = capture.events(seq);
    for (let i = 0; i < events.length; i++) {
        const kind = events[i].kind;
        mask |= kind === 'long' ? EVENT_BITS.long : EVENT_BITS.marker;
    }
    if (p < 0) return mask | (d.compiles[s] > 0 ? EVENT_BITS.compile : 0);
    if (d.compiles[s] > 0 || d.shaders[s] > d.shaders[p] || d.pipelines[s] > d.pipelines[p]) mask |= EVENT_BITS.compile;
    if (d.heap[p] - d.heap[s] > GC_BYTES) mask |= EVENT_BITS.gc;
    for (let i = 0; i < RESOURCE_KINDS.length; i++) {
        const values = d[RESOURCE_KINDS[i][0]];
        if (Number.isFinite(values[s]) && values[s] !== values[p]) {
            mask |= EVENT_BITS.resource;
            break;
        }
    }
    return mask;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {number} seq - A kept frame.
 * @param {string} kind - The key of one of the {@link EVENT_KINDS}.
 * @returns {string[]} What the frame's events of that kind were, a line each.
 */
function eventLines(capture, seq, kind) {
    const d = capture.data;
    const s = capture.slot(seq);
    const p = capture.has(seq - 1) ? capture.slot(seq - 1) : -1;
    const at = start => `at +${formatMs(start - d.tick[s])}`;
    const lines = [];
    const change = (key, name) => {
        if (p < 0 || !Number.isFinite(d[key][s]) || d[key][s] === d[key][p]) return;
        const delta = d[key][s] - d[key][p];
        lines.push(`${name} ${formatCount(d[key][p])} → ${formatCount(d[key][s])} (${delta > 0 ? '+' : ''}${delta})`);
    };
    switch (kind) {
        case 'hitch': {
            const { median } = captureNorms(capture);
            if (!isHitch(capture, seq, median)) break;
            lines.push(`${formatMs(d.interval[s])}, ${(d.interval[s] / median).toFixed(1)}× the median frame of ${formatMs(median)}`);
            // whether the main thread held it back, where the browser can tell
            const blocked = capture.events(seq).find(event => event.kind === 'long');
            if (blocked) {
                lines.push(`Main thread blocked ${formatMs(blocked.duration)}, longest script ${blocked.name}`);
            } else if (capture.supports.longFrames && d.interval[s] >= LONG_FRAME) {
                lines.push('Main thread not blocked: the GPU, the browser or the display held it back');
            }
            break;
        }
        case 'long':
            for (const event of capture.events(seq)) {
                if (event.kind !== 'long') continue;
                lines.push(`${formatMs(event.duration)} busy, longest script ${event.name}`);
                if (event.detail) lines.push(event.detail);
            }
            break;
        case 'compile':
            if (d.compiles[s] > 0) lines.push(`${formatCount(d.compiles[s])} shader compiles and links, ${formatMs(d.compileTime[s])}`);
            if (p >= 0 && d.shaders[s] > d.shaders[p]) change('shaders', 'Shaders');
            if (p >= 0 && d.pipelines[s] > d.pipelines[p]) change('pipelines', 'Pipelines');
            break;
        case 'gc':
            if (p >= 0 && d.heap[p] - d.heap[s] > GC_BYTES) {
                lines.push(`JavaScript heap ${formatBytes(d.heap[p])} → ${formatBytes(d.heap[s])}, ${formatBytes(d.heap[p] - d.heap[s])} freed`);
            }
            break;
        case 'resource':
            for (const [key, name] of RESOURCE_KINDS) change(key, name);
            break;
        case 'marker':
            for (const event of capture.events(seq)) {
                if (event.kind === 'marker') lines.push(`${event.name}, ${formatMs(event.duration)} ${at(event.start)}`);
            }
            break;
    }
    return lines;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {string} kind - The key of one of the {@link EVENT_KINDS}.
 * @returns {string} Why the browser or engine cannot report that kind of event, or an empty string
 * when it can.
 */
function eventUnsupported(capture, kind) {
    if (kind === 'long' && !capture.supports.longFrames) return 'This browser does not report when its main thread is blocked: Chromium browsers do';
    if (kind === 'marker' && !capture.supports.measures) return 'This browser does not report measures';
    if (kind === 'gc' && !capture.supports.heap) return 'Only Chromium browsers report the size of the JavaScript heap';
    return '';
}

/**
 * What held a frame back: the processor that was busy for most of it, the display, or neither,
 * when the time went outside the engine.
 *
 * @param {PerfCapture} capture - The capture.
 * @param {number} seq - A kept frame.
 * @param {number} budget - The frame interval the app manages at best.
 * @returns {string} The verdict.
 */
function frameVerdict(capture, seq, budget) {
    const interval = capture.get('interval', seq);
    const cpu = capture.get('cpu', seq);
    const gpu = capture.get('gpu', seq);
    if (gpu >= BOUND_SHARE * interval && gpu >= cpu) return 'GPU-bound';
    if (cpu >= BOUND_SHARE * interval) return 'CPU-bound';
    const busiest = Math.max(cpu, Number.isFinite(gpu) ? gpu : 0);
    if (interval <= budget * 1.15) {
        return `Waiting for the display, ${formatMs(Math.max(0, interval - busiest))} to spare`;
    }
    return Number.isFinite(gpu) ?
        'Time went outside the engine: browser work, garbage collection or other tasks' :
        'CPU not busy; turn GPU timings on to tell whether the GPU held it back';
}

/**
 * @param {string} text - The text.
 * @param {string} [cls] - The value class.
 * @param {number} [raw] - The value described, which a copy takes.
 * @returns {Described} A value.
 */
function value(text, cls = 'num', raw) {
    return raw === undefined ? { text, cls } : { text, cls, raw };
}

/**
 * @param {string} text - A note.
 * @returns {Described} The note, muted.
 */
function note(text) {
    return { text, cls: 'null' };
}

/**
 * @param {number} ms - A duration.
 * @param {number} whole - The frame interval it is a share of.
 * @param {string} [swatch] - The color it is drawn in.
 * @returns {Described} The duration with its share of the frame.
 */
function timing(ms, whole, swatch) {
    const share = formatShare(ms, whole);
    const described = value(`${formatMs(ms)}${share ? ` · ${share}` : ''}`, 'num', Number.isFinite(ms) ? ms : undefined);
    if (swatch) described.swatch = swatch;
    return described;
}

/**
 * @param {number} now - A resource count.
 * @param {number} before - The count a frame earlier, NaN when unknown.
 * @returns {Described} The count, with how it changed.
 */
function countChange(now, before) {
    const delta = now - before;
    const change = Number.isFinite(delta) && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : '';
    return value(`${formatCount(now)}${change}`, 'num', Number.isFinite(now) ? now : undefined);
}

/**
 * @param {PerfLoad} load - A load.
 * @returns {string} What it was: an asset or a request with how long it took, its request and
 * its size, or a moment with when it was.
 */
function loadText(load) {
    if (load.kind === 'milestone') return `${load.name} at ${formatDuration(load.start)}`;
    const took = Number.isFinite(load.start) ? formatMs(load.end - load.start) : 'began before recording';
    // the type first, so the color is never all that tells it
    const parts = [load.kind === 'asset' && load.type ? `${load.name} · ${load.type} · ${took}` : `${load.name} ${took}`];
    if (load.failed) parts.push('failed');
    if (load.kind === 'asset' && Number.isFinite(load.netEnd)) parts.push(`request ${formatMs(load.netEnd - load.netStart)}`);
    if (load.kind === 'request' && Number.isFinite(load.firstByte) && load.firstByte > 0) parts.push(`first byte after ${formatMs(load.firstByte - load.netStart)}`);
    if (load.bytes > 0) parts.push(`${formatBytes(load.bytes)}${load.cached ? ', cached' : ''}`);
    else if (load.cached) parts.push('cached');
    return parts.join(' · ');
}

/**
 * @param {PerfLoad} load - A load.
 * @returns {string} The color it is drawn in.
 */
function loadColor(load) {
    if (load.failed) return FAILED_COLOR;
    if (load.kind === 'asset') return ASSET_COLORS[load.type] ?? ASSET_COLOR;
    if (load.kind === 'request') return REQUEST_COLOR;
    return MILESTONE_COLOR;
}

/**
 * @param {PerfSelection} selection - The selection.
 * @returns {PropertySection} The figures of the selected range of frames.
 */
function rangeSection(selection) {
    const { capture, range } = selection;
    const from = Math.max(capture.first, range.from);
    const to = Math.min(capture.end - 1, range.to);
    const section = makeSection('range', capture.rangeLabel(from, to));
    const interval = rangeStats(capture, 'interval', from, to);
    const { median } = captureNorms(capture);
    let hitches = 0;
    for (let seq = from; seq <= to; seq++) {
        if (isHitch(capture, seq, median)) hitches++;
    }
    const fps = interval.avg > 0 ? ` · ${(1000 / interval.avg).toFixed(1)} fps` : '';
    section.rows.push({ key: 'count', label: 'Frames', value: value(`${formatCount(to - from + 1)}${fps}`, 'num', to - from + 1) });
    section.rows.push({ key: 'hitches', label: 'Hitches', value: value(formatCount(hitches), 'num', hitches) });
    const figure = (key, label, stat, format) => {
        const text = stat.count ? `avg ${format(stat.avg)} · p95 ${format(stat.p95)} · max ${format(stat.max)}` : '–';
        section.rows.push({ key, label, value: stat.count ? { text, cls: 'num', raw: stat } : note('not recorded') });
    };
    figure('interval', 'Frame', interval, formatMs);
    figure('cpu', 'CPU', rangeStats(capture, 'cpu', from, to), formatMs);
    figure('gpu', 'GPU', rangeStats(capture, 'gpu', from, to), formatMs);
    figure('inspector', 'Inspector', rangeStats(capture, 'inspector', from, to), formatMs);
    if (capture.supports.scripts) figure('scripts', 'Scripts', rangeStats(capture, 'scriptsTotal', from, to), formatMs);
    figure('draws', 'Draw calls', rangeStats(capture, 'draws', from, to), formatCount);
    figure('vram', 'Video memory', rangeStats(capture, 'vram', from, to), formatBytes);
    return section;
}

/**
 * @param {PerfLoad} load - An asset, or a request.
 * @returns {number} How long it took; NaN for an asset that began loading before recording did.
 */
function loadTime(load) {
    return load.end - load.start;
}

/**
 * @param {PerfLoad} load - An asset, or a request.
 * @param {number} depth - How deep its row is.
 * @returns {PropertyRow} Its row: what it was, how long it took, for an asset its request and the
 * processing after it, and its size.
 */
function loadRow(load, depth) {
    const took = loadTime(load);
    const parts = [Number.isFinite(took) ? formatMs(took) : 'began before recording'];
    if (load.kind === 'asset' && load.type) parts.unshift(load.type);
    if (load.failed) parts.push('failed');
    if (load.kind === 'asset' && Number.isFinite(load.netEnd)) {
        parts.push(`request ${formatMs(load.netEnd - load.netStart)}`);
        if (Number.isFinite(load.start)) parts.push(`processing ${formatMs(Math.max(0, load.end - load.netEnd))}`);
    }
    if (load.kind === 'request' && load.firstByte > 0) parts.push(`first byte after ${formatMs(load.firstByte - load.netStart)}`);
    if (load.bytes > 0) parts.push(`${formatBytes(load.bytes)}${load.cached ? ', cached' : ''}`);
    else if (load.cached) parts.push('cached');
    const described = value(parts.join(' · '), load.failed ? 'err' : 'num', Number.isFinite(took) ? took : undefined);
    described.swatch = loadColor(load);
    return { key: `${load.kind}:${load.id ?? load.url ?? load.name}:${load.start}`, label: load.name, value: described, depth };
}

/**
 * @param {readonly PerfLoad[]} loads - What loaded in an entry.
 * @returns {{ assets: PerfLoad[], requests: PerfLoad[], milestones: PerfLoad[] }} Its assets and
 * its requests, the longest first, and its moments in their order.
 */
function splitLoads(loads) {
    const byTime = (a, b) => (loadTime(b) || 0) - (loadTime(a) || 0);
    return {
        assets: loads.filter(load => load.kind === 'asset').sort(byTime),
        requests: loads.filter(load => load.kind === 'request').sort(byTime),
        milestones: loads.filter(load => load.kind === 'milestone').sort((a, b) => a.start - b.start)
    };
}

/**
 * @param {PerfLoad[]} requests - Requests.
 * @returns {Described} How many there were, their size and how many came from the cache.
 */
function requestSummary(requests) {
    const bytes = requests.reduce((sum, request) => sum + (request.bytes || 0), 0);
    const cached = requests.filter(request => request.cached).length;
    return value(`${formatCount(requests.length)} · ${formatBytes(bytes)}${cached ? ` · ${formatCount(cached)} from the cache` : ''}`, 'num', requests.length);
}

/**
 * The start of the app, from the page opening to its first frame: how long it took, what the page
 * requested and the assets it loaded, its moments, the slowest assets and the longest tasks of the
 * main thread.
 *
 * @param {PerfCapture} capture - The capture.
 * @param {number} seq - The entry of the start of the app.
 * @returns {PropertySection[]} The sections.
 */
function startupSections(capture, seq) {
    const d = capture.data;
    const s = capture.slot(seq);
    const length = d.width[s];
    const { assets, requests, milestones } = splitLoads(capture.loads(seq));
    /** @type {PropertySection[]} */
    const sections = [];

    const startup = makeSection('frame', 'Startup');
    startup.rows.push({ key: 'length', label: 'First frame', value: value(`${formatDuration(length)} after the page opened`, 'num', length) });
    startup.rows.push({ key: 'requests', label: 'Requests', value: requestSummary(requests) });
    const failed = assets.filter(asset => asset.failed).length;
    const loading = capture.pendingLoads().filter(load => load.start < length).length;
    const parts = [`${formatCount(assets.length - failed)} loaded`];
    if (failed) parts.push(`${formatCount(failed)} failed`);
    if (loading) parts.push(`${formatCount(loading)} still loading`);
    startup.rows.push({ key: 'assets', label: 'Assets', value: value(parts.join(' · '), failed ? 'err' : 'num', assets.length) });
    if (d.compiles[s] > 0) {
        // WebGL compiles lazily, so the device may give no time for them
        const time = d.compileTime[s] > 0 ? ` · ${formatMs(d.compileTime[s])}` : '';
        startup.rows.push({ key: 'compiles', label: 'Shader compiles', value: value(`${formatCount(d.compiles[s])}${time}`, 'num', d.compiles[s]) });
    } else if (!capture.detailed) {
        startup.rows.push({ key: 'compiles', label: 'Shader compiles', value: note('counted by the profiler and debug engines') });
    }
    sections.push(startup);

    if (milestones.length) {
        const moments = makeSection('milestones', 'Milestones');
        for (const load of milestones) {
            const described = value(formatDuration(load.start), 'num', load.start);
            described.swatch = loadColor(load);
            moments.rows.push({ key: `milestone:${load.name}`, label: load.name, value: described });
        }
        sections.push(moments);
    }

    const timed = assets.filter(asset => Number.isFinite(loadTime(asset)));
    if (timed.length) {
        const slowest = makeSection('assets', 'Slowest assets');
        for (const load of timed.slice(0, STARTUP_ASSETS)) slowest.rows.push(loadRow(load, 0));
        if (timed.length > STARTUP_ASSETS) slowest.rows.push({ key: 'more', label: '', value: note(`and ${timed.length - STARTUP_ASSETS} more`) });
        sections.push(slowest);
    }

    const blocks = capture.events(seq).filter(event => event.kind === 'long').sort((a, b) => b.duration - a.duration);
    if (blocks.length) {
        const main = makeSection('main', 'Main thread blocked');
        for (const [n, event] of blocks.slice(0, STARTUP_BLOCKS).entries()) {
            const described = value(`${formatMs(event.duration)} · longest script ${event.name}${event.detail ? ` · ${event.detail}` : ''}`, 'num', event.duration);
            described.swatch = MAIN_THREAD_COLOR;
            main.rows.push({ key: `long:${n}`, label: `At ${formatDuration(event.start)}`, value: described });
        }
        if (blocks.length > STARTUP_BLOCKS) main.rows.push({ key: 'more', label: '', value: note(`and ${blocks.length - STARTUP_BLOCKS} more`) });
        sections.push(main);
    }
    return sections;
}

/**
 * What loaded during a frame: its moments, the assets that finished and the requests that ended.
 *
 * @param {PerfCapture} capture - The capture.
 * @param {number} seq - The frame.
 * @returns {PropertySection|null} The section, or null when nothing loaded.
 */
function loadingSection(capture, seq) {
    const loads = capture.loads(seq);
    if (!loads.length) return null;
    const { assets, requests, milestones } = splitLoads(loads);
    const section = makeSection('loading', 'Loading');
    const tick = capture.data.tick[capture.slot(seq)];
    for (const load of milestones) {
        const described = value(`at +${formatMs(load.start - tick)}`, 'num', load.start);
        described.swatch = loadColor(load);
        section.rows.push({ key: `milestone:${load.name}`, label: load.name, value: described });
    }
    if (assets.length) {
        const failed = assets.filter(asset => asset.failed).length;
        section.rows.push({ key: 'assets', label: 'Assets', value: value(`${formatCount(assets.length)} finished${failed ? ` · ${formatCount(failed)} failed` : ''}`, failed ? 'err' : 'num', assets.length) });
        for (const load of assets.slice(0, FRAME_LOADS)) section.rows.push(loadRow(load, 1));
        if (assets.length > FRAME_LOADS) section.rows.push({ key: 'moreAssets', label: '', value: note(`and ${assets.length - FRAME_LOADS} more`), depth: 1 });
    }
    if (requests.length) {
        section.rows.push({ key: 'requests', label: 'Requests', value: requestSummary(requests) });
        for (const load of requests.slice(0, FRAME_LOADS)) section.rows.push(loadRow(load, 1));
        if (requests.length > FRAME_LOADS) section.rows.push({ key: 'moreRequests', label: '', value: note(`and ${requests.length - FRAME_LOADS} more`), depth: 1 });
    }
    return section;
}

/**
 * Builds the property view sections for the frames selected in a capture: the range, when frames
 * are selected together, then everything recorded for the frame shown.
 *
 * @param {PerfSelection} selection - The selection.
 * @returns {PropertySection[]} The sections.
 */
function buildPerfModel(selection) {
    const { capture, seq, gpu } = selection;
    /** @type {PropertySection[]} */
    const sections = [];
    if (selection.range) sections.push(rangeSection(selection));
    if (!capture.has(seq)) return sections;
    // the start of the app ran no frame: it has what loaded instead
    if (capture.isStartup(seq)) return sections.concat(startupSections(capture, seq));

    const d = capture.data;
    const s = capture.slot(seq);
    const before = capture.has(seq - 1) ? capture.slot(seq - 1) : -1;
    const prev = key => (before >= 0 ? d[key][before] : NaN);
    const interval = d.interval[s];
    const { budget, median } = captureNorms(capture);

    const frame = makeSection('frame', capture.label(seq));
    const fps = interval > 0 ? ` · ${(1000 / interval).toFixed(1)} fps` : '';
    frame.rows.push({ key: 'interval', label: 'Frame interval', value: value(`${formatMs(interval)}${fps}`, 'num', interval) });
    if (isHitch(capture, seq, median)) {
        frame.rows.push({ key: 'hitch', label: 'Hitch', value: { text: `${(interval / median).toFixed(1)}× the median frame of ${formatMs(median)}`, cls: 'err' } });
    }
    frame.rows.push({ key: 'verdict', label: 'Held back by', value: value(frameVerdict(capture, seq, budget), 'str') });
    frame.rows.push({ key: 'cpu', label: 'CPU', value: timing(d.cpu[s], interval) });
    frame.rows.push({ key: 'gpu', label: 'GPU', value: Number.isFinite(d.gpu[s]) ? timing(d.gpu[s], interval) : note(gpuNote(gpu)) });
    frame.rows.push({ key: 'budget', label: 'Display interval', value: value(`${formatMs(budget)}, the fastest 5% of frames`, 'num', budget) });
    frame.rows.push({ key: 'time', label: 'Time', value: value(`${((d.tick[s] - capture.get('tick', capture.first)) / 1000).toFixed(2)} s into the capture`, 'num') });
    if (Number.isFinite(d.appFrame[s])) frame.rows.push({ key: 'appFrame', label: 'App frame', value: value(formatCount(d.appFrame[s]), 'num', d.appFrame[s]) });
    if (d.version[s] < 0) frame.rows.push({ key: 'rendered', label: 'Rendered', value: note('no, the app skipped rendering this frame') });
    sections.push(frame);

    const cpu = makeSection('cpu', 'CPU, main thread');
    const part = key => CPU_PARTS.find(p => p.key === key);
    const row = (key, label, ms, depth, swatch) => cpu.rows.push({ key, label, value: timing(ms, interval, swatch), depth });
    row('update', 'Update', d.update[s], 0);
    for (const key of ['systems', 'physics', 'scripts', 'anim', 'post', 'other', 'inspector']) {
        const p = part(key);
        // the scripts only while they were timed apart
        if (key === 'scripts' && !Number.isFinite(d.scripts[s])) continue;
        row(key, p.name, d[p.channel][s], key === 'physics' ? 2 : 1, p.color);
    }
    row('render', 'Render', d.render[s], 0, part('render').color);
    if (capture.detailed) {
        for (const [key, label] of RENDER_PHASES) row(key, label, d[key][s], 1);
    } else {
        cpu.rows.push({ key: 'phases', label: 'Phases', value: note('timed by the profiler and debug engines'), depth: 1 });
    }
    row('outside', 'Outside the engine', Math.max(0, interval - d.cpu[s]), 0);
    if (d.splatSort[s] > 0) {
        cpu.rows.push({ key: 'splatSort', label: 'Splat sort', value: value(`${formatMs(d.splatSort[s])} on a worker`, 'num', d.splatSort[s]) });
    }
    sections.push(cpu);
    if (capture.supports.scripts) sections.push(scriptsSection(selection));
    const loading = loadingSection(capture, seq);
    if (loading) sections.push(loading);

    const gpuSection = makeSection('gpu', 'GPU');
    const passes = capture.passesInOrder(seq);
    if (passes.length) {
        // on WebGPU the frame spans the first pass beginning to the last ending, and pipelined
        // passes overlap, so the passes are shares of their own sum rather than of the frame
        const sum = passes.reduce((total, pass) => total + pass.time, 0);
        gpuSection.rows.push({ key: 'frame', label: 'Frame', value: timing(d.gpu[s], interval) });
        if (sum > d.gpu[s] * 1.05) {
            gpuSection.rows.push({ key: 'sum', label: 'Passes', value: value(`${formatMs(sum)} summed, as passes overlap on the GPU`, 'num', sum) });
        }
        // the effects with the passes they run, and the passes of their own, longest first; passes
        // sharing a name together, with the time of each
        for (const group of gpuGroups(passes)) {
            if (group.effect) {
                gpuSection.rows.push({ key: `effect:${group.key}`, label: effectName(group.effect), value: value(`${formatMs(group.time)} · ${formatShare(group.time, sum)}`, 'num', group.time), depth: 1 });
            }
            for (const [name, times] of group.passes) {
                const time = times.reduce((total, t) => total + t, 0);
                const each = times.length > 1 ? ` · ${times.map(t => t.toFixed(2)).join(', ')}` : '';
                const label = times.length > 1 ? `${name} ×${times.length}` : name;
                gpuSection.rows.push({ key: `pass:${group.key}:${name}`, label, value: value(`${formatMs(time)} · ${formatShare(time, sum)}${each}`, 'num', time), depth: group.effect ? 2 : 1 });
            }
        }
    } else {
        const off = gpu.supported && !gpu.enabled;
        gpuSection.rows.push({
            key: 'none',
            label: 'Timings',
            value: off ? { ...note(gpuNote(gpu)), actions: [{ text: 'Turn on', title: 'Turn the GPU profiler on', run: gpu.enable }] } : note(gpuNote(gpu))
        });
    }
    sections.push(gpuSection);

    const work = makeSection('work', 'Rendering');
    const count = (key, label, depth = 0) => {
        const n = d[key][s];
        work.rows.push({ key, label, value: Number.isFinite(n) ? value(formatCount(n), 'num', n) : note('counted by the profiler and debug engines'), depth });
    };
    count('draws', 'Draw calls');
    if (capture.detailed) {
        count('drawsForward', 'Forward', 1);
        count('drawsShadow', 'Shadow', 1);
        count('drawsMisc', 'Other', 1);
        count('drawsSkinned', 'Skinned', 1);
        count('primitives', 'Primitives');
        count('materialSwitches', 'Material switches');
        count('shaderSwitches', 'Shader switches');
        count('cameras', 'Cameras');
        count('shadowUpdates', 'Shadow map updates');
        count('clusterCount', 'Light clusters');
    } else {
        work.rows.push({ key: 'details', label: 'Details', value: note('counted by the profiler and debug engines') });
    }
    if (Number.isFinite(d.dispatches[s]) && (d.dispatches[s] || d.computePasses[s])) {
        count('dispatches', 'Compute dispatches');
        count('computePasses', 'Compute passes');
    }
    if (d.splats[s] > 0) count('splats', 'Splats');
    sections.push(work);

    const memory = makeSection('memory', 'Memory');
    const bytes = (key, label, depth = 0) => {
        const n = d[key][s];
        if (Number.isFinite(n)) memory.rows.push({ key, label, value: value(formatBytes(n), 'num', n), depth });
    };
    bytes('vram', 'Video memory');
    bytes('vramTex', 'Textures', 1);
    bytes('vramVb', 'Vertex buffers', 1);
    bytes('vramIb', 'Index buffers', 1);
    bytes('vramUb', 'Uniform buffers', 1);
    bytes('vramSb', 'Storage buffers', 1);
    if (Number.isFinite(d.heap[s])) {
        const freed = prev('heap') - d.heap[s];
        const gc = freed > 0 ? ` (${formatBytes(freed)} less than the frame before)` : '';
        memory.rows.push({ key: 'heap', label: 'JavaScript heap', value: value(`${formatBytes(d.heap[s])}${gc}`, 'num', d.heap[s]) });
    } else {
        memory.rows.push({ key: 'heap', label: 'JavaScript heap', value: note('reported by Chromium browsers only') });
    }
    sections.push(memory);

    const resources = makeSection('resources', 'Resources');
    const resource = (key, label) => {
        if (Number.isFinite(d[key][s])) resources.rows.push({ key, label, value: countChange(d[key][s], prev(key)) });
    };
    resource('textures', 'Textures');
    resource('targets', 'Render targets');
    resource('shaders', 'Shaders');
    resource('buffers', 'Buffers');
    resource('pipelines', 'Pipelines');
    sections.push(resources);

    // the same events the rows under the charts mark, each kind with a line per event
    const events = makeSection('events', 'Events');
    const mask = eventMask(capture, seq);
    EVENT_KINDS.forEach((kind) => {
        // the frame section above already says whether the frame is a hitch
        if (kind.key === 'hitch' || !(mask & EVENT_BITS[kind.key])) return;
        eventLines(capture, seq, kind.key).forEach((line, n) => {
            const described = value(line, kind.key === 'long' ? 'err' : 'str');
            if (n === 0) described.swatch = kind.color;
            events.rows.push({ key: `${kind.key}:${n}`, label: n === 0 ? kind.name : '', value: described });
        });
    });
    if (events.rows.length === 0) events.rows.push({ key: 'none', label: 'Events', value: note('none') });
    sections.push(events);

    return sections;
}

/**
 * The script types of the frame shown, or of the frames selected together, each with its own time
 * and the color it is drawn in, the longest first.
 *
 * @param {PerfSelection} selection - The selection.
 * @returns {PropertySection} The section.
 */
function scriptsSection(selection) {
    const { capture, seq, range } = selection;
    const from = range ? Math.max(capture.first, range.from) : seq;
    const to = range ? Math.min(capture.end - 1, range.to) : seq;
    const section = makeSection('scripts', range ? `Scripts, ${capture.rangeLabel(from, to).toLowerCase()}` : 'Scripts');
    const d = capture.data;
    let timed = 0;
    for (let f = from; f <= to; f++) {
        if (capture.scriptFigures(f)) timed++;
    }
    if (!timed) {
        const enabled = !!selection.scripts?.enabled;
        const text = enabled ? 'not timed in this frame' : 'Script timing is off';
        const enable = selection.scripts?.enable;
        section.rows.push({ key: 'none', label: 'Timings', value: !enabled && enable ? { ...note(text), actions: [{ text: 'Turn on', title: 'Time each script type while recording', run: enable }] } : note(text) });
        return section;
    }

    const names = capture.scriptNames;
    // the colors the Scripts chart draws the types in, and the way to give one a band of its own
    const view = selection.scripts;
    const pinned = view?.pinned ?? NO_PINS;
    const legend = scriptLegend(capture, range ? from : capture.first, range ? to : capture.end - 1, view?.rows ?? SCRIPT_ROWS, pinned);
    const colorOf = id => legend.colors.get(id) ?? OTHER_SCRIPTS_COLOR;
    const pinActions = (name) => {
        const pin = view?.pin;
        if (!pin) return undefined;
        return pinned.has(name) ?
            [{ text: 'Unpin', title: 'Take its own band in the Scripts chart away', run: () => pin(name) }] :
            [{ text: 'Pin', title: 'Give it a band of its own in the Scripts chart, whatever its time', run: () => pin(name) }];
    };
    if (range) {
        // each type's own time per frame, over the frames that timed scripts
        const total = rangeStats(capture, 'scriptsTotal', from, to);
        section.rows.push({ key: 'total', label: 'All scripts', value: { text: `avg ${formatMs(total.avg)} · p95 ${formatMs(total.p95)} · max ${formatMs(total.max)}`, cls: 'num', raw: total } });
        // one pass over the frames sums each type and finds its largest; the 95th percentile, which
        // sorts a type's frames, only for the types listed, as an app can have hundreds
        const sums = new Float64Array(names.length);
        const maxes = new Float64Array(names.length);
        const calls = new Float64Array(names.length);
        for (let f = from; f <= to; f++) {
            const times = capture.scriptFigures(f);
            if (!times) continue;
            for (let base = 0, id = 0; base < times.length; base += SCRIPT_STRIDE, id++) {
                const v = times[base] + times[base + 1] + times[base + 2];
                sums[id] += v;
                if (v > maxes[id]) maxes[id] = v;
                calls[id] += times[base + SCRIPT_CALLS] + times[base + SCRIPT_CALLS + 1] + times[base + SCRIPT_CALLS + 2];
            }
        }
        const ids = [];
        for (let id = 0; id < names.length; id++) {
            if (sums[id] > 0) ids.push(id);
        }
        ids.sort((a, b) => sums[b] - sums[a]);
        for (const id of ids.slice(0, MAX_SCRIPT_ROWS)) {
            let n = 0;
            for (let f = from; f <= to && n < SCRATCH.length; f++) {
                const v = capture.scriptTime(f, id);
                if (Number.isFinite(v)) SCRATCH[n++] = v;
            }
            const type = { avg: sums[id] / timed, p95: quantile(SCRATCH.subarray(0, n).sort(), 0.95), max: maxes[id], calls: calls[id] / timed };
            const described = value(`avg ${formatMs(type.avg)} · p95 ${formatMs(type.p95)} · max ${formatMs(type.max)} · ${callCount(type.calls)} a frame`, 'num', type);
            described.swatch = colorOf(id);
            described.actions = pinActions(names[id]);
            section.rows.push({ key: `type:${names[id]}`, label: names[id], value: described, depth: 1 });
        }
        if (ids.length > MAX_SCRIPT_ROWS) section.rows.push({ key: 'more', label: '', value: note(`and ${ids.length - MAX_SCRIPT_ROWS} more`), depth: 1 });
    } else {
        const s = capture.slot(seq);
        const interval = d.interval[s];
        section.rows.push({ key: 'total', label: 'All scripts', value: timing(d.scriptsTotal[s], interval) });
        const calls = d.scriptCalls[s];
        section.rows.push({ key: 'calls', label: 'Calls', value: value(formatCount(calls), 'num', calls) });
        if (d.scriptsInit[s] > 0) section.rows.push({ key: 'init', label: 'Initializing', value: timing(d.scriptsInit[s], interval) });
        const types = capture.scripts(seq);
        for (const type of types.slice(0, MAX_SCRIPT_ROWS)) {
            const parts = [['update', type.update, type.updateCalls], ['post-update', type.post, type.postCalls], ['initialize', type.init, type.initCalls]];
            const detail = parts.filter(([, , n]) => n > 0).map(([name, ms, n]) => `${name} ${formatMs(ms)} in ${callCount(n)}`).join(' · ');
            const own = type.update + type.post + type.init;
            const described = value(`${formatMs(own)} · ${detail}`, 'num', own);
            described.swatch = colorOf(type.id);
            described.actions = pinActions(type.name);
            section.rows.push({ key: `type:${type.name}`, label: type.name, value: described, depth: 1 });
        }
        if (types.length > MAX_SCRIPT_ROWS) section.rows.push({ key: 'more', label: '', value: note(`and ${types.length - MAX_SCRIPT_ROWS} more`), depth: 1 });
        if (d.scriptCost[s] > 0) {
            const cost = d.scriptCost[s] < 0.01 ? 'under 0.01 ms' : `about ${formatMs(d.scriptCost[s])}`;
            section.rows.push({ key: 'cost', label: 'Timing them', value: value(`${cost}, counted as the inspector's time`, 'num', d.scriptCost[s]) });
        }
    }
    if (capture.clockStep > COARSE_CLOCK) {
        section.rows.push({ key: 'clock', label: 'Precision', value: note(`this page's clock steps by ${formatMs(capture.clockStep)}, so a short call reads as nothing or a whole step: small scripts read best over many frames`) });
    }
    return section;
}

/**
 * @param {string} name - The profiler name of the pass running an effect, as FramePassBloom.
 * @returns {string} The name of the effect, as Bloom.
 */
function effectName(name) {
    return name.startsWith('FramePass') && name.length > 9 ? name.slice(9) : name;
}

/**
 * @param {PerfGpuPass[]} passes - The GPU passes of a frame.
 * @returns {{ key: string, effect: string|null, time: number, passes: Map<string, number[]> }[]}
 * Each effect with the passes it runs by name, and the passes of their own by name, longest first.
 */
function gpuGroups(passes) {
    const groups = new Map();
    for (const pass of passes) {
        const key = pass.owner ? `${pass.owner}:${pass.ownerOccurrence}` : `:${pass.name}`;
        let group = groups.get(key);
        if (!group) groups.set(key, group = { key, effect: pass.owner, time: 0, passes: new Map() });
        group.time += pass.time;
        let times = group.passes.get(pass.name);
        if (!times) group.passes.set(pass.name, times = []);
        times.push(pass.time);
    }
    const total = times => times.reduce((sum, t) => sum + t, 0);
    const sorted = [...groups.values()].sort((a, b) => b.time - a.time);
    for (const group of sorted) group.passes = new Map([...group.passes].sort((a, b) => total(b[1]) - total(a[1])));
    return sorted;
}

/**
 * @param {PerfCapture} capture - The capture.
 * @param {PerfSelection['gpu']} gpu - The GPU profiler.
 * @returns {string} Why a frame has no GPU timings.
 */
function gpuNote(gpu) {
    if (!gpu.supported) return 'this device has no GPU profiler';
    if (!gpu.enabled) return 'GPU timings are off';
    return 'not measured for this frame';
}

export {
    ASSET_COLOR, ASSET_COLORS, ASSET_KINDS, CPU_PARTS, EVENT_KINDS, FAILED_COLOR, HITCH_FACTOR, MAIN_THREAD_COLOR, MILESTONE_COLOR, OTHER_SCRIPTS_COLOR,
    RENDER_PHASES, REQUEST_COLOR, SCRIPT_COLORS, SCRIPT_ROWS, buildPerfModel, callCount, captureNorms, effectName, eventLines,
    formatDuration, eventMask, eventUnsupported, formatCount, formatMs, frameVerdict, isHitch, loadColor, loadText, rangeStats,
    scriptColorAt, scriptLegend
};
