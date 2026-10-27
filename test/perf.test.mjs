import { EventHandler, GraphNode, NullGraphicsDevice } from 'playcanvas';

import { expect } from 'chai';

import { Inspector } from '../src/inspector.js';
import { PerfCapture } from '../src/perf-capture.js';
import { PerfCharts } from '../src/perf-chart.js';
import { captureJson, frameJson, rangeJson, seriesRows, toCsv } from '../src/perf-copy.js';
import {
    CPU_PARTS, EVENT_KINDS, buildPerfModel, captureNorms, eventLines, eventMask, eventUnsupported, frameVerdict, rangeStats
} from '../src/perf-view.js';
import { jsdomSetup, jsdomTeardown } from './jsdom.mjs';

/**
 * A clock the capture reads instead of the real one, so frame times are exact.
 */
const clock = {
    time: 1000,
    real: performance.now,
    install() {
        this.time = 1000;
        performance.now = () => this.time;
    },
    uninstall() {
        performance.now = this.real;
    }
};

/**
 * @param {boolean} [detailed] - Whether to stand in for a profiler engine, which counts primitives.
 * @returns {any} An app stub with what the capture reads: the stats, the device and the events.
 */
function createApp(detailed = false) {
    const app = /** @type {any} */ (new EventHandler());
    const device = new EventHandler();
    Object.assign(device, {
        renderVersion: 0,
        textures: new Set(),
        targets: new Set(),
        shaders: [],
        buffers: new Set(),
        gpuProfiler: null
    });
    app.graphicsDevice = device;
    app.assets = new EventHandler();
    app.frame = 0;
    app.stats = {
        // every frame figure the engine publishes, zero until a frame sets it
        frame: Object.fromEntries([
            'updateTime', 'updateStart', 'scriptUpdate', 'scriptUpdateStart', 'physicsTime', 'physicsStart',
            'animUpdate', 'animUpdateStart', 'scriptPostUpdate', 'scriptPostUpdateStart', 'renderTime',
            'renderStart', 'gsplatSort', 'computeDispatches', 'computePasses', 'gsplats', 'cullTime', 'sortTime',
            'skinTime', 'morphTime', 'shadowMapTime', 'forwardTime', 'lightClustersTime', 'lightClusters',
            'materials', 'shaders', 'cameras', 'shadowMapUpdates'
        ].map(key => [key, 0])),
        drawCalls: { total: 0, forward: 0, shadow: 0, misc: 0, skinned: 0 },
        vram: { tex: 1000, vb: 200, ib: 100, ub: 50, sb: 0 }
    };
    if (detailed) app.stats.frame.primitives = 0;
    return app;
}

/**
 * Runs one frame of the app the way the engine's tick does: the counters of the frame before are
 * published, then the frame updates and renders.
 *
 * @param {any} app - The app stub.
 * @param {object} [frame] - The frame.
 * @param {number} [frame.update] - Its update time.
 * @param {number} [frame.render] - Its render time, or -1 to render nothing.
 * @param {number} [frame.gap] - The time from the end of its work to the next frame.
 * @param {number} [frame.draws] - The draw calls of the frame before, published as it begins.
 * @param {number} [frame.physics] - Its physics step time, or -1 for no step.
 * @param {() => void} [frame.during] - Runs during its update.
 */
function tick(app, { update = 2, render = 3, gap = 11, draws = 10, physics = -1, during } = {}) {
    const stats = app.stats;
    const f = stats.frame;
    stats.drawCalls.total = draws;
    app.fire('frameupdate');

    app.frame++;
    f.updateStart = clock.time;
    f.scriptUpdateStart = clock.time;
    f.scriptUpdate = update / 2;
    if (physics >= 0) {
        f.physicsStart = clock.time + 0.1;
        f.physicsTime = physics;
    }
    f.animUpdateStart = clock.time + update / 2;
    f.animUpdate = update / 4;
    // the last eighth is left to the update listeners, which the inspector is one of
    f.scriptPostUpdateStart = clock.time + update * 0.75;
    f.scriptPostUpdate = update / 8;
    during?.();
    f.updateTime = update;
    clock.time += update;

    if (render >= 0) {
        app.graphicsDevice.renderVersion++;
        f.renderStart = clock.time;
        f.renderTime = render;
        clock.time += render;
    }
    app.fire('frameend');
    clock.time += gap;
}

