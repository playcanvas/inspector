/** @import { AppBase, Asset, GraphicsDevice } from 'playcanvas' */

/**
 * @typedef {object} PerfEvent
 * @ignore
 * @property {'long'|'marker'|'bake'} kind - What happened: the browser reported a long animation
 * frame, the app measured a span with `performance.measure`, or the lightmapper baked lightmaps.
 * @property {string} name - What it was: the script that ran longest, the measure, or the bake.
 * @property {number} start - When it started, as a `performance.now()` time.
 * @property {number} duration - How long it took in milliseconds, zero for an instant.
 * @property {string} [detail] - More about it, such as the blocking time of a long frame.
 * @property {PerfBake} [bake] - The figures of a bake of lightmaps.
 */

/**
 * @typedef {object} PerfBake
 * @ignore
 * @property {number} lightmaps - How many lightmaps it baked.
 * @property {number} passes - How many render passes it took.
 * @property {number} targets - The time creating render targets, in milliseconds.
 * @property {number} shaders - How many shaders it linked.
 * @property {number} compile - The time compiling and linking them.
 */

/**
 * @typedef {object} PerfScript
 * @ignore
 * @property {number} id - Its index into {@link PerfCapture#scriptNames}.
 * @property {string} name - The name the script type is registered under.
 * @property {number} update - Its own time in its update, in milliseconds.
 * @property {number} post - Its own time in its post-update.
 * @property {number} init - Its own time initializing and post-initializing, as new instances do,
 * and swapping in when hot-reloaded.
 * @property {number} calls - How many of its methods were called.
 * @property {number} updateCalls - How many times its update was called, once an instance.
 * @property {number} postCalls - How many times its post-update was called.
 * @property {number} initCalls - How many times it was initialized, post-initialized or swapped.
 */

/**
 * @typedef {object} PerfLoad
 * @ignore
 * @property {'asset'|'request'|'milestone'} kind - What it is: an asset loading, a request the
 * page made, or a moment of the app or the page, such as its first paint.
 * @property {string} name - The asset, the file requested, or the moment.
 * @property {number} start - When it began, as a `performance.now()` time; NaN for an asset that
 * began loading before recording did.
 * @property {number} end - When it ended; the same as its start for a moment.
 * @property {string} [type] - The type of an asset.
 * @property {number} [id] - The id of an asset.
 * @property {boolean} [failed] - Whether an asset failed to load.
 * @property {number} [netStart] - When the request of an asset or a request began on the network.
 * @property {number} [netEnd] - When its last byte arrived.
 * @property {number} [firstByte] - When its first byte arrived.
 * @property {number} [bytes] - Its size over the network, the size of the file where it came
 * from the cache.
 * @property {boolean} [cached] - Whether it came from the cache.
 * @property {string} [url] - The file requested.
 */

/**
 * @typedef {object} PerfPass
 * @ignore
 * @property {string} name - The profiler name of the pass. Passes sharing a name are summed.
 * @property {number} time - Its GPU time in milliseconds.
 */

/**
 * @typedef {object} PerfGpuPass
 * @ignore
 * @property {string} name - The profiler name of the pass.
 * @property {number} time - Its GPU time in milliseconds.
 * @property {string|null} owner - The profiler name of the effect running it, the pass of the
 * frame graph it is a before or after pass of, or null for a pass of its own.
 * @property {number} occurrence - Which of the passes of the frame graph with its name it is, 0
 * for the first, or -1 where it was not matched to one.
 * @property {number} ownerOccurrence - Which of the passes with its owner's name its owner is,
 * or -1.
 */

/**
 * How many frames a capture keeps, about 17 seconds at 60 Hz: few enough that the charts show
 * them without squeezing many frames into each pixel. The oldest frames make way once it is full.
 */
const CAPTURE_FRAMES = 1000;

// how many frames back the GPU timings of a frame are looked for: they resolve a few frames late
const GPU_LATENCY_FRAMES = 16;

// the figures kept per GPU pass of a frame: the id of its name, its time, the id of its owner's
// name or -1, and which of the passes of the frame graph with its name, and with its owner's, it
// matched, or -1
const PASS_STRIDE = 5;

// the share of a frame's timed passes that have to match passes of the frame graph for their
// owners to be trusted
const PASS_MATCH_SHARE = 0.6;

// the events kept per frame, so an app measuring heavily cannot grow a frame without bound
const MAX_FRAME_EVENTS = 64;

// the most counters of `app.stats.user` kept, as an app could set any number
const MAX_COUNTERS = 64;

// the loads kept per entry: a startup can make hundreds of requests
const MAX_ENTRY_LOADS = 4096;

// a time between two entries longer than this, in milliseconds, as between two recordings, is
// folded to FOLDED_GAP on the time axis, so it does not squeeze everything else
const GAP_FOLD = 1000;
const FOLDED_GAP = 250;

// the kinds of entry of the capture: a frame, or the start of the app, from the page opening to
// its first frame
const ENTRY_FRAME = 0;
const ENTRY_STARTUP = 1;

// the figures kept per script type in a frame: its own time in its update, its post-update and its
// initializing; how many times each was called, from SCRIPT_CALLS on; and from SCRIPT_ORDER on, the
// place of its first update and its first post-update among the types', 1 for the first, which is
// the order the types ran in
const SCRIPT_STRIDE = 8;
const SCRIPT_CALLS = 3;
const SCRIPT_ORDER = 6;

// how many calls the cost of timing a script call is measured over, the best of a few rounds
const PROBE_CALLS = 2000;
const PROBE_ROUNDS = 3;

/**
 * The figures recorded for every frame, each in a ring of its own. Durations are in milliseconds,
 * timestamps are `performance.now()` times, memory is in bytes and a figure the engine did not
 * provide is NaN.
 *
 * @type {string[]}
 */
const CHANNELS = [
    // the tick: when it began, how long until the next one began, and when its work ended
    'tick', 'interval', 'end', 'appFrame', 'version',
    // CPU phases on the main thread, and when each began
    'update', 'updateStart', 'systems', 'systemsStart', 'physics', 'physicsStart', 'anim', 'animStart',
    'post', 'postStart', 'render', 'renderStart', 'inspector', 'inspectorStart', 'cpu',
    // the CPU time without the inspector's own, and the parts of the update the CPU chart stacks
    // that are worked out from the others: the systems without the physics they include, and the
    // rest of the update
    'cpuApp', 'cpuSystems', 'cpuOther',
    // reported by the splat sort worker, off the main thread
    'splatSort',
    // render phases, with the profiler and debug engines only; the batching is the batcher
    // updating the dynamic batches and creating those of groups changed, the second part apart
    'batching', 'batchCreate', 'cull', 'sort', 'skin', 'morph', 'shadows', 'forward', 'clusters', 'clusterCount',
    // the work submitted
    'draws', 'drawsForward', 'drawsShadow', 'drawsMisc', 'drawsSkinned', 'primitives',
    'materialSwitches', 'shaderSwitches', 'cameras', 'shadowUpdates', 'dispatches', 'computePasses', 'splats',
    // filled in when the GPU timings of the frame resolve
    'gpu',
    // memory, as the frame left it
    'vram', 'vramTex', 'vramVb', 'vramIb', 'vramUb', 'vramSb', 'heap',
    // resources on the device, as the frame left them
    'textures', 'targets', 'shaders', 'buffers', 'pipelines',
    // shader compiles and links the device reported, with the profiler and debug engines only
    'compiles', 'compileTime',
    // while scripts are timed, NaN otherwise: their own time in the update of the systems and in
    // the post-update, with when the first call of each began; all their time, wherever it ran;
    // the part of it initializing; their calls; and the estimated cost of timing them, which
    // counts as the inspector's. The CPU chart stacks the first two as Scripts, and the
    // post-update without them
    'scripts', 'scriptsUpdate', 'scriptsUpdateStart', 'scriptsPost', 'scriptsPostStart', 'scriptsTotal',
    'scriptsInit', 'scriptCalls', 'scriptCost', 'cpuPost',
    // the entry on the time axis: what it is, where it starts and how wide it is there, in
    // milliseconds, and the time before it that is folded away
    'kind', 'pos', 'width', 'gap'
];

// the channels of the scripts, NaN for a frame they were not timed in
const SCRIPT_CHANNELS = ['scripts', 'scriptsUpdate', 'scriptsPost', 'scriptsTotal', 'scriptsInit', 'scriptCalls', 'scriptCost'];

// the channels a detailed engine publishes, NaN in the others
const DETAILED_CHANNELS = [
    'cull', 'sort', 'skin', 'morph', 'shadows', 'forward', 'clusters', 'clusterCount', 'drawsForward',
    'drawsShadow', 'drawsMisc', 'drawsSkinned', 'primitives', 'materialSwitches', 'shaderSwitches',
    'cameras', 'shadowUpdates'
];

