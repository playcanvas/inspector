import { formatBytes, makeSection } from './model.js';

/** @import { PerfCapture } from './perf-capture.js' */
/** @import { Described } from './describe.js' */
/** @import { PropertySection } from './model.js' */

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
        tip: 'Component systems and scripts updating',
        channel: 'cpuSystems'
    },
    { key: 'physics', name: 'Physics', color: '#ff9500', tip: 'The physics step, part of the systems update', channel: 'physics' },
    { key: 'anim', name: 'Animation', color: '#00c7be', tip: 'Anim components updating', channel: 'anim' },
    { key: 'post', name: 'Post-update', color: '#5ac8fa', tip: 'Systems and scripts post-updating', channel: 'post' },
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
 * @property {string} color - The CSS color its marks are drawn in.
 * @property {string} tip - What it marks.
 */

/**
 * What the events of a frame can be, each a row of its own under the charts.
 *
 * @type {PerfEventKind[]}
 */
const EVENT_KINDS = [
    { key: 'hitch', name: 'Hitches', color: '#ff3b30', tip: 'Frames that took over twice as long as the median frame' },
    { key: 'long', name: 'Long frames', color: '#ff2d92', tip: 'Long animation frames the browser reported, with the scripts that ran longest' },
    { key: 'compile', name: 'Shaders', color: '#ff9500', tip: 'Shaders compiled or created, and render pipelines created' },
    { key: 'gc', name: 'Heap shrank', color: '#ffcc00', tip: 'The JavaScript heap shrank: a garbage collection' },
    { key: 'resource', name: 'Resources', color: '#3d8bff', tip: 'Textures, render targets or buffers created or destroyed' },
    { key: 'asset', name: 'Assets', color: '#4cd964', tip: 'Assets that finished loading' },
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

// room to sort the values of a channel for its percentiles in; longer spans are sampled evenly
const SCRATCH = new Float64Array(4096);

/**
 * The norms of each capture, kept until it records more.
 *
 * @type {WeakMap<PerfCapture, { version: number, norms: { budget: number, median: number } }>}
 */
const normsCache = new WeakMap();

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
        mask |= kind === 'long' ? EVENT_BITS.long : kind === 'asset' ? EVENT_BITS.asset : EVENT_BITS.marker;
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
            if (isHitch(capture, seq, median)) lines.push(`${formatMs(d.interval[s])}, ${(d.interval[s] / median).toFixed(1)}× the median frame of ${formatMs(median)}`);
            break;
        }
        case 'long':
            for (const event of capture.events(seq)) {
                if (event.kind !== 'long') continue;
                lines.push(`${formatMs(event.duration)} long animation frame, longest script ${event.name}`);
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
        case 'asset':
            for (const event of capture.events(seq)) {
                if (event.kind === 'asset') lines.push(`${event.name} loaded ${at(event.start)}`);
            }
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
    if (kind === 'long' && !capture.supports.longFrames) return 'This browser does not report long animation frames';
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
 * @param {PerfSelection} selection - The selection.
 * @returns {PropertySection} The figures of the selected range of frames.
 */
function rangeSection(selection) {
    const { capture, range } = selection;
    const from = Math.max(capture.first, range.from);
    const to = Math.min(capture.end - 1, range.to);
    const section = makeSection('range', `Frames ${from + 1}–${to + 1}`);
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
    figure('draws', 'Draw calls', rangeStats(capture, 'draws', from, to), formatCount);
    figure('vram', 'Video memory', rangeStats(capture, 'vram', from, to), formatBytes);
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

    const d = capture.data;
    const s = capture.slot(seq);
    const before = capture.has(seq - 1) ? capture.slot(seq - 1) : -1;
    const prev = key => (before >= 0 ? d[key][before] : NaN);
    const interval = d.interval[s];
    const { budget, median } = captureNorms(capture);

    const frame = makeSection('frame', `Frame ${seq + 1}`);
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
    for (const key of ['systems', 'physics', 'anim', 'post', 'other', 'inspector']) {
        const p = part(key);
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

    const gpuSection = makeSection('gpu', 'GPU');
    const passes = capture.passes(seq);
    if (passes.length) {
        // on WebGPU the frame spans the first pass beginning to the last ending, and pipelined
        // passes overlap, so the passes are shares of their own sum rather than of the frame
        const sum = passes.reduce((total, pass) => total + pass.time, 0);
        gpuSection.rows.push({ key: 'frame', label: 'Frame', value: timing(d.gpu[s], interval) });
        if (sum > d.gpu[s] * 1.05) {
            gpuSection.rows.push({ key: 'sum', label: 'Passes', value: value(`${formatMs(sum)} summed, as passes overlap on the GPU`, 'num', sum) });
        }
        for (const pass of passes) {
            gpuSection.rows.push({ key: `pass:${pass.name}`, label: pass.name, value: value(`${formatMs(pass.time)} · ${formatShare(pass.time, sum)}`, 'num', pass.time), depth: 1 });
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
    CPU_PARTS, EVENT_KINDS, HITCH_FACTOR, RENDER_PHASES, buildPerfModel, captureNorms, eventLines, eventMask,
    eventUnsupported, formatCount, formatMs, frameVerdict, isHitch, rangeStats
};