describe('PerfCapture', function () {
    beforeEach(() => clock.install());
    afterEach(() => clock.uninstall());

    it('hooks into the app only while recording', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        expect(app.hasEvent('frameupdate')).to.be.false;
        capture.start();
        expect(app.hasEvent('frameupdate')).to.be.true;
        expect(app.hasEvent('frameend')).to.be.true;
        capture.stop();
        expect(app.hasEvent('frameupdate')).to.be.false;
        expect(app.hasEvent('frameend')).to.be.false;
    });

    it('completes a frame as the next begins, with the counters published for it then', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        tick(app, { update: 2, render: 3, gap: 11, draws: 99 });
        expect(capture.count).to.equal(0);
        tick(app, { update: 4, render: 1, gap: 5, draws: 20 });
        expect(capture.count).to.equal(1);
        expect(capture.get('interval', 0)).to.equal(16);
        expect(capture.get('update', 0)).to.equal(2);
        expect(capture.get('render', 0)).to.equal(3);
        expect(capture.get('cpu', 0)).to.equal(5);
        // published as the second frame began, so they are the first frame's
        expect(capture.get('draws', 0)).to.equal(20);
        expect(capture.get('vram', 0)).to.equal(1350);
    });

    it('drops the frame in progress when stopped, and numbers from zero after a clear', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        for (let i = 0; i < 4; i++) tick(app);
        expect(capture.count).to.equal(3);
        capture.stop();
        tick(app);
        expect(capture.count).to.equal(3);
        capture.start();
        tick(app);
        tick(app);
        expect(capture.end).to.equal(4);
        capture.clear();
        expect(capture.count).to.equal(0);
        tick(app);
        tick(app);
        expect(capture.first).to.equal(0);
        expect(capture.end).to.equal(1);
    });

    it('keeps the newest frames once full, under the same numbers', function () {
        const app = createApp();
        const capture = new PerfCapture(app, 4);
        capture.start();
        for (let i = 0; i < 8; i++) tick(app, { update: i + 1 });
        expect(capture.end).to.equal(7);
        expect(capture.count).to.equal(4);
        expect(capture.first).to.equal(3);
        expect(capture.has(2)).to.be.false;
        expect(capture.get('update', 3)).to.equal(4);
        expect(capture.get('update', 6)).to.equal(7);
    });

    it('takes the render time only from frames that rendered', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        tick(app, { render: 3 });
        tick(app, { render: -1 });
        tick(app);
        expect(capture.get('render', 1)).to.equal(0);
        expect(capture.get('version', 1)).to.equal(-1);
        expect(capture.get('version', 0)).to.equal(1);
    });

    it('counts the physics time only for frames that stepped', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        tick(app, { physics: 0.5 });
        tick(app);
        tick(app);
        expect(capture.get('physics', 0)).to.equal(0.5);
        expect(capture.get('physics', 1)).to.equal(0);
    });

    it('tells the inspector\'s own time apart from the update', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        tick(app, { update: 8, during: () => capture.addOverhead(clock.time + 7, 1) });
        tick(app);
        const d = capture.data;
        const slot = capture.slot(0);
        expect(capture.get('inspector', 0)).to.equal(1);
        const other = d[CPU_PARTS.find(part => part.key === 'other').channel][slot];
        const sum = CPU_PARTS.reduce((total, part) => total + d[part.channel][slot], 0);
        expect(other).to.equal(0);
        expect(sum).to.equal(capture.get('cpu', 0));
        expect(capture.get('cpuApp', 0)).to.equal(capture.get('cpu', 0) - 1);
    });

    it('records the render phases of a detailed engine only', function () {
        const plain = createApp();
        const plainCapture = new PerfCapture(plain);
        plainCapture.start();
        tick(plain);
        tick(plain);
        expect(plainCapture.detailed).to.be.false;
        expect(plainCapture.get('cull', 0)).to.be.NaN;

        const detailed = createApp(true);
        detailed.stats.frame.cullTime = 0.25;
        const capture = new PerfCapture(detailed);
        capture.start();
        tick(detailed);
        tick(detailed);
        expect(capture.detailed).to.be.true;
        expect(capture.get('cull', 0)).to.equal(0.25);
    });

    it('gives GPU timings to the frame whose render version they describe', function () {
        const app = createApp();
        const profiler = { enabled: true, frameTime: undefined, renderVersion: -1, passTimings: new Map() };
        app.graphicsDevice.gpuProfiler = profiler;
        const capture = new PerfCapture(app);
        capture.start();
        expect(capture.gpuExact).to.be.true;
        for (let i = 0; i < 4; i++) tick(app);
        // the timings of the second frame, rendered as version 2, resolve now
        profiler.frameTime = 6;
        profiler.renderVersion = 2;
        profiler.passTimings = new Map([['Forward', 4], ['Compose', 2]]);
        tick(app);
        expect(capture.get('gpu', 1)).to.equal(6);
        expect(capture.get('gpu', 0)).to.be.NaN;
        expect(capture.get('gpu', 3)).to.be.NaN;
        expect(capture.passes(1).map(pass => pass.name)).to.deep.equal(['Forward', 'Compose']);
        expect(capture.passesInOrder(1)[1]).to.deep.equal({ name: 'Compose', time: 2 });
    });

    it('gives GPU timings to the newest frame on an engine that does not say which frame', function () {
        const app = createApp();
        const profiler = { enabled: true, frameTime: undefined, passTimings: new Map() };
        app.graphicsDevice.gpuProfiler = profiler;
        const capture = new PerfCapture(app);
        capture.start();
        expect(capture.gpuExact).to.be.false;
        for (let i = 0; i < 3; i++) tick(app);
        profiler.frameTime = 5;
        tick(app);
        expect(capture.get('gpu', 2)).to.equal(5);
        // unchanged timings are not a new result
        tick(app);
        expect(capture.get('gpu', 3)).to.be.NaN;
    });

    it('gives an asset that loads to the frame in progress', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        tick(app, { during: () => app.assets.fire('load', { name: 'statue.glb' }) });
        tick(app);
        expect(capture.events(0).map(event => event.name)).to.deep.equal(['statue.glb']);
        expect(capture.events(1)).to.be.empty;
    });

    it('counts the shader compiles and links the device reports', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        tick(app, {
            during: () => {
                const device = app.graphicsDevice;
                device.fire('shader:compile:start', { timestamp: 10 });
                device.fire('shader:compile:end', { timestamp: 12 });
                device.fire('shader:link:start', { timestamp: 12 });
                device.fire('shader:link:end', { timestamp: 15 });
            }
        });
        tick(app);
        expect(capture.get('compiles', 0)).to.equal(2);
        expect(capture.get('compileTime', 0)).to.equal(5);
    });
});

