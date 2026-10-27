/** @import { AppBase, Asset, GraphicsDevice } from 'playcanvas' */

/**
 * @typedef {object} PerfEvent
 * @ignore
 * @property {'asset'|'long'|'marker'} kind - What happened: an asset finished loading, the browser
 * reported a long animation frame, or the app measured a span with `performance.measure`.
 * @property {string} name - What it was: the asset, the script that ran longest, the measure.
 * @property {number} start - When it started, as a `performance.now()` time.
 * @property {number} duration - How long it took in milliseconds, zero for an instant.
 * @property {string} [detail] - More about it, such as the blocking time of a long frame.
 */

/**
 * @typedef {object} PerfPass
 * @ignore
 * @property {string} name - The profiler name of the pass. Passes sharing a name are summed.
 * @property {number} time - Its GPU time in milliseconds.
 */

/**
 * How many frames a capture keeps, about 17 seconds at 60 Hz: few enough that the charts show
 * them without squeezing many frames into each pixel. The oldest frames make way once it is full.
 */
const CAPTURE_FRAMES = 1000;

// how many frames back the GPU timings of a frame are looked for: they resolve a few frames late
const GPU_LATENCY_FRAMES = 16;

// the events kept per frame, so an app measuring heavily cannot grow a frame without bound
const MAX_FRAME_EVENTS = 64;

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
    // render phases, with the profiler and debug engines only
    'cull', 'sort', 'skin', 'morph', 'shadows', 'forward', 'clusters', 'clusterCount',
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
    'compiles', 'compileTime'
];

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
     * What the browser and the device report: long animation frames, the spans measured by the
     * app, the size of the JavaScript heap and the pipelines created, which only WebGPU has.
     *
     * @type {{ longFrames: boolean, measures: boolean, heap: boolean, pipelines: boolean }}
     */
    supports;

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
     * The name ids and times of the GPU passes of each slot, reused as the ring turns over.
     *
     * @type {number[][]}
     * @private
     */
    _passNames = [];

    /**
     * @type {number[][]}
     * @private
     */
    _passTimes = [];

    /**
     * The events of each slot, null for the many frames without any.
     *
     * @type {(PerfEvent[]|null)[]}
     * @private
     */
    _events = [];

    /**
     * The slot the GPU timings being taken go to.
     *
     * @private
     */
    _gpuSlot = 0;

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
            pipelines: Number.isFinite(pipelineCount(app.graphicsDevice))
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
        app.assets?.on('load', this._onAssetLoad, this);
        device.on('shader:compile:start', this._onCompileStart, this);
        device.on('shader:compile:end', this._onCompileEnd, this);
        device.on('shader:link:start', this._onLinkStart, this);
        device.on('shader:link:end', this._onLinkEnd, this);
        this._observe('long-animation-frame', this._onLongFrames);
        this._observe('measure', this._onMeasures);
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
        app.assets?.off('load', this._onAssetLoad, this);
        device.off('shader:compile:start', this._onCompileStart, this);
        device.off('shader:compile:end', this._onCompileEnd, this);
        device.off('shader:link:start', this._onLinkStart, this);
        device.off('shader:link:end', this._onLinkEnd, this);
        for (const observer of this._observers) observer.disconnect();
        this._observers.length = 0;
        this.version++;
    }

    /**
     * Forgets every frame, and numbers the next one zero.
     */
    clear() {
        this._end = 0;
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
        const slot = seq % this._slots;
        const names = this._passNames[slot];
        const times = this._passTimes[slot];
        if (!names) return [];
        const passes = names.map((id, i) => ({ name: this.names[id], time: times[i] }));
        return passes.sort((a, b) => b.time - a.time);
    }

    /**
     * @param {number} seq - The sequence number of a kept frame.
     * @returns {PerfPass[]} The GPU passes of the frame in the order they were first timed.
     */
    passesInOrder(seq) {
        const slot = seq % this._slots;
        const names = this._passNames[slot];
        const times = this._passTimes[slot];
        return names ? names.map((id, i) => ({ name: this.names[id], time: times[i] })) : [];
    }

    /**
     * @param {number} seq - The sequence number of a kept frame.
     * @returns {readonly PerfEvent[]} What happened during the frame.
     */
    events(seq) {
        return this._events[seq % this._slots] ?? NO_EVENTS;
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
     * @private
     */
    _observe(type, callback) {
        if (!observable(type)) return;
        const observer = new PerformanceObserver(callback);
        observer.observe({ type, buffered: false });
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
        if (this._begun && this._ended) this._complete(now);
        this._resolveGpu();
        this._begin(now);
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
        (this._passNames[slot] ??= []).length = 0;
        (this._passTimes[slot] ??= []).length = 0;
        this._events[slot] = null;
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
        data.cpuApp[slot] = data.cpu[slot] - data.inspector[slot];
        data.cpuSystems[slot] = Math.max(0, data.systems[slot] - data.physics[slot]);
        data.cpuOther[slot] = Math.max(0, data.update[slot] - data.systems[slot] - data.anim[slot] - data.post[slot] - data.inspector[slot]);
        // accumulated through the frame from the worker's reports, and reset once it ends
        data.splatSort[slot] = frame.gsplatSort ?? 0;

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
        this._passNames[slot].length = 0;
        this._passTimes[slot].length = 0;
        this._gpuSlot = slot;
        profiler.passTimings.forEach(this._addPass);
        this.version++;
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
        let id = this._nameIds.get(name);
        if (id === undefined) {
            id = this.names.length;
            this.names.push(name);
            this._nameIds.set(name, id);
        }
        this._passNames[this._gpuSlot].push(id);
        this._passTimes[this._gpuSlot].push(time);
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
            if (time >= data.tick[slot]) return time < data.tick[slot] + data.interval[slot] ? slot : -1;
        }
        return -1;
    }

    /**
     * @param {Asset} asset - An asset that finished loading.
     * @private
     */
    _onAssetLoad(asset) {
        this._addEvent({ kind: 'asset', name: asset.name, start: performance.now(), duration: 0 });
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
            for (const seq of frames) {
                const slot = seq % this._slots;
                const tick = data.tick[slot];
                if (tick >= start && tick <= start + entry.duration) {
                    this._addEventTo(slot, { kind: 'long', name, start, duration: entry.duration, detail });
                }
            }
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

export { CAPTURE_FRAMES, CHANNELS, PerfCapture };