// the running count of pipelineCount, and the callback adding a cache bucket to it
let pipelineTotal = 0;
const addBucket = (bucket) => {
    pipelineTotal += bucket.length;
};

// the events of the many frames without any, shared
const NO_EVENTS = Object.freeze(/** @type {PerfEvent[]} */ ([]));

// the loads of the many entries without any, shared
const NO_LOADS = Object.freeze(/** @type {PerfLoad[]} */ ([]));

/**
 * @param {string|null} url - A URL, relative to the page or absolute.
 * @returns {string|null} The URL absolute, as the browser names its requests.
 */
function absoluteUrl(url) {
    if (!url) return null;
    try {
        return new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined).href;
    } catch (e) {
        return url;
    }
}

/**
 * @param {string} url - An absolute URL.
 * @returns {string} The file it names, without the folders and the query.
 */
function fileName(url) {
    const path = url.split(/[?#]/)[0];
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || path;
}

/**
 * @param {GraphicsDevice} device - The device.
 * @returns {number} The render and compute pipelines the device has created and caches, or NaN on a
 * device that creates none.
 */
function pipelineCount(device) {
    const webgpu = /** @type {any} */ (device);
    const render = webgpu.renderPipeline?.cache;
    if (!render) return NaN;
    // counted through a callback made once, as this runs every frame while recording; hash
    // collisions share a bucket, so the size of the map is not the count
    pipelineTotal = 0;
    render.forEach(addBucket);
    webgpu.computePipeline?.cache?.forEach(addBucket);
    return pipelineTotal;
}

/**
 * @param {AppBase} app - The app.
 * @returns {{ createTime: number, updateLastFrameTime: number }|null} The times of its batcher,
 * which the profiler and debug engines keep, or null.
 */
function batcherStats(app) {
    const stats = /** @type {any} */ (app.stats);
    return (stats && 'batcher' in stats ? stats.batcher : /** @type {any} */ (app)._batcher?._stats) ?? null;
}

/**
 * @param {AppBase} app - An app.
 * @returns {any} The prototype of its script components, through whose `_scriptMethod` the
 * engine calls every method of a script, or null when the app has no script system or the engine
 * calls them some other way.
 */
function scriptPrototype(app) {
    const proto = /** @type {any} */ (app.systems)?.script?.ComponentType?.prototype;
    return typeof proto?._scriptMethod === 'function' ? proto : null;
}

/**
 * @returns {number} The smallest step the clock moves by, in milliseconds, NaN for a clock that
 * did not move. Browsers coarsen it on pages that are not cross-origin isolated, to a tenth of a
 * millisecond in Chromium.
 */
function clockStep() {
    let step = Infinity;
    let last = performance.now();
    const until = last + 5;
    for (let steps = 0, reads = 0; steps < 4 && reads < 1e6; reads++) {
        const now = performance.now();
        if (now > last) {
            step = Math.min(step, now - last);
            last = now;
            steps++;
        }
        if (now > until) break;
    }
    return Number.isFinite(step) ? step : NaN;
}

/**
 * @param {any} pass - A frame pass.
 * @returns {string} The name the GPU profiler times it under.
 */
function profilerName(pass) {
    const name = pass.name;
    return name.startsWith('RenderPass') ? name.slice(10) : name;
}

/**
 * @param {any} pass - A frame pass.
 * @returns {any[]} The passes it runs around itself as an effect does: its before and after
 * passes, and the passes of each view of a multi-view pass. Its internal before-passes are left
 * out: they are what the frame needs ahead of it, such as the directional shadows of a forward
 * pass, so they stay passes of their own rather than grouping the pass as an effect.
 */
function nestedPasses(pass) {
    return [...pass.beforePasses ?? [], ...pass.afterPasses ?? [], ...(Array.isArray(pass.children) ? pass.children : [])];
}

/**
 * @param {string} type - A performance entry type.
 * @returns {boolean} Whether the browser reports entries of that type to an observer.
 */
function observable(type) {
    return typeof PerformanceObserver !== 'undefined' && !!PerformanceObserver.supportedEntryTypes?.includes(type);
}

/**
 * @returns {number} The used JavaScript heap in bytes, or NaN where the browser does not say.
 * Only Chromium browsers do, and coarsely.
 */
function heapSize() {
    return /** @type {any} */ (performance).memory?.usedJSHeapSize ?? NaN;
}

/**
 * Records the performance of an app frame by frame, while asked to, into rings holding the last
 * {@link CAPTURE_FRAMES} frames. A frame is recorded in two steps: its CPU timings when its work
 * ends, and its frame interval and the counters of the work it submitted as the next frame begins,
 * when the engine publishes them. GPU timings resolve a few frames later still and are matched to
 * their frame by the render version they describe. Frames are numbered by sequence from the last
 * clear, so a number stays put while older frames make way.
 *
 * Nothing is hooked into the app while not recording.
 *
 * @ignore
 */
class PerfCapture {
    /**
     * The rings, one per channel of {@link CHANNELS}, indexed by {@link slot}.
     *
     * @type {Record<string, Float64Array>}
     */
    data = {};

    /**
     * How many frames are kept.
     *
     * @type {number}
     */
    capacity;

    /**
     * Whether the engine publishes the render phase timings and the breakdown of the draw calls:
     * the profiler and debug engines do.
     *
     * @type {boolean}
     */
    detailed;

    /**
     * Bumped whenever the recorded data changes, so a view can tell when to redraw.
     *
     * @type {number}
     */
    version = 0;

    /**
     * The names of the GPU passes seen, indexed by the ids the frames keep.
     *
     * @type {string[]}
     */
    names = [];

    /**
     * Whether the GPU timings come with the frame they describe, so each lands on its own frame.
     * Older engines leave it to the newest frame when the timings change, a few frames late.
     *
     * @type {boolean}
     */
    gpuExact = false;

    /**
     * What the browser, the device and the app report: long animation frames, the spans measured by
     * the app, the size of the JavaScript heap, the pipelines created, which only WebGPU has, the
     * calls of scripts, which an app without a script system has none of, the counters of
     * `app.stats.user`, which engines before 2.24 have none of, and the bakes of the lightmapper,
     * which an app without one has none of.
     *
     * @type {{ longFrames: boolean, measures: boolean, heap: boolean, pipelines: boolean, scripts: boolean, counters: boolean, lightmapper: boolean }}
     */
    supports;

    /**
     * The names of the script types timed, indexed by the ids the frames keep.
     *
     * @type {string[]}
     */
    scriptNames = [];

    /**
     * The names of the counters the app keeps in `app.stats.user`, indexed by the ids of
     * {@link PerfCapture#counterRings}, in the order the app first set them.
     *
     * @type {string[]}
     */
    counterNames = [];

    /**
     * The value of each counter as each frame ended, a ring of {@link PerfCapture#slots} each,
     * NaN in a frame the app did not set it in.
     *
     * @type {Float64Array[]}
     */
    counterRings = [];

    /**
     * @type {Map<string, number>}
     * @private
     */
    _counterIds = new Map();

    /**
     * The slot the counters are being taken into.
     *
     * @type {number}
     * @private
     */
    _counterSlot = 0;

    /**
     * The batcher's time creating batches as the last frame ended, so a frame takes what it
     * created.
     *
     * @type {number}
     * @private
     */
    _batchCreated = NaN;

    /**
     * When the lightmapper began the bake in progress, NaN while none is.
     *
     * @type {number}
     * @private
     */
    _bakeStart = NaN;

    /**
     * The class of each script type timed, by the same ids: the one it last ran as, as a
     * hot-reloaded script swaps in a new class under the same name.
     *
     * @type {Function[]}
     */
    scriptClasses = [];

    /**
     * The estimated cost of timing a script call in milliseconds, NaN until scripts are first
     * timed.
     *
     * @type {number}
     */
    callCost = NaN;

    /**
     * The smallest step the clock moves by in milliseconds, which the times of single calls are
     * made of, NaN until scripts are first timed.
     *
     * @type {number}
     */
    clockStep = NaN;

    /**
     * @type {AppBase}
     * @private
     */
    _app;

    /**
     * One slot more than {@link capacity}, for the frame being recorded.
     *
     * @private
     */
    _slots;

    /**
     * The sequence number the frame being recorded gets once complete.
     *
     * @private
     */
    _end = 0;

    /** @private */
    _recording = false;

    /**
     * Whether the frame in the next slot has begun, and whether its work has ended.
     *
     * @private
     */
    _begun = false;

    /** @private */
    _ended = false;

    /**
     * The render version of the last frame recorded, to tell a frame that rendered nothing.
     *
     * @private
     */
    _lastVersion = -1;

    /**
     * The render version of the last GPU timings taken, or their frame time on older engines.
     *
     * @private
     */
    _gpuSeen = -1;

    /**
     * @type {Map<string, number>}
     * @private
     */
    _nameIds = new Map();

    /**
     * The GPU passes of each slot in the order they ran, {@link PASS_STRIDE} figures each, written
     * in place as the ring turns over, so recording makes no garbage; {@link _passCounts} says how
     * many of them the slot has.
     *
     * @type {number[][]}
     * @private
     */
    _passFigures = [];

    /**
     * @type {number[]}
     * @private
     */
    _passCounts = [];

    /**
     * The owners last matched to the timed passes, by the names of the passes of the frame graph
     * and of the timed passes they were matched for. The frame graph rarely changes, though some
     * of its passes are made anew every frame, so most frames reuse them.
     *
     * @private
     */
    _match = { graph: /** @type {string[]} */ ([]), timed: /** @type {number[]} */ ([]), result: /** @type {number[]} */ ([]) };

    /**
     * The events of each slot, null for the many frames without any.
     *
     * @type {(PerfEvent[]|null)[]}
     * @private
     */
    _events = [];

    /**
     * The loads of each slot, those that ended in its entry, null for the many without any.
     *
     * @type {(PerfLoad[]|null)[]}
     * @private
     */
    _loads = [];

    /**
     * The assets loading, by id, from when they began: they go to the entry they end in.
     *
     * @type {Map<number, PerfLoad>}
     * @private
     */
    _pending = new Map();

    /**
     * Whether the entry being recorded is the start of the app: the inspector began recording
     * before the app ran its first frame.
     *
     * @private
     */
    _startup = false;

    /**
     * The latest request of each file, by URL, and the assets that ended loading before the
     * browser reported the request of their file, which it does a little later: each is linked
     * to the other as the second of them comes.
     *
     * @private
     */
    _requests = /** @type {Map<string, PerfLoad>} */ (new Map());

    /** @private */
    _awaitingRequest = /** @type {Map<string, PerfLoad>} */ (new Map());

    /**
     * Whether the capture began with the start of the app, so its frames count from the one after.
     *
     * @type {boolean}
     */
    startedAtStartup = false;

    /**
     * The slot the GPU timings being taken go to.
     *
     * @private
     */
    _gpuSlot = 0;

    /**
     * Whether to time scripts while recording.
     *
     * @private
     */
    _timeScripts = false;

    /**
     * Puts back the engine's own way of calling script methods, while scripts are timed.
     *
     * @type {(() => void)|null}
     * @private
     */
    _unhook = null;

    /**
     * @type {Map<string, number>}
     * @private
     */
    _scriptIds = new Map();

    /**
     * The figures of each script type of each slot, {@link SCRIPT_STRIDE} per type by id, reused
     * as the ring turns over and grown as new types appear. Single precision, which times to well
     * under a microsecond, as an app can have hundreds of types.
     *
     * @type {Float32Array[]}
     * @private
     */
    _scriptTimes = [];

    /**
     * How many script types have had their first update, and their first post-update, in the frame
     * being recorded.
     *
     * @private
     */
    _scriptOrder = [0, 0];

    /**
     * How deep the script call under way is nested in others, as a script creating an entity
     * initializes its scripts within its own call; the time of the calls nested in it so far; and
     * the phase the outermost call is in: 0 the update, 1 the post-update, 2 anywhere else.
     *
     * @private
     */
    _depth = 0;

    /** @private */
    _nested = 0;

    /** @private */
    _phase = 2;

    /**
     * The script calls of the frame being recorded in each phase, for the cost of timing them.
     *
     * @private
     */
    _phaseCalls = [0, 0, 0];

    /**
     * Whether calls are being timed to measure their cost, rather than for the frame.
     *
     * @private
     */
    _probing = false;

    /** @private */
    _compileStart = NaN;

    /** @private */
    _linkStart = NaN;

    /**
     * @type {PerformanceObserver[]}
     * @private
     */
    _observers = [];

    /**
     * @param {AppBase} app - The app to record.
     * @param {number} [capacity] - How many frames to keep. Defaults to {@link CAPTURE_FRAMES}.
     */
    constructor(app, capacity = CAPTURE_FRAMES) {
        this._app = app;
        this.capacity = capacity;
        this._slots = capacity + 1;
        for (const key of CHANNELS) this.data[key] = new Float64Array(this._slots);
        // only the profiler and debug engines count primitives, as they do the other details
        this.detailed = !!app.stats?.frame && 'primitives' in app.stats.frame;
        this.supports = {
            longFrames: observable('long-animation-frame'),
            measures: observable('measure'),
            heap: Number.isFinite(heapSize()),
            pipelines: Number.isFinite(pipelineCount(app.graphicsDevice)),
            scripts: !!scriptPrototype(app),
            counters: app.stats?.user instanceof Map,
            lightmapper: !!app.lightmapper
        };
    }

    /**
     * Stops recording and lets go of the app.
     */
    destroy() {
        this.stop();
    }

    /**
     * Whether frames are being recorded.
     *
     * @type {boolean}
     */
    get recording() {
        return this._recording;
    }

    /**
     * Whether to time each script type while recording: every method of a script the engine calls
     * is timed, which costs the app about half a microsecond a call, counted as the inspector's
     * time. A frame recorded while it is off has no script times.
     *
     * @type {boolean}
     */
    set timeScripts(on) {
        this._timeScripts = on;
        if (!this._recording) return;
        if (on) this._hookScripts();
        else this._unhookScripts();
    }

    get timeScripts() {
        return this._timeScripts;
    }

    /**
     * The length of the rings of {@link data}: {@link slot} is a frame's sequence number modulo
     * this.
     *
     * @type {number}
     */
    get slots() {
        return this._slots;
    }

    /**
     * The sequence number of the oldest frame kept.
     *
     * @type {number}
     */
    get first() {
        return Math.max(0, this._end - this.capacity);
    }

    /**
     * One past the sequence number of the newest complete frame.
     *
     * @type {number}
     */
    get end() {
        return this._end;
    }

    /**
     * How many complete frames are kept.
     *
     * @type {number}
     */
    get count() {
        return this._end - this.first;
    }

    /**
     * Starts recording, adding to the frames kept. The frame in progress is left out, as its start
     * was missed.
     */
    start() {
        if (this._recording) return;
        this._recording = true;
        this._begun = false;
        const app = this._app;
        const device = app.graphicsDevice;
        this._lastVersion = device.renderVersion;
        this._gpuSeen = -1;
        this.gpuExact = typeof device.gpuProfiler?.renderVersion === 'number';

        app.on('frameupdate', this._onFrameUpdate, this);
        app.on('frameend', this._onFrameEnd, this);
        app.on('preload:start', this._onPreloadStart, this);
        app.on('preload:end', this._onPreloadEnd, this);
        app.on('start', this._onAppStart, this);
        app.assets?.on('load:start', this._onAssetLoadStart, this);
        app.assets?.on('load', this._onAssetLoad, this);
        app.assets?.on('error', this._onAssetError, this);
        device.on('shader:compile:start', this._onCompileStart, this);
        device.on('shader:compile:end', this._onCompileEnd, this);
        device.on('shader:link:start', this._onLinkStart, this);
        device.on('shader:link:end', this._onLinkEnd, this);
        device.on('lightmapper:start', this._onBakeStart, this);
        device.on('lightmapper:end', this._onBakeEnd, this);
        this._batchCreated = batcherStats(app)?.createTime ?? NaN;
        this._bakeStart = NaN;
        // recording from before the app's first frame records its start too, as an entry of its own
        const startup = this._end === 0 && !(app.frame > 0);
        if (startup) this._beginStartup();
        // what the browser kept from before then only for the start of the app
        this._observe('long-animation-frame', this._onLongFrames, startup);
        this._observe('measure', this._onMeasures);
        this._observe('resource', this._onResources);
        this._observe('paint', this._onPaints, startup);
        if (this._timeScripts) this._hookScripts();
    }

    /**
     * Stops recording, keeping the frames recorded. The frame in progress is dropped.
     */
    stop() {
        if (!this._recording) return;
        this._recording = false;
        this._begun = false;
        const app = this._app;
        const device = app.graphicsDevice;
        app.off('frameupdate', this._onFrameUpdate, this);
        app.off('frameend', this._onFrameEnd, this);
        app.off('preload:start', this._onPreloadStart, this);
        app.off('preload:end', this._onPreloadEnd, this);
        app.off('start', this._onAppStart, this);
        app.assets?.off('load:start', this._onAssetLoadStart, this);
        app.assets?.off('load', this._onAssetLoad, this);
        app.assets?.off('error', this._onAssetError, this);
        device.off('shader:compile:start', this._onCompileStart, this);
        device.off('shader:compile:end', this._onCompileEnd, this);
        device.off('shader:link:start', this._onLinkStart, this);
        device.off('shader:link:end', this._onLinkEnd, this);
        device.off('lightmapper:start', this._onBakeStart, this);
        device.off('lightmapper:end', this._onBakeEnd, this);
        for (const observer of this._observers) observer.disconnect();
        this._observers.length = 0;
        this._unhookScripts();
        this._startup = false;
        this._pending.clear();
        this._requests.clear();
        this._awaitingRequest.clear();
        this.version++;
    }

    /**
     * Forgets every frame, and numbers the next one zero.
     */
    clear() {
        this._end = 0;
        this.startedAtStartup = false;
        this._begun = false;
        this._gpuSeen = -1;
        this.version++;
    }

    /**
     * @param {number} seq - The sequence number of a frame.
     * @returns {boolean} Whether that frame is kept.
     */
    has(seq) {
        return seq >= this.first && seq < this._end;
    }

    /**
     * @param {number} seq - The sequence number of a kept frame.
     * @returns {number} Its index into the rings of {@link data}.
     */
    slot(seq) {
        return seq % this._slots;
    }

    /**
     * @param {string} key - A channel of {@link CHANNELS}.
     * @param {number} seq - The sequence number of a kept frame.
     * @returns {number} Its figure.
     */
    get(key, seq) {
        return this.data[key][seq % this._slots];
    }

    /**
     * @param {number} seq - The sequence number of a kept frame.
     * @returns {PerfPass[]} The GPU passes of the frame, longest first, empty until its timings
     * resolve.
     */
    passes(seq) {
        // passes sharing a name summed, as the profiler of an older engine reports them
        const totals = new Map();
        for (const pass of this.passesInOrder(seq)) totals.set(pass.name, (totals.get(pass.name) ?? 0) + pass.time);
        return [...totals].map(([name, time]) => ({ name, time })).sort((a, b) => b.time - a.time);
    }

    /**
     * @param {number} seq - The sequence number of a kept frame.
     * @returns {PerfGpuPass[]} The GPU passes of the frame in the order they ran, each apart, with
     * the effect running it where the frame graph says. An engine whose profiler sums the passes
     * sharing a name gives one for each name.
     */
    passesInOrder(seq) {
        const slot = seq % this._slots;
        const figures = this._passFigures[slot];
        const count = this._passCounts[slot] ?? 0;
        /** @type {PerfGpuPass[]} */
        const passes = [];
        for (let i = 0, base = 0; i < count; i++, base += PASS_STRIDE) {
            const owner = figures[base + 2];
            passes.push({
                name: this.names[figures[base]],
                time: figures[base + 1],
                owner: owner >= 0 ? this.names[owner] : null,
                occurrence: figures[base + 3],
                ownerOccurrence: figures[base + 4]
            });
        }
        return passes;
    }

    /**
     * @param {number} seq - The sequence number of a kept frame.
     * @returns {PerfScript[]} The script types whose methods were called in the frame, with their
     * own times, the longest first; empty for a frame scripts were not timed in.
     */
    scripts(seq) {
        const slot = seq % this._slots;
        const times = this._scriptTimes[slot];
        /** @type {PerfScript[]} */
        const list = [];
        if (!times || !(this.data.scriptsTotal[slot] >= 0)) return list;
        for (let id = 0, base = 0; base < times.length; id++, base += SCRIPT_STRIDE) {
            const updateCalls = times[base + SCRIPT_CALLS];
            const postCalls = times[base + SCRIPT_CALLS + 1];
            const initCalls = times[base + SCRIPT_CALLS + 2];
            const calls = updateCalls + postCalls + initCalls;
            if (calls > 0) {
                list.push({ id, name: this.scriptNames[id], update: times[base], post: times[base + 1], init: times[base + 2], calls, updateCalls, postCalls, initCalls });
            }
        }
        return list.sort((a, b) => b.update + b.post + b.init - a.update - a.post - a.init);
    }

    /**
     * @param {number} seq - The sequence number of a kept frame.
     * @returns {Float32Array|null} The figures of each script type in the frame,
     * {@link SCRIPT_STRIDE} a type by its index into {@link scriptNames}: its own update,
     * post-update and initialize time, how many times each was called, and the order of its first
     * update and post-update among the types'. A type past the end of it had none. Null for a
     * frame scripts were not timed in. Read only.
     */
    scriptFigures(seq) {
        const slot = seq % this._slots;
        return this.data.scriptsTotal[slot] >= 0 ? this._scriptTimes[slot] ?? null : null;
    }

    /**
     * @param {number} seq - The sequence number of a kept frame.
     * @param {number} id - A script type, by its index into {@link scriptNames}.
     * @returns {number} The type's own time in the frame, zero when none of its methods were
     * called, NaN when scripts were not timed in it.
     */
    scriptTime(seq, id) {
        const times = this.scriptFigures(seq);
        if (!times) return NaN;
        const base = id * SCRIPT_STRIDE;
        return base < times.length ? times[base] + times[base + 1] + times[base + 2] : 0;
    }

    /**
     * @param {number} seq - The sequence number of a kept frame.
     * @returns {readonly PerfEvent[]} What happened during the frame.
     */
    events(seq) {
        return this._events[seq % this._slots] ?? NO_EVENTS;
    }

    /**
     * @param {number} seq - The sequence number of a kept entry.
     * @returns {readonly PerfLoad[]} What finished loading in the entry, and the moments in it.
     */
    loads(seq) {
        return this._loads[seq % this._slots] ?? NO_LOADS;
    }

    /**
     * @returns {PerfLoad[]} The assets loading now, which have not ended yet.
     */
    pendingLoads() {
        return [...this._pending.values()];
    }

    /**
     * @param {number} seq - The sequence number of an entry.
     * @returns {number} The number of the frame it is, counting from 1: from the frame after the
     * start of the app, where the capture began with it. It stays as frames make way.
     */
    frameNumber(seq) {
        return this.startedAtStartup ? seq : seq + 1;
    }

    /**
     * @param {number} seq - The sequence number of a kept entry.
     * @returns {string} What it is called: Startup, or Frame and its number.
     */
    label(seq) {
        return this.isStartup(seq) ? 'Startup' : `Frame ${this.frameNumber(seq)}`;
    }

    /**
     * @param {number} from - The first kept entry.
     * @param {number} to - The last, inclusive.
     * @returns {string} What they are called together, as Frames 3–40, or Startup to frame 40.
     */
    rangeLabel(from, to) {
        return this.isStartup(from) ? `Startup to frame ${this.frameNumber(to)}` : `Frames ${this.frameNumber(from)}–${this.frameNumber(to)}`;
    }

    /**
     * @param {number} seq - The sequence number of a kept entry.
     * @returns {boolean} Whether it is the start of the app rather than a frame.
     */
    isStartup(seq) {
        return this.data.kind[seq % this._slots] === ENTRY_STARTUP;
    }

    /**
     * Where the kept entries begin on the time axis, in milliseconds.
     *
     * @type {number}
     */
    get startPos() {
        return this.count ? this.data.pos[this.first % this._slots] : 0;
    }

    /**
     * Where the kept entries end on the time axis, in milliseconds.
     *
     * @type {number}
     */
    get endPos() {
        if (!this.count) return 0;
        const slot = (this._end - 1) % this._slots;
        return this.data.pos[slot] + this.data.width[slot];
    }

    /**
     * @param {number} pos - A place on the time axis.
     * @returns {number} The kept entry there or before it, the first one before them all, or -1
     * while none is kept.
     */
    seqAtPos(pos) {
        if (!this.count) return -1;
        const posRing = this.data.pos;
        let lo = this.first;
        let hi = this._end - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (posRing[mid % this._slots] <= pos) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /**
     * @param {number} time - A `performance.now()` time.
     * @returns {number} Where it is on the time axis: within the entry it falls in, in proportion
     * across a folded gap, and before the first kept entry at its start.
     */
    posAt(time) {
        if (!this.count) return 0;
        const d = this.data;
        const slots = this._slots;
        let lo = this.first;
        let hi = this._end - 1;
        if (time < d.tick[lo % slots]) return d.pos[lo % slots];
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (d.tick[mid % slots] <= time) lo = mid;
            else hi = mid - 1;
        }
        const slot = lo % slots;
        const into = time - d.tick[slot];
        const width = d.width[slot];
        if (into <= width || lo === this._end - 1) return d.pos[slot] + into;
        // in the gap before the next entry, folded on the axis
        const next = (lo + 1) % slots;
        const realGap = d.tick[next] - d.tick[slot] - width;
        const shownGap = d.pos[next] - d.pos[slot] - width;
        return d.pos[slot] + width + (realGap > 0 ? ((into - width) / realGap) * shownGap : 0);
    }

    /**
     * Counts time the inspector spent inside the frame being recorded, so it can be told apart from
     * the app's own.
     *
     * @param {number} start - When the inspector's work began, as a `performance.now()` time.
     * @param {number} duration - How long it took in milliseconds.
     */
    addOverhead(start, duration) {
        if (!this._begun) return;
        const slot = this._end % this._slots;
        const data = this.data;
        data.inspector[slot] += duration;
        if (Number.isNaN(data.inspectorStart[slot])) data.inspectorStart[slot] = start;
    }

    /**
     * @param {string} type - A performance entry type.
     * @param {(list: PerformanceObserverEntryList) => void} callback - Takes the entries.
     * @param {boolean} [buffered] - Whether to take the entries the browser kept from before too.
     * @private
     */
    _observe(type, callback, buffered = false) {
        if (!observable(type)) return;
        const observer = new PerformanceObserver(callback);
        observer.observe({ type, buffered });
        this._observers.push(observer);
    }

    /**
     * The next frame begins: the previous one is complete now that the engine has published the
     * counters of the work it submitted.
     *
     * @private
     */
    _onFrameUpdate() {
        const now = performance.now();
        if (this._startup) {
            // the moment that ends the start of the app, kept with it
            this._addMilestone('First frame', now);
            this._endStartup(now);
        } else if (this._begun && this._ended) {
            this._complete(now);
        }
        this._resolveGpu();
        this._begin(now);
    }

    /**
     * Begins the entry of the start of the app, from when the page opened. Takes what the browser
     * kept from before recording began: the requests of the page and its milestones.
     *
     * @private
     */
    _beginStartup() {
        const slot = this._end % this._slots;
        const data = this.data;
        for (const key of CHANNELS) data[key][slot] = NaN;
        data.kind[slot] = ENTRY_STARTUP;
        data.tick[slot] = 0;
        data.pos[slot] = 0;
        data.gap[slot] = 0;
        data.compiles[slot] = 0;
        data.compileTime[slot] = 0;
        data.inspector[slot] = 0;
        (this._passFigures[slot] ??= []);
        this._passCounts[slot] = 0;
        this._events[slot] = null;
        this._loads[slot] = null;
        this._startup = true;
        this.startedAtStartup = true;
        this._begun = true;
        this._ended = false;

        if (typeof performance.getEntriesByType === 'function') {
            for (const entry of performance.getEntriesByType('resource')) this._addRequest(entry);
            const page = /** @type {any} */ (performance.getEntriesByType('navigation')[0]);
            if (page) {
                for (const [name, time] of [['Page received', page.responseEnd], ['DOM interactive', page.domInteractive], ['DOM ready', page.domContentLoadedEventEnd], ['Page load', page.loadEventEnd]]) {
                    if (time > 0) this._addMilestone(name, time);
                }
            }
        }
        this.version++;
    }

    /**
     * Ends the entry of the start of the app, as its first frame begins.
     *
     * @param {number} now - When the first frame began.
     * @private
     */
    _endStartup(now) {
        const slot = this._end % this._slots;
        this.data.width[slot] = now;
        this._startup = false;
        this._end++;
        this.version++;
    }

    /**
     * @param {number} now - When the frame began.
     * @private
     */
    _begin(now) {
        const slot = this._end % this._slots;
        const data = this.data;
        data.tick[slot] = now;
        data.interval[slot] = NaN;
        data.inspector[slot] = 0;
        data.inspectorStart[slot] = NaN;
        data.compiles[slot] = 0;
        data.compileTime[slot] = 0;
        data.gpu[slot] = NaN;
        this._passFigures[slot] ??= [];
        this._passCounts[slot] = 0;
        this._events[slot] = null;
        this._loads[slot] = null;
        data.kind[slot] = ENTRY_FRAME;
        data.width[slot] = NaN;
        const scripts = this._unhook ? 0 : NaN;
        for (const key of SCRIPT_CHANNELS) data[key][slot] = scripts;
        data.scriptsUpdateStart[slot] = NaN;
        data.scriptsPostStart[slot] = NaN;
        const figures = this._scriptTimes[slot];
        const needed = this.scriptNames.length * SCRIPT_STRIDE;
        if (figures && figures.length >= needed) figures.fill(0);
        else this._scriptTimes[slot] = new Float32Array(needed);
        this._scriptOrder[0] = 0;
        this._scriptOrder[1] = 0;
        this._phaseCalls.fill(0);
        this._begun = true;
        this._ended = false;
    }

    /**
     * The work of the frame has ended: takes its CPU timings, and memory and resources as it left
     * them.
     *
     * @private
     */
    _onFrameEnd() {
        if (!this._begun) return;
        this._ended = true;

        const app = this._app;
        const device = app.graphicsDevice;
        const stats = app.stats;
        const frame = stats.frame;
        const data = this.data;
        const slot = this._end % this._slots;

        data.end[slot] = performance.now();
        data.appFrame[slot] = app.frame ?? NaN;

        // a frame that rendered nothing leaves the render time of the last one that did
        const version = device.renderVersion;
        const rendered = version !== this._lastVersion;
        this._lastVersion = version;
        data.version[slot] = rendered ? version : -1;

        data.update[slot] = frame.updateTime;
        data.updateStart[slot] = frame.updateStart;
        data.systems[slot] = frame.scriptUpdate;
        data.systemsStart[slot] = frame.scriptUpdateStart;
        // the physics time stays from the last step, so it counts only when this frame stepped
        const physicsStart = frame.physicsStart;
        const stepped = physicsStart >= frame.scriptUpdateStart && physicsStart <= frame.scriptUpdateStart + frame.scriptUpdate;
        data.physics[slot] = stepped ? frame.physicsTime : 0;
        data.physicsStart[slot] = stepped ? physicsStart : NaN;
        data.anim[slot] = frame.animUpdate;
        data.animStart[slot] = frame.animUpdateStart;
        data.post[slot] = frame.scriptPostUpdate;
        data.postStart[slot] = frame.scriptPostUpdateStart;
        data.render[slot] = rendered ? frame.renderTime : 0;
        data.renderStart[slot] = rendered ? frame.renderStart : NaN;
        data.cpu[slot] = data.update[slot] + data.render[slot];
        // the inspector's time inside the update is all counted by the time the frame's work ends
        data.cpuOther[slot] = Math.max(0, data.update[slot] - data.systems[slot] - data.anim[slot] - data.post[slot] - data.inspector[slot]);
        if (data.scriptsTotal[slot] >= 0) {
            // the scripts' own time comes out of the update of the systems and the post-update
            // they ran in, and so does the cost of timing them, which is the inspector's
            const updateCost = this._phaseCalls[0] * this.callCost;
            const postCost = this._phaseCalls[1] * this.callCost;
            data.scriptCost[slot] = updateCost + postCost;
            data.scripts[slot] = data.scriptsUpdate[slot] + data.scriptsPost[slot];
            data.cpuSystems[slot] = Math.max(0, data.systems[slot] - data.physics[slot] - data.scriptsUpdate[slot] - updateCost);
            data.cpuPost[slot] = Math.max(0, data.post[slot] - data.scriptsPost[slot] - postCost);
            data.inspector[slot] += updateCost + postCost;
        } else {
            data.cpuSystems[slot] = Math.max(0, data.systems[slot] - data.physics[slot]);
            data.cpuPost[slot] = data.post[slot];
        }
        data.cpuApp[slot] = data.cpu[slot] - data.inspector[slot];
        // accumulated through the frame from the worker's reports, and reset once it ends
        data.splatSort[slot] = frame.gsplatSort ?? 0;

        // the batcher works at the start of the render, timed by the profiler and debug engines:
        // the dynamic batches updated, and the batches created of the groups changed since
        const batcher = batcherStats(app);
        if (batcher && Number.isFinite(batcher.updateLastFrameTime)) {
            const created = Number.isFinite(this._batchCreated) ? Math.max(0, batcher.createTime - this._batchCreated) : 0;
            this._batchCreated = batcher.createTime;
            data.batchCreate[slot] = created;
            data.batching[slot] = (rendered ? batcher.updateLastFrameTime : 0) + created;
        } else {
            data.batching[slot] = NaN;
            data.batchCreate[slot] = NaN;
        }

        // the app's own counters, as the frame left them
        const user = stats.user;
        if (user instanceof Map) {
            const rings = this.counterRings;
            for (let i = 0; i < rings.length; i++) rings[i][slot] = NaN;
            this._counterSlot = slot;
            user.forEach(this._takeCounter);
        }

        const vram = stats.vram;
        data.vramTex[slot] = vram?.tex ?? NaN;
        data.vramVb[slot] = vram?.vb ?? NaN;
        data.vramIb[slot] = vram?.ib ?? NaN;
        data.vramUb[slot] = vram?.ub ?? 0;
        data.vramSb[slot] = vram?.sb ?? 0;
        data.vram[slot] = data.vramTex[slot] + data.vramVb[slot] + data.vramIb[slot] + data.vramUb[slot] + data.vramSb[slot];
        data.heap[slot] = heapSize();

        data.textures[slot] = device.textures?.size ?? NaN;
        data.targets[slot] = device.targets?.size ?? NaN;
        data.shaders[slot] = device.shaders?.length ?? NaN;
        data.buffers[slot] = device.buffers?.size ?? NaN;
        data.pipelines[slot] = pipelineCount(device);
    }

    /**
     * Completes the frame being recorded with its interval, which ends now, and the counters the
     * engine has just published for it.
     *
     * @param {number} now - When the next frame began.
     * @private
     */
    _complete(now) {
        const stats = this._app.stats;
        const frame = stats.frame;
        const drawCalls = stats.drawCalls;
        const data = this.data;
        const slot = this._end % this._slots;

        data.interval[slot] = now - data.tick[slot];
        // on the time axis, after the entry before it, with a long time between them folded
        data.width[slot] = data.interval[slot];
        if (this.has(this._end - 1)) {
            const prev = (this._end - 1) % this._slots;
            const gap = Math.max(0, data.tick[slot] - data.tick[prev] - data.width[prev]);
            data.gap[slot] = gap > GAP_FOLD ? gap : 0;
            data.pos[slot] = data.pos[prev] + data.width[prev] + (gap > GAP_FOLD ? FOLDED_GAP : gap);
        } else {
            data.gap[slot] = 0;
            data.pos[slot] = 0;
        }
        data.draws[slot] = drawCalls?.total ?? NaN;
        data.dispatches[slot] = frame.computeDispatches ?? NaN;
        data.computePasses[slot] = frame.computePasses ?? NaN;
        data.splats[slot] = frame.gsplats ?? NaN;

        if (this.detailed) {
            data.cull[slot] = frame.cullTime;
            data.sort[slot] = frame.sortTime;
            data.skin[slot] = frame.skinTime;
            data.morph[slot] = frame.morphTime;
            data.shadows[slot] = frame.shadowMapTime;
            data.forward[slot] = frame.forwardTime;
            data.clusters[slot] = frame.lightClustersTime;
            data.clusterCount[slot] = frame.lightClusters;
            data.drawsForward[slot] = drawCalls.forward;
            data.drawsShadow[slot] = drawCalls.shadow;
            data.drawsMisc[slot] = drawCalls.misc;
            data.drawsSkinned[slot] = drawCalls.skinned;
            data.primitives[slot] = frame.primitives;
            data.materialSwitches[slot] = frame.materials;
            data.shaderSwitches[slot] = frame.shaders;
            data.cameras[slot] = frame.cameras;
            data.shadowUpdates[slot] = frame.shadowMapUpdates;
        } else {
            for (const key of DETAILED_CHANNELS) data[key][slot] = NaN;
        }

        this._end++;
        this.version++;
    }

    /**
     * Times every method of a script the engine calls from now on, by wrapping the one method of
     * the script components that calls them. Measures what timing a call costs the first time.
     *
     * @private
     */
    _hookScripts() {
        if (this._unhook) return;
        const proto = scriptPrototype(this._app);
        if (!proto) return;
        const original = proto._scriptMethod;
        const app = this._app;
        const capture = this;
        let on = true;
        // a call's own time leaves out the calls nested in it, which are timed apart
        const timed = function (script, method, arg) {
            if (!on || this.system?.app !== app) return original.call(this, script, method, arg);
            const outer = capture._nested;
            const outermost = capture._depth === 0;
            if (outermost) capture._phase = method === 'update' ? 0 : method === 'postUpdate' ? 1 : 2;
            capture._nested = 0;
            capture._depth++;
            const start = performance.now();
            try {
                return original.call(this, script, method, arg);
            } finally {
                const total = performance.now() - start;
                capture._depth--;
                capture._addScript(script, method, start, total - capture._nested, outermost);
                capture._nested = outer + total;
            }
        };
        if (Number.isNaN(this.callCost)) {
            this.callCost = this._measureCallCost(timed, original);
            this.clockStep = clockStep();
        }
        proto._scriptMethod = timed;
        this._unhook = () => {
            on = false;
            // another tool that wrapped the method since keeps this wrapper, which now only passes
            // calls on
            if (proto._scriptMethod === timed) proto._scriptMethod = original;
        };
    }

    /**
     * Stops timing scripts. The frame under way was timed only in part, so it has no script times.
     *
     * @private
     */
    _unhookScripts() {
        if (!this._unhook) return;
        this._unhook();
        this._unhook = null;
        this._depth = 0;
        this._nested = 0;
        if (this._begun) {
            const slot = this._end % this._slots;
            for (const key of SCRIPT_CHANNELS) this.data[key][slot] = NaN;
        }
    }

    /**
     * @param {Function} timed - The wrapper timing script calls.
     * @param {Function} original - The engine's own method it wraps.
     * @returns {number} What timing a call costs, in milliseconds: an empty call made through the
     * wrapper less one made directly, the best of a few rounds.
     * @private
     */
    _measureCallCost(timed, original) {
        const component = { system: { app: this._app } };
        const script = { __scriptType: { __name: '' }, update() {} };
        const round = (method) => {
            const start = performance.now();
            for (let i = 0; i < PROBE_CALLS; i++) method.call(component, script, 'update', 0);
            return (performance.now() - start) / PROBE_CALLS;
        };
        this._probing = true;
        let wrapped = Infinity;
        let bare = Infinity;
        for (let i = 0; i < PROBE_ROUNDS; i++) {
            wrapped = Math.min(wrapped, round(timed));
            bare = Math.min(bare, round(original));
        }
        this._probing = false;
        return Math.max(0, wrapped - bare);
    }

    /**
     * Adds a timed script call to the frame being recorded.
     *
     * @param {any} script - The script instance.
     * @param {string} method - The method called.
     * @param {number} start - When the call began.
     * @param {number} self - Its own time, without the calls nested in it.
     * @param {boolean} outermost - Whether it was not nested in another.
     * @private
     */
    _addScript(script, method, start, self, outermost) {
        if (!this._begun || this._probing) return;
        const slot = this._end % this._slots;
        const data = this.data;
        // a frame begun before scripts were timed has none of their times
        if (!(data.scriptsTotal[slot] >= 0)) return;
        const type = script.__scriptType;
        const name = type?.__name ?? 'script';
        let id = this._scriptIds.get(name);
        if (id === undefined) {
            id = this.scriptNames.length;
            this.scriptNames.push(name);
            this._scriptIds.set(name, id);
        }
        if (this.scriptClasses[id] !== type) this.scriptClasses[id] = type;
        let times = this._scriptTimes[slot];
        const base = id * SCRIPT_STRIDE;
        if (times.length < base + SCRIPT_STRIDE) {
            // a type new to the capture: room for every type known
            const grown = new Float32Array(this.scriptNames.length * SCRIPT_STRIDE);
            grown.set(times);
            this._scriptTimes[slot] = times = grown;
        }
        const column = method === 'update' ? 0 : method === 'postUpdate' ? 1 : 2;
        times[base + column] += self;
        if (column < 2 && times[base + SCRIPT_CALLS + column] === 0) times[base + SCRIPT_ORDER + column] = ++this._scriptOrder[column];
        times[base + SCRIPT_CALLS + column]++;
        data.scriptsTotal[slot] += self;
        data.scriptCalls[slot]++;
        if (column === 2) data.scriptsInit[slot] += self;
        const phase = this._phase;
        this._phaseCalls[phase]++;
        if (phase === 0) {
            data.scriptsUpdate[slot] += self;
            if (outermost && Number.isNaN(data.scriptsUpdateStart[slot])) data.scriptsUpdateStart[slot] = start;
        } else if (phase === 1) {
            data.scriptsPost[slot] += self;
            if (outermost && Number.isNaN(data.scriptsPostStart[slot])) data.scriptsPostStart[slot] = start;
        }
    }

    /**
     * Takes GPU timings that have resolved since the last frame, and stores them with the frame
     * they describe.
     *
     * @private
     */
    _resolveGpu() {
        const profiler = this._app.graphicsDevice.gpuProfiler;
        if (!profiler?.enabled) return;
        const frameTime = profiler.frameTime;
        if (frameTime === undefined) return;

        let seq = -1;
        if (this.gpuExact) {
            const version = profiler.renderVersion;
            if (version < 0 || version === this._gpuSeen) return;
            this._gpuSeen = version;
            const first = Math.max(this.first, this._end - GPU_LATENCY_FRAMES);
            for (let s = this._end - 1; s >= first; s--) {
                if (this.data.version[s % this._slots] === version) {
                    seq = s;
                    break;
                }
            }
        } else {
            // the engine does not say which frame the timings describe: a change in them is a new
            // result, given to the newest frame
            if (frameTime === this._gpuSeen) return;
            this._gpuSeen = frameTime;
            seq = this._end - 1;
        }
        if (!this.has(seq)) return;

        const slot = seq % this._slots;
        this.data.gpu[slot] = frameTime;
        this._gpuSlot = slot;
        this._passCounts[slot] = 0;
        // each pass apart where the engine keeps them so, else those sharing a name summed
        const inOrder = profiler.passTimingsInOrder;
        if (inOrder) {
            for (let i = 0; i < inOrder.names.length; i++) this._addPass(inOrder.times[i], inOrder.names[i]);
        } else {
            profiler.passTimings.forEach(this._addPass);
        }
        this._matchOwners(slot);
        this.version++;
    }

    /**
     * Finds the effect running each timed pass of a slot in the frame graph: the pass it is a
     * before or after pass of, where that pass runs only passes of its own. A pass running effects
     * that run passes, as a camera frame does, is a frame rather than an effect, so what it runs
     * directly counts as passes of their own. The passes are matched by name in the order they
     * ran, against the frame graph as it is now, as the timings arrive a few frames late; where
     * too few match, as when the frame graph has changed, no pass gets an owner.
     *
     * @param {number} slot - The slot.
     * @private
     */
    _matchOwners(slot) {
        const figures = this._passFigures[slot];
        const count = this._passCounts[slot];
        const frameGraph = /** @type {any} */ (this._app).frameGraph;
        // engines before 2.24 name the list renderPasses
        const passes = frameGraph?.passes ?? frameGraph?.renderPasses ?? [];
        const match = this._match;

        // the frame graph and the timed names as the owners were last matched for
        let same = match.graph.length === passes.length && match.timed.length === count;
        for (let i = 0; same && i < passes.length; i++) same = match.graph[i] === passes[i].name;
        for (let i = 0; same && i < count; i++) same = match.timed[i] === figures[i * PASS_STRIDE];
        if (!same) {
            match.graph = passes.map(pass => pass.name);
            match.timed = [];
            for (let i = 0; i < count; i++) match.timed.push(figures[i * PASS_STRIDE]);
            match.result = this._findOwners(passes, figures, count);
        }
        for (let i = 0; i < count; i++) {
            const base = i * PASS_STRIDE;
            figures[base + 2] = match.result[i * 3];
            figures[base + 3] = match.result[i * 3 + 1];
            figures[base + 4] = match.result[i * 3 + 2];
        }
    }

    /**
     * @param {any[]} passes - The passes of the frame graph.
     * @param {number[]} figures - The figures of the timed passes.
     * @param {number} count - How many passes were timed.
     * @returns {number[]} For each timed pass, the id of its owner's name, which of the passes of
     * the frame graph with its name it is, and which with its owner's name its owner is; -1 for
     * each where unknown.
     * @private
     */
    _findOwners(passes, figures, count) {
        // the passes in the order they ran, the passes of the views of a multi-view pass after it
        const graph = [];
        for (const pass of passes) {
            graph.push(pass);
            if (Array.isArray(pass.children)) graph.push(...pass.children);
        }
        const parentOf = new Map();
        const mark = (pass) => {
            for (const child of nestedPasses(pass)) {
                parentOf.set(child, pass);
                mark(child);
            }
        };
        passes.forEach(mark);
        // an effect runs passes that run none of their own
        const isEffect = pass => nestedPasses(pass).length > 0 && nestedPasses(pass).every(child => nestedPasses(child).length === 0);
        const names = graph.map(profilerName);
        const occurrences = [];
        const seen = new Map();
        for (const name of names) {
            occurrences.push(seen.get(name) ?? 0);
            seen.set(name, (seen.get(name) ?? 0) + 1);
        }

        const result = [];
        let cursor = 0;
        let matched = 0;
        for (let i = 0; i < count; i++) {
            const name = this.names[figures[i * PASS_STRIDE]];
            let j = cursor;
            while (j < graph.length && names[j] !== name) j++;
            if (j === graph.length) {
                result.push(-1, -1, -1);
                continue;
            }
            matched++;
            cursor = j + 1;
            const pass = graph[j];
            const parent = parentOf.get(pass);
            const owner = isEffect(pass) ? pass : parent && isEffect(parent) ? parent : null;
            const ownerIndex = owner ? graph.indexOf(owner) : -1;
            result.push(owner ? this._nameId(profilerName(owner)) : -1, occurrences[j], ownerIndex >= 0 ? occurrences[ownerIndex] : -1);
        }
        if (matched < count * PASS_MATCH_SHARE) result.fill(-1);
        return result;
    }

    /**
     * @param {string} name - The name of a GPU pass or an effect.
     * @returns {number} Its index into {@link names}, added there when new.
     * @private
     */
    _nameId(name) {
        let id = this._nameIds.get(name);
        if (id === undefined) {
            id = this.names.length;
            this.names.push(name);
            this._nameIds.set(name, id);
        }
        return id;
    }

    /**
     * Adds a GPU pass to the frame its timings were resolved for. A callback made once, as an
     * iterator over the map of pass timings would make garbage on every frame.
     *
     * @param {number} time - The GPU time of the pass.
     * @param {string} name - Its name.
     * @private
     */
    _addPass = (time, name) => {
        const slot = this._gpuSlot;
        const figures = this._passFigures[slot];
        const base = this._passCounts[slot]++ * PASS_STRIDE;
        figures[base] = this._nameId(name);
        figures[base + 1] = time;
        figures[base + 2] = -1;
        figures[base + 3] = -1;
        figures[base + 4] = -1;
    };

    /**
     * @param {PerfEvent} event - An event of the frame being recorded.
     * @private
     */
    _addEvent(event) {
        if (!this._begun) return;
        this._addEventTo(this._end % this._slots, event);
    }

    /**
     * @param {number} slot - The slot of a frame.
     * @param {PerfEvent} event - An event of the frame.
     * @private
     */
    _addEventTo(slot, event) {
        const events = (this._events[slot] ??= []);
        if (events.length < MAX_FRAME_EVENTS) events.push(event);
        this.version++;
    }

    /**
     * Finds the frame, complete or being recorded, that began at or before a time and was still
     * going on at it.
     *
     * @param {number} time - A `performance.now()` time.
     * @returns {number} The slot of the frame, or -1 when no frame kept covers the time.
     * @private
     */
    _slotAt(time) {
        const data = this.data;
        if (this._begun) {
            const slot = this._end % this._slots;
            if (time >= data.tick[slot]) return slot;
        }
        for (let s = this._end - 1; s >= this.first; s--) {
            const slot = s % this._slots;
            if (time >= data.tick[slot]) return time < data.tick[slot] + data.width[slot] ? slot : -1;
        }
        return -1;
    }

    /**
     * @param {Asset} asset - An asset that began loading.
     * @private
     */
    _onAssetLoadStart(asset) {
        this._pending.set(asset.id, { kind: 'asset', name: asset.name, type: asset.type, id: asset.id, start: performance.now(), end: NaN });
    }

    /**
     * @param {Asset} asset - An asset that finished loading.
     * @private
     */
    _onAssetLoad(asset) {
        this._endAsset(asset, performance.now(), false);
    }

    /**
     * @param {*} err - The error.
     * @param {Asset} asset - An asset that failed to load.
     * @private
     */
    _onAssetError(err, asset) {
        if (asset) this._endAsset(asset, performance.now(), true);
    }

    /**
     * Adds an asset that ended loading to the entry it ended in, with the request of its file
     * where the browser kept it: how long the network took, and so how long the asset took after.
     *
     * @param {Asset} asset - The asset.
     * @param {number} end - When it ended.
     * @param {boolean} failed - Whether it failed.
     * @private
     */
    _endAsset(asset, end, failed) {
        const pending = this._pending.get(asset.id);
        this._pending.delete(asset.id);
        /** @type {PerfLoad} */
        const load = pending ?? { kind: 'asset', name: asset.name, type: asset.type, id: asset.id, start: NaN, end };
        load.end = end;
        if (failed) load.failed = true;
        const url = absoluteUrl(/** @type {any} */ (asset).getFileUrl?.() ?? null);
        if (url) {
            load.url = url;
            const request = this._requests.get(url);
            if (request && request.end <= end + 1) PerfCapture._linkRequest(load, request);
            else this._awaitingRequest.set(url, load);
        }
        this._addLoad(load);
    }

    /**
     * @param {PerfLoad} asset - An asset load.
     * @param {PerfLoad} request - The request of its file.
     * @private
     */
    static _linkRequest(asset, request) {
        asset.netStart = request.netStart;
        asset.netEnd = request.netEnd;
        asset.firstByte = request.firstByte;
        asset.bytes = request.bytes;
        asset.cached = request.cached;
    }

    /**
     * @param {string} name - A moment of the app or the page.
     * @param {number} time - When it was.
     * @private
     */
    _addMilestone(name, time) {
        this._addLoad({ kind: 'milestone', name, start: time, end: time });
    }

    /**
     * Adds a load to the entry it ended in, where it is kept.
     *
     * @param {PerfLoad} load - The load.
     * @private
     */
    _addLoad(load) {
        const slot = this._slotAt(load.end);
        if (slot < 0) return;
        const loads = (this._loads[slot] ??= []);
        if (loads.length < MAX_ENTRY_LOADS) loads.push(load);
        this.version++;
    }

    /**
     * @param {any} entry - A request the browser timed.
     * @private
     */
    _addRequest(entry) {
        /** @type {PerfLoad} */
        const request = {
            kind: 'request',
            name: fileName(entry.name),
            url: entry.name,
            type: entry.initiatorType,
            start: entry.startTime,
            end: entry.responseEnd,
            netStart: entry.startTime,
            netEnd: entry.responseEnd,
            firstByte: entry.responseStart,
            bytes: entry.transferSize || entry.encodedBodySize || 0,
            cached: entry.transferSize === 0 && entry.encodedBodySize > 0
        };
        this._addLoad(request);
        // the asset of the file, if it ended loading first; the maps keep the recent ones only
        const asset = this._awaitingRequest.get(entry.name);
        if (asset) {
            PerfCapture._linkRequest(asset, request);
            this._awaitingRequest.delete(entry.name);
            this.version++;
        }
        this._requests.set(entry.name, request);
        for (const map of [this._requests, this._awaitingRequest]) {
            if (map.size > MAX_ENTRY_LOADS) map.delete(map.keys().next().value);
        }
    }

    /**
     * @param {PerformanceObserverEntryList} list - The requests the browser timed.
     * @private
     */
    _onResources = (list) => {
        for (const entry of list.getEntries()) this._addRequest(entry);
    };

    /**
     * @param {PerformanceObserverEntryList} list - The paints the browser timed: its first paint and
     * its first paint of content.
     * @private
     */
    _onPaints = (list) => {
        for (const entry of list.getEntries()) {
            this._addMilestone(entry.name === 'first-contentful-paint' ? 'First content paint' : entry.name === 'first-paint' ? 'First paint' : entry.name, entry.startTime);
        }
    };

    /** @private */
    _onPreloadStart() {
        this._addMilestone('Preload start', performance.now());
    }

    /** @private */
    _onPreloadEnd() {
        this._addMilestone('Preload end', performance.now());
    }

    /** @private */
    _onAppStart() {
        this._addMilestone('App start', performance.now());
    }

    /**
     * Takes a counter of `app.stats.user` into the frame ending, keeping a ring for it the first
     * time the app sets it.
     *
     * @param {*} value - Its value.
     * @param {string} name - Its name.
     * @private
     */
    _takeCounter = (value, name) => {
        let id = this._counterIds.get(name);
        if (id === undefined) {
            if (this.counterRings.length >= MAX_COUNTERS) return;
            id = this.counterRings.length;
            this._counterIds.set(name, id);
            this.counterNames.push(String(name));
            this.counterRings.push(new Float64Array(this._slots).fill(NaN));
        }
        this.counterRings[id][this._counterSlot] = typeof value === 'number' ? value : NaN;
    };

    /**
     * @param {{ timestamp: number }} e - The event.
     * @private
     */
    _onBakeStart(e) {
        this._bakeStart = e?.timestamp ?? performance.now();
    }

    /**
     * Adds a bake of lightmaps to the frame it ran in, with the figures the lightmapper kept of it.
     *
     * @param {{ timestamp: number, target: { stats: object } }} e - The event.
     * @private
     */
    _onBakeEnd(e) {
        const end = e?.timestamp ?? performance.now();
        const start = Number.isFinite(this._bakeStart) ? this._bakeStart : end;
        this._bakeStart = NaN;
        const stats = /** @type {any} */ (e?.target?.stats ?? this._app.lightmapper?.stats ?? {});
        // not its times rendering shadow maps and the lightmaps, which add the renderer's running
        // totals for the frame after each pass, so they count the earlier passes again
        /** @type {PerfBake} */
        const bake = {
            lightmaps: stats.lightmapCount ?? NaN,
            passes: stats.renderPasses ?? NaN,
            targets: stats.fboTime ?? NaN,
            shaders: stats.shadersLinked ?? NaN,
            compile: stats.compileTime ?? NaN
        };
        this._addEvent({ kind: 'bake', name: 'Lightmaps', start, duration: end - start, bake });
    }

    /**
     * @param {{ timestamp: number }} e - The event.
     * @private
     */
    _onCompileStart(e) {
        this._compileStart = e.timestamp;
    }

    /**
     * @param {{ timestamp: number }} e - The event.
     * @private
     */
    _onCompileEnd(e) {
        this._countCompile(e.timestamp - this._compileStart);
    }

    /**
     * @param {{ timestamp: number }} e - The event.
     * @private
     */
    _onLinkStart(e) {
        this._linkStart = e.timestamp;
    }

    /**
     * @param {{ timestamp: number }} e - The event.
     * @private
     */
    _onLinkEnd(e) {
        this._countCompile(e.timestamp - this._linkStart);
    }

    /**
     * @param {number} duration - How long a shader compile or link took.
     * @private
     */
    _countCompile(duration) {
        if (!this._begun) return;
        const slot = this._end % this._slots;
        this.data.compiles[slot]++;
        if (duration >= 0) this.data.compileTime[slot] += duration;
    }

    /**
     * Gives each long animation frame the browser reports to the app frame that ran in it, naming
     * the script that ran longest.
     *
     * @param {PerformanceObserverEntryList} list - The entries.
     * @private
     */
    _onLongFrames = (list) => {
        for (const entry of /** @type {any[]} */ (list.getEntries())) {
            const start = entry.startTime;
            const scripts = [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration);
            const top = scripts[0];
            const name = top ? `${top.invoker || top.name || 'script'}${top.sourceFunctionName ? ` ${top.sourceFunctionName}` : ''}` : 'long animation frame';
            const detail = [
                `blocking ${entry.blockingDuration?.toFixed(0) ?? '?'} ms`,
                ...scripts.slice(0, 3).map(script => `${script.invoker || script.name}${script.sourceURL ? ` (${script.sourceURL.split('/').pop()})` : ''} ${script.duration.toFixed(0)} ms`)
            ].join(' · ');
            // the app's tick runs inside the browser's frame: find the frames that began within it
            const data = this.data;
            const frames = this._begun ? [this._end] : [];
            for (let s = this._end - 1; s >= this.first && data.tick[s % this._slots] >= start; s--) frames.push(s);
            let added = false;
            for (const seq of frames) {
                const slot = seq % this._slots;
                const tick = data.tick[slot];
                if (tick >= start && tick <= start + entry.duration) {
                    this._addEventTo(slot, { kind: 'long', name, start, duration: entry.duration, detail });
                    added = true;
                }
            }
            // before the first frame, the start of the app has it
            const slot = this._slotAt(start);
            if (!added && slot >= 0 && data.kind[slot] === ENTRY_STARTUP) this._addEventTo(slot, { kind: 'long', name, start, duration: entry.duration, detail });
        }
    };

    /**
     * Gives each span the app measured with `performance.measure` to the frame it started in.
     *
     * @param {PerformanceObserverEntryList} list - The entries.
     * @private
     */
    _onMeasures = (list) => {
        for (const entry of list.getEntries()) {
            const slot = this._slotAt(entry.startTime);
            if (slot >= 0) this._addEventTo(slot, { kind: 'marker', name: entry.name, start: entry.startTime, duration: entry.duration });
        }
    };
}

export { CAPTURE_FRAMES, CHANNELS, ENTRY_STARTUP, PerfCapture, SCRIPT_CALLS, SCRIPT_ORDER, SCRIPT_STRIDE };