describe('Performance model', function () {
    beforeEach(() => clock.install());
    afterEach(() => clock.uninstall());

    const gpu = { supported: true, enabled: false, enable: () => {} };

    /**
     * @param {number[]} gaps - The idle time after each frame, setting its interval.
     * @returns {PerfCapture} A capture of frames with those gaps.
     */
    function record(gaps) {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        for (const gap of gaps) tick(app, { update: 2, render: 3, gap });
        tick(app);
        return capture;
    }

    it('finds the display interval, the median frame and the hitches', function () {
        const gaps = new Array(40).fill(11.7);
        gaps[30] = 60;
        const capture = record(gaps);
        const { budget, median } = captureNorms(capture);
        expect(budget).to.be.closeTo(16.7, 1e-9);
        expect(median).to.be.closeTo(16.7, 1e-9);
        // a hitch is an event of its frame, marked on the Hitches row
        const hitch = 1 << EVENT_KINDS.findIndex(kind => kind.key === 'hitch');
        const hitches = [];
        for (let seq = capture.first; seq < capture.end; seq++) {
            if (eventMask(capture, seq) & hitch) hitches.push(seq);
        }
        expect(hitches).to.deep.equal([30]);
        expect(eventLines(capture, 30, 'hitch')[0]).to.equal('65.0 ms, 3.9× the median frame of 16.7 ms');
    });

    it('averages a range and takes its 95th percentile and largest', function () {
        const capture = record([5, 5, 5, 25]);
        const stats = rangeStats(capture, 'interval', 0, 3);
        expect(stats.count).to.equal(4);
        expect(stats.avg).to.equal(15);
        expect(stats.max).to.equal(30);
        expect(stats.p95).to.equal(30);
    });

    it('says what held a frame back', function () {
        const capture = record([11, 11, 40]);
        const d = capture.data;
        expect(frameVerdict(capture, 0, 16)).to.match(/^Waiting for the display/);
        d.gpu[capture.slot(1)] = 15.5;
        expect(frameVerdict(capture, 1, 16)).to.equal('GPU-bound');
        d.cpu[capture.slot(1)] = 15.8;
        d.gpu[capture.slot(1)] = 1;
        expect(frameVerdict(capture, 1, 16)).to.equal('CPU-bound');
        expect(frameVerdict(capture, 2, 16)).to.match(/^CPU not busy/);
    });

    it('describes a frame, offering to turn GPU timings on', function () {
        const capture = record([11, 11]);
        const sections = buildPerfModel({ capture, seq: 1, range: null, gpu });
        expect(sections.map(section => section.key)).to.deep.equal(['frame', 'cpu', 'gpu', 'work', 'memory', 'resources', 'events']);
        const cpu = sections.find(section => section.key === 'cpu');
        expect(cpu.rows.find(row => row.key === 'update').value.text).to.equal('2.00 ms · 13%');
        expect(cpu.rows.find(row => row.key === 'phases').value.text).to.match(/profiler and debug engines/);
        const timings = sections.find(section => section.key === 'gpu').rows[0].value;
        expect(timings.actions[0].text).to.equal('Turn on');
    });

    it('tells the kinds of event of a frame, a line for each event', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        tick(app);
        tick(app, {
            during: () => {
                app.assets.fire('load', { name: 'statue.glb' });
                app.graphicsDevice.textures.add({});
                app.graphicsDevice.shaders.push({});
            }
        });
        tick(app);
        const bit = key => 1 << EVENT_KINDS.findIndex(kind => kind.key === key);
        expect(eventMask(capture, 0)).to.equal(0);
        const mask = eventMask(capture, 1);
        expect(mask).to.equal(bit('asset') | bit('resource') | bit('compile'));
        expect(eventLines(capture, 1, 'resource')).to.deep.equal(['Textures 0 → 1 (+1)']);
        expect(eventLines(capture, 1, 'compile')).to.deep.equal(['Shaders 0 → 1 (+1)']);
        expect(eventLines(capture, 1, 'asset')[0]).to.match(/^statue\.glb loaded at \+/);

        // a heap that shrinks by over a megabyte is a collection
        const d = capture.data;
        d.heap[capture.slot(0)] = 50 * 1024 * 1024;
        d.heap[capture.slot(1)] = 40 * 1024 * 1024;
        expect(eventMask(capture, 1) & bit('gc')).to.not.equal(0);
        expect(eventLines(capture, 1, 'gc')[0]).to.match(/freed$/);

        const events = buildPerfModel({ capture, seq: 1, range: null, gpu }).find(section => section.key === 'events');
        expect(events.rows.map(row => row.label)).to.deep.equal(['Shaders', 'Heap shrank', 'Resources', 'Assets']);
    });

    it('says which kinds of event the browser cannot report', function () {
        const capture = new PerfCapture(createApp());
        capture.supports = { longFrames: false, measures: true, heap: false };
        expect(eventUnsupported(capture, 'long')).to.match(/long animation frames/);
        expect(eventUnsupported(capture, 'gc')).to.match(/Chromium/);
        expect(eventUnsupported(capture, 'marker')).to.equal('');
        expect(eventUnsupported(capture, 'resource')).to.equal('');
    });

    it('puts the figures of the selected range first', function () {
        const capture = record([11, 11, 11, 11]);
        const sections = buildPerfModel({ capture, seq: 2, range: { from: 0, to: 3 }, gpu });
        expect(sections[0].key).to.equal('range');
        expect(sections[0].title).to.equal('Frames 1–4');
        expect(sections[0].rows.find(row => row.key === 'interval').value.text).to.equal('avg 16.0 ms · p95 16.0 ms · max 16.0 ms');
    });
});

describe('Performance copies', function () {
    beforeEach(() => clock.install());
    afterEach(() => clock.uninstall());

    /**
     * @returns {PerfCapture} Three frames, the second timed on the GPU and loading an asset.
     */
    function record() {
        const app = createApp();
        const profiler = { enabled: true, frameTime: undefined, renderVersion: -1, passTimings: new Map() };
        app.graphicsDevice.gpuProfiler = profiler;
        const capture = new PerfCapture(app);
        capture.start();
        tick(app, { update: 2, render: 3, gap: 11 });
        tick(app, { update: 4, render: 5, gap: 7, during: () => app.assets.fire('load', { name: 'statue, "big".glb' }) });
        profiler.frameTime = 6;
        profiler.renderVersion = 2;
        profiler.passTimings = new Map([['Forward', 4], ['Compose', 2]]);
        tick(app);
        tick(app);
        return capture;
    }

    it('copies everything recorded for a frame, leaving out what the engine did not provide', function () {
        const capture = record();
        const frame = /** @type {any} */ (frameJson(capture, 1));
        expect(frame.frame).to.equal(2);
        expect(frame.interval).to.equal(16);
        expect(frame.cpu.total).to.equal(9);
        expect(frame.cpu.update).to.equal(4);
        expect(frame.cpu.render).to.equal(5);
        expect(frame.cpu).to.not.have.property('renderPhases');
        expect(frame.gpu).to.deep.equal({ frame: 6, passes: { Forward: 4, Compose: 2 } });
        expect(frame.memory.textures).to.equal(1000);
        expect(frame.draws).to.not.have.property('forward');
        expect(frame.events[0]).to.include({ kind: 'asset', name: 'statue, "big".glb' });
        expect(/** @type {any} */ (frameJson(capture, 0))).to.not.have.property('gpu');
    });

    it('copies the capture with its frames, and the figures of a range', function () {
        const capture = record();
        const all = /** @type {any} */ (captureJson(capture, 0, 2, { type: 'webgl2' }));
        expect(all.frames.length).to.equal(3);
        expect(all.range).to.deep.equal({ from: 1, to: 3, frames: 3 });
        expect(all.device.type).to.equal('webgl2');
        expect(all.engineBuild).to.equal('release');
        const range = /** @type {any} */ (rangeJson(capture, 0, 1));
        expect(range.range).to.deep.equal({ from: 1, to: 2, frames: 2 });
        expect(range.interval.avg).to.equal(16);
        expect(range.cpu.max).to.equal(9);
    });

    it('copies a series a row per frame, as JSON rows or as CSV', function () {
        const capture = record();
        const cpu = /** @type {any[]} */ (seriesRows(capture, 'cpu', 0, 2));
        expect(cpu.map(row => row.total)).to.deep.equal([5, 9, 5]);
        const gpu = /** @type {any[]} */ (seriesRows(capture, 'gpu', 0, 2));
        expect(gpu[1]).to.deep.equal({ frame: 2, gpu: 6, 'pass Forward': 4, 'pass Compose': 2 });
        const events = /** @type {any[]} */ (seriesRows(capture, 'events', 0, 2));
        expect(events.map(row => row.frame)).to.deep.equal([2]);
        // every column any row has, and text quoted where it has to be
        const csv = toCsv([...gpu, ...events]).split('\n');
        expect(csv[0]).to.equal('frame,gpu,pass Forward,pass Compose,asset');
        expect(csv[2]).to.equal('2,6,4,2,');
        expect(csv[4]).to.match(/^2,,,,"statue, ""big"".glb loaded at \+/);
    });
});

describe('Performance timeline', function () {
    beforeEach(function () {
        jsdomSetup();
        clock.install();
    });
    afterEach(function () {
        clock.uninstall();
        jsdomTeardown();
    });

    it('shows the frame shown, or the average frame of the frames selected together', function () {
        const app = createApp();
        const profiler = { enabled: true, frameTime: undefined, renderVersion: -1, passTimings: new Map() };
        app.graphicsDevice.gpuProfiler = profiler;
        const capture = new PerfCapture(app);
        capture.start();
        tick(app, { update: 2, render: 3, gap: 11 });
        tick(app, { update: 4, render: 5, gap: 7 });
        // the GPU timed the second frame only
        profiler.frameTime = 6;
        profiler.renderVersion = 2;
        profiler.passTimings = new Map([['Forward', 4], ['Compose', 2]]);
        tick(app);
        const charts = new PerfCharts(document.createElement('div'), capture);

        charts.pick(0);
        const one = /** @type {any} */ (charts)._timelineModel();
        expect(one.title).to.equal('Frame 1');
        expect(one.interval).to.equal(16);
        // the update runs until the post-update starts, which follows it on the top row
        expect(one.bars.find(bar => bar.name === 'Update').duration).to.equal(1.5);
        expect(one.bars.filter(bar => bar.lane === 'cpu').map(bar => bar.name)).to.deep.equal(['Update', 'Post-update', 'Inspector', 'Render']);
        // the line below breaks the update down into what it times apart, the rest being a gap
        expect(one.bars.filter(bar => bar.lane === 'detail').map(bar => bar.name)).to.deep.equal(['Physics', 'Animation']);

        charts.range = { from: 0, to: 1 };
        const average = /** @type {any} */ (charts)._timelineModel();
        expect(average.title).to.equal('Frames 1–2, average');
        expect(average.frames).to.equal(2);
        expect(average.interval).to.equal(16);
        const update = average.bars.find(bar => bar.name === 'Update');
        expect(update.duration).to.equal(2.25);
        expect(update.start).to.equal(0);
        expect(average.bars.find(bar => bar.name === 'Render').start).to.equal(3);
        // the passes over the frames that timed the GPU
        const passes = average.bars.filter(bar => bar.lane === 'gpu');
        expect(passes.map(bar => [bar.name, bar.start, bar.duration])).to.deep.equal([['Forward', 0, 4], ['Compose', 4, 2]]);
        charts.destroy();
    });

    it('labels a bar with as much as fits', function () {
        // six pixels a letter
        const ctx = { measureText: text => ({ width: text.length * 6 }) };
        const fit = (name, time, room) => /** @type {any} */ (PerfCharts)._fit(ctx, name, time, room);
        expect(fit('Render', '1.30 ms', 100)).to.equal('Render 1.30 ms');
        expect(fit('Render', '1.30 ms', 40)).to.equal('Render');
        expect(fit('Render', '1.30 ms', 24)).to.equal('Ren…');
        expect(fit('Post update', '', 40)).to.equal('Post…');
        expect(fit('Render', '', 11)).to.equal('');
    });

    it('zooms into a capture shorter than the charts are wide', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        for (let i = 0; i < 51; i++) tick(app);
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        // the geometry a draw leaves: 50 frames spread over the 300 the charts show at least
        Object.assign(charts._layout, { from: 0, span: 300, plot: 300 });
        const wheel = deltaY => charts._onWheel({ deltaY, deltaX: 0, shiftKey: false, clientX: 96 + 30, clientY: 10, preventDefault() {} });
        wheel(-400);
        expect(charts._view).to.not.equal(null);
        expect(charts._view.span).to.be.below(300);
        // and back out to the whole capture
        Object.assign(charts._layout, { span: charts._view.span });
        wheel(4000);
        expect(charts._view).to.equal(null);
        charts.destroy();
    });
});

describe('Inspector Performance tab', function () {
    let app;

    beforeEach(function () {
        jsdomSetup();
        app = /** @type {any} */ (new EventHandler());
        app.graphicsDevice = new NullGraphicsDevice(document.createElement('canvas'));
        app.scene = Object.assign(new EventHandler(), { immediate: {}, defaultDrawLayer: null });
        app.systems = {};
        app.stats = createApp().stats;
        app.timeScale = 1;
        app.root = new GraphNode('root');
        app.assets = new EventHandler();
        app._entityIndex = {};
    });

    afterEach(function () {
        jsdomTeardown();
    });

    /**
     * @param {Inspector} inspector - The inspector.
     * @returns {ShadowRoot} Its panel's shadow root.
     */
    const panel = inspector => /** @type {any} */ (inspector)._host.shadowRoot;

    it('records while Record is on, and stops when the panel goes', function () {
        const inspector = new Inspector(app, { storageKey: null });
        const root = panel(inspector);
        [...root.querySelectorAll('.pci-tab')].find(tab => tab.textContent === 'Performance').click();
        const record = root.querySelector('.pci-record');
        expect(app.hasEvent('frameupdate')).to.be.false;
        record.click();
        expect(app.hasEvent('frameupdate')).to.be.true;
        expect(record.getAttribute('aria-label')).to.equal('Stop');
        expect(record.classList.contains('pci-active')).to.be.true;
        expect(root.querySelector('.pci-counts').textContent).to.equal('Recording · 0 frames');
        // the list filter has nothing to filter on this tab
        expect(root.querySelector('.pci-filter').style.display).to.equal('none');

        // the inspector's own time can be left out of the CPU chart
        const charts = /** @type {any} */ (inspector)._perfCharts;
        const toggle = [...root.querySelectorAll('.pci-check')].find(label => label.textContent === 'Inspector time').querySelector('input');
        expect(charts.showInspector).to.be.true;
        toggle.click();
        expect(charts.showInspector).to.be.false;
        inspector.destroy();
        expect(app.hasEvent('frameupdate')).to.be.false;
    });

    it('notes that GPU timings land late on an engine that does not say which frame they describe', function () {
        clock.install();
        try {
            // a profiler as engine 2.23 has it, without the render version of its timings
            app.graphicsDevice.gpuProfiler = { enabled: true, frameTime: undefined, passTimings: new Map() };
            const inspector = new Inspector(app, { storageKey: null });
            const root = panel(inspector);
            [...root.querySelectorAll('.pci-tab')].find(tab => tab.textContent === 'Performance').click();
            const record = root.querySelector('.pci-record');
            record.click();
            for (let i = 0; i < 3; i++) tick(app);
            record.click();
            const note = /** @type {any} */ (inspector)._perfNote;
            expect(note.textContent).to.match(/a few frames late/);
            expect(note.style.display).to.not.equal('none');
            inspector.destroy();
        } finally {
            clock.uninstall();
        }
    });

    it('copies the capture from the tab name, and a series as JSON or CSV', async function () {
        clock.install();
        let written = null;
        Object.defineProperty(window.navigator, 'clipboard', {
            configurable: true,
            value: { writeText: (text) => {
                written = text;
                return Promise.resolve();
            } }
        });
        try {
            const inspector = /** @type {any} */ (new Inspector(app, { storageKey: null }));
            const root = panel(inspector);
            const tab = [...root.querySelectorAll('.pci-tab')].find(t => t.textContent === 'Performance');
            tab.click();
            root.querySelector('.pci-record').click();
            for (let i = 0; i < 4; i++) tick(app);

            const items = () => [...root.querySelectorAll('.pci-menu-item')].map(item => item.textContent);
            const choose = async (text) => {
                [...root.querySelectorAll('.pci-menu-item')].find(item => item.textContent.startsWith(text)).click();
                await Promise.resolve();
            };
            tab.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true }));
            expect(root.querySelector('.pci-menu-title').textContent).to.equal('Performance');
            // figures have no links to follow deeper
            expect(items()).to.deep.equal(['Copy as JSON']);
            await choose('Copy as JSON');
            expect(JSON.parse(written).frames.length).to.equal(3);

            const series = inspector._perfCopy({ kind: 'series', key: 'cpu' });
            expect(series.title).to.equal('CPU');
            expect(inspector._copyItems(series).map(item => item.text())).to.deep.equal(['Copy as JSON', 'Copy as CSV']);
            inspector._copyItems(series)[1].run();
            await Promise.resolve();
            expect(written.split('\n')[0]).to.match(/^frame,total,update,/);
            inspector.destroy();
        } finally {
            clock.uninstall();
        }
    });

    it('remembers the sections collapsed and the lines hidden', function () {
        const first = new Inspector(app, { storageKey: 'pci-perf-test' });
        const charts = /** @type {any} */ (first)._perfCharts;
        charts.collapsed.add('events');
        charts.hidden.add('memory:vramTex');
        charts.hidden.add('events:resource');
        charts.onCollapse();
        first.destroy();
        const second = new Inspector(app, { storageKey: 'pci-perf-test' });
        const restored = /** @type {any} */ (second)._perfCharts;
        expect([...restored.collapsed]).to.deep.equal(['events']);
        expect([...restored.hidden]).to.deep.equal(['memory:vramTex', 'events:resource']);
        second.destroy();
    });

    it('steps through the frames with the arrow keys while the panel has focus', function () {
        clock.install();
        try {
            const inspector = new Inspector(app, { storageKey: null });
            const root = panel(inspector);
            [...root.querySelectorAll('.pci-tab')].find(tab => tab.textContent === 'Performance').click();
            root.querySelector('.pci-record').click();
            for (let i = 0; i < 6; i++) tick(app);
            const charts = /** @type {any} */ (inspector)._perfCharts;
            expect(charts.shown).to.equal(4);

            const key = (target, init) => target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, composed: true, ...init }));
            const button = root.querySelector('.pci-btn');
            key(button, { key: 'ArrowLeft' });
            expect(charts.shown).to.equal(3);
            expect(charts.following).to.be.false;
            // outside the panel the keys stay the app's
            key(document.body, { key: 'ArrowLeft' });
            expect(charts.shown).to.equal(3);
            key(button, { key: 'Home' });
            expect(charts.shown).to.equal(0);
            key(button, { key: 'End' });
            expect(charts.following).to.be.true;
            expect(charts.shown).to.equal(4);

            // the buttons do the same
            const buttons = [...root.querySelectorAll('.pci-btn')];
            buttons.find(b => b.textContent === '«').click();
            expect(charts.shown).to.equal(0);
            buttons.find(b => b.textContent === '»').click();
            expect(charts.following).to.be.true;
            inspector.destroy();
        } finally {
            clock.uninstall();
        }
    });
});
