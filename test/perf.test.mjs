import { EventHandler, GraphNode, NullGraphicsDevice, Script } from 'playcanvas';

import { expect } from 'chai';

import { Inspector } from '../src/inspector.js';
import { PerfCapture } from '../src/perf-capture.js';
import { PerfCharts } from '../src/perf-chart.js';
import { captureJson, frameJson, rangeJson, seriesRows, toCsv } from '../src/perf-copy.js';
import {
    CPU_PARTS, EVENT_KINDS, SCRIPT_COLORS, buildPerfModel, captureNorms, eventLines, eventMask, eventUnsupported, frameVerdict,
    rangeStats, scriptLegend
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
 * Gives an app stub a script system, whose components call the methods of scripts through one
 * method, as the engine's do.
 *
 * @param {any} app - The app stub.
 * @returns {any} A script component of the app.
 */
function addScripts(app) {
    class ScriptComponent {
        constructor(system) {
            this.system = system;
        }

        _scriptMethod(script, method, arg) {
            script[method](arg);
        }
    }
    const system = { app, ComponentType: ScriptComponent };
    app.systems = { script: system };
    return new ScriptComponent(system);
}

/**
 * @param {string} name - The name of the script type.
 * @param {object} costs - How long each of its methods takes, moving the clock on.
 * @param {(script: any) => void} [inside] - Runs inside its update, as a script creating others.
 * @returns {any} A script instance.
 */
function script(name, costs, inside) {
    const spend = ms => () => {
        clock.time += ms;
    };
    const instance = { __scriptType: { __name: name } };
    for (const [method, ms] of Object.entries(costs)) instance[method] = spend(ms);
    if (inside) {
        const own = instance.update;
        instance.update = () => {
            own();
            inside(instance);
        };
    }
    return instance;
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
        // the scripts are not timed apart, so they have no part of their own
        const sum = CPU_PARTS.reduce((total, part) => total + (Number.isFinite(d[part.channel][slot]) ? d[part.channel][slot] : 0), 0);
        expect(d.scripts[slot]).to.be.NaN;
        expect(other).to.equal(0);
        expect(sum).to.equal(capture.get('cpu', 0));
        expect(capture.get('cpuApp', 0)).to.equal(capture.get('cpu', 0) - 1);
    });

    it('times each script type while asked to, a call apart from the calls nested in it', function () {
        const app = createApp();
        const component = addScripts(app);
        const original = component._scriptMethod;
        const capture = new PerfCapture(app);
        expect(capture.supports.scripts).to.be.true;
        const child = script('child', { initialize: 0.2 });
        const spawner = script('spawner', { update: 0.3 }, () => component._scriptMethod(child, 'initialize'));
        const mover = script('mover', { postUpdate: 0.25 });
        const frame = () => tick(app, {
            update: 8,
            during: () => {
                component._scriptMethod(spawner, 'update', 0.016);
                component._scriptMethod(mover, 'postUpdate', 0.016);
            }
        });

        capture.start();
        frame();
        capture.timeScripts = true;
        expect(component._scriptMethod).to.not.equal(original);
        // the clock of the test stands still while the cost of a call is measured
        capture.callCost = 0.01;
        // the frame under way when timing began is not timed; the next one is
        frame();
        frame();
        frame();
        expect(capture.get('scriptsTotal', 0)).to.be.NaN;
        expect(capture.scripts(0)).to.deep.equal([]);

        const d = capture.data;
        const s = capture.slot(1);
        expect(d.scriptsUpdate[s]).to.be.closeTo(0.5, 1e-9);
        expect(d.scriptsPost[s]).to.be.closeTo(0.25, 1e-9);
        expect(d.scriptsTotal[s]).to.be.closeTo(0.75, 1e-9);
        expect(d.scriptsInit[s]).to.be.closeTo(0.2, 1e-9);
        expect(d.scriptCalls[s]).to.equal(3);
        expect(d.scriptsUpdateStart[s]).to.equal(d.tick[s]);
        expect(capture.scripts(1).map(t => [t.name, +(t.update + t.post + t.init).toFixed(6), t.calls])).to.deep.equal([
            ['spawner', 0.3, 1], ['mover', 0.25, 1], ['child', 0.2, 1]
        ]);
        // and the class each type ran as
        expect(capture.scriptClasses[capture.scriptNames.indexOf('mover')]).to.equal(mover.__scriptType);

        // the scripts and the cost of timing them come out of the phases they ran in, the cost
        // going to the inspector, so the parts still add up to the CPU time
        expect(d.scriptCost[s]).to.be.closeTo(0.03, 1e-9);
        expect(d.inspector[s]).to.be.closeTo(0.03, 1e-9);
        expect(d.cpuSystems[s]).to.be.closeTo(4 - 0.5 - 0.02, 1e-9);
        expect(d.cpuPost[s]).to.be.closeTo(1 - 0.25 - 0.01, 1e-9);
        const sum = CPU_PARTS.reduce((total, part) => total + d[part.channel][s], 0);
        expect(sum).to.be.closeTo(d.cpu[s], 1e-9);

        // calls of another app's scripts pass through untimed
        const other = addScripts(createApp());
        Object.setPrototypeOf(other, Object.getPrototypeOf(component));
        const calls = d.scriptCalls[capture.slot(capture.end)];
        other._scriptMethod(mover, 'postUpdate');
        expect(d.scriptCalls[capture.slot(capture.end)]).to.equal(calls);

        // and the engine's own method is back once recording stops
        capture.stop();
        expect(component._scriptMethod).to.equal(original);
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
        // the app has no frame graph to say which effect runs a pass
        expect(capture.passesInOrder(1)[1]).to.deep.equal({ name: 'Compose', time: 2, owner: null, occurrence: -1, ownerOccurrence: -1 });
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
        expect(frame.gpu).to.deep.equal({ frame: 6, passes: { Forward: 4, Compose: 2 }, passList: [{ name: 'Forward', time: 4 }, { name: 'Compose', time: 2 }] });
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

describe('Performance GPU passes', function () {
    beforeEach(() => clock.install());
    afterEach(() => clock.uninstall());

    /**
     * @param {string} name - Its name.
     * @param {any[]} [before] - Its before passes.
     * @returns {any} A frame pass stub.
     */
    const pass = (name, before = []) => ({ name, beforePasses: before, afterPasses: [] });

    /**
     * @param {boolean} [matching] - Whether the frame graph matches the passes timed.
     * @returns {PerfCapture} A capture of a frame whose GPU passes are a forward pass, a bloom
     * effect of three downsample passes and two upsample passes, and a compose pass, all timed
     * apart, with a frame graph of a camera frame running them.
     */
    function recordPasses(matching = true) {
        const app = createApp();
        const names = ['Forward', 'Downsample', 'Downsample', 'Downsample', 'Upsample', 'Upsample', 'Compose'];
        const times = [2, 0.5, 0.3, 0.2, 0.2, 0.1, 0.4];
        const profiler = { enabled: true, frameTime: undefined, renderVersion: -1, passTimings: new Map(), passTimingsInOrder: { names: [], times: [] } };
        app.graphicsDevice.gpuProfiler = profiler;
        const blurs = names.slice(1, 6).map(name => pass(`RenderPass${name}`));
        const bloom = pass('FramePassBloom', blurs);
        const forward = pass('RenderPassForward');
        const compose = pass('RenderPassCompose');
        const frame = pass('FramePassCameraFrame', [forward, bloom, compose]);
        app.frameGraph = { passes: matching ? [forward, ...blurs, bloom, compose, frame] : [pass('RenderPassOther')] };
        const capture = new PerfCapture(app);
        capture.start();
        tick(app);
        tick(app);
        profiler.frameTime = 4;
        profiler.renderVersion = 1;
        profiler.passTimingsInOrder = { names, times };
        tick(app);
        return capture;
    }

    it('keeps each pass apart, with the effect running it', function () {
        const capture = recordPasses();
        expect(capture.passesInOrder(0).map(p => [p.name, p.owner, p.occurrence])).to.deep.equal([
            ['Forward', null, 0],
            ['Downsample', 'FramePassBloom', 0], ['Downsample', 'FramePassBloom', 1], ['Downsample', 'FramePassBloom', 2],
            ['Upsample', 'FramePassBloom', 0], ['Upsample', 'FramePassBloom', 1],
            ['Compose', null, 0]
        ]);
        // summed by name where asked to
        expect(capture.passes(0)[0]).to.deep.equal({ name: 'Forward', time: 2 });
        expect(capture.passes(0).find(p => p.name === 'Downsample').time).to.be.closeTo(1, 1e-9);

        // the details group the passes of each effect by name, with the time of each
        const gpu = buildPerfModel({ capture, seq: 0, range: null, gpu: { supported: true, enabled: true, enable: () => {} } }).find(s => s.key === 'gpu');
        const rows = gpu.rows.filter(row => row.depth).map(row => [row.label, row.depth]);
        expect(rows).to.deep.equal([['Forward', 1], ['Bloom', 1], ['Downsample ×3', 2], ['Upsample ×2', 2], ['Compose', 1]]);
        expect(gpu.rows.find(row => row.label === 'Downsample ×3').value.text).to.match(/0\.50, 0\.30, 0\.20$/);
    });

    it('draws the effects on the GPU line and their passes below', function () {
        const capture = recordPasses();
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        charts.pick(0);
        const bars = charts._timelineModel().bars;
        const gpu = bars.filter(bar => bar.lane === 'gpu');
        expect(gpu.map(bar => bar.name)).to.deep.equal(['Forward', 'Bloom', 'Compose']);
        const bloom = gpu[1];
        expect(bloom.duration).to.be.closeTo(1.3, 1e-9);
        expect(bloom.pass).to.deep.equal({ name: 'FramePassBloom', occurrence: 0 });
        const below = bars.filter(bar => bar.lane === 'gpuPasses');
        expect(below.map(bar => bar.label)).to.deep.equal(['Downsample 1/3', 'Downsample 2/3', 'Downsample 3/3', 'Upsample 1/2', 'Upsample 2/2']);
        // under the effect, and a run of one name labelled once
        expect(below[0].start).to.equal(bloom.start);
        expect(below.map(bar => bar.run)).to.deep.equal([3, 0, 0, 2, 0]);
        expect(below[2].pass).to.deep.equal({ name: 'Downsample', occurrence: 2 });
        charts.destroy();
    });

    it('draws every pass on one line where the frame graph does not match', function () {
        const capture = recordPasses(false);
        expect(capture.passesInOrder(0).every(p => p.owner === null && p.occurrence === -1)).to.be.true;
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        charts.pick(0);
        const bars = charts._timelineModel().bars;
        expect(bars.filter(bar => bar.lane === 'gpuPasses')).to.have.length(0);
        expect(bars.filter(bar => bar.lane === 'gpu')).to.have.length(7);
        expect(bars.find(bar => bar.lane === 'gpu' && bar.name === 'Downsample').run).to.equal(3);
        charts.destroy();
    });
});

describe('Performance scripts', function () {
    beforeEach(() => clock.install());
    afterEach(() => clock.uninstall());

    const gpu = { supported: true, enabled: false, enable: () => {} };

    /**
     * @param {boolean} [timed] - Whether to time the scripts.
     * @returns {PerfCapture} A capture of three frames, each running an ai script's update and
     * post-update and a mover script's update.
     */
    function recordScripts(timed = true) {
        const app = createApp();
        const component = addScripts(app);
        const capture = new PerfCapture(app);
        capture.timeScripts = timed;
        capture.start();
        capture.callCost = 0;
        const ai = script('ai', { update: 0.4, postUpdate: 0.1 });
        const mover = script('mover', { update: 0.2 });
        for (let i = 0; i < 3; i++) {
            tick(app, {
                update: 8,
                during: () => {
                    component._scriptMethod(ai, 'update');
                    component._scriptMethod(mover, 'update');
                    component._scriptMethod(ai, 'postUpdate');
                }
            });
        }
        tick(app);
        return capture;
    }

    it('lists each script type of a frame, and of the frames selected together', function () {
        const capture = recordScripts();
        const scripts = { enabled: true, enable: () => {} };
        const sections = buildPerfModel({ capture, seq: 1, range: null, gpu, scripts });
        const cpu = sections.find(section => section.key === 'cpu');
        expect(cpu.rows.find(row => row.key === 'scripts').value.text).to.match(/^0\.70 ms/);
        const section = sections.find(section => section.key === 'scripts');
        expect(section.rows.find(row => row.key === 'total').value.text).to.match(/^0\.70 ms/);
        const types = section.rows.filter(row => row.key.startsWith('type:'));
        expect(types.map(row => row.label)).to.deep.equal(['ai', 'mover']);
        expect(types[0].value.text).to.equal('0.50 ms · update 0.40 ms in 1 call · post-update 0.10 ms in 1 call');
        expect(types[0].value.swatch).to.equal(SCRIPT_COLORS[0]);

        const range = buildPerfModel({ capture, seq: 1, range: { from: 0, to: 2 }, gpu, scripts }).find(s => s.key === 'scripts');
        expect(range.title).to.equal('Scripts, frames 1–3');
        expect(range.rows.find(row => row.label === 'mover').value.text).to.equal('avg 0.20 ms · p95 0.20 ms · max 0.20 ms · 1 call a frame');
    });

    it('offers to turn script timing on for frames it did not time', function () {
        const capture = recordScripts(false);
        let enabled = false;
        const section = buildPerfModel({ capture, seq: 1, range: null, gpu, scripts: { enabled: false, enable: () => (enabled = true) } }).find(s => s.key === 'scripts');
        expect(section.rows).to.have.length(1);
        section.rows[0].value.actions[0].run();
        expect(enabled).to.be.true;
    });

    it('copies the times of the scripts', function () {
        const capture = recordScripts();
        const frame = /** @type {any} */ (frameJson(capture, 1));
        // kept at single precision
        expect(frame.scripts.types.ai.update).to.be.closeTo(0.4, 1e-6);
        expect(frame.scripts.types.ai.calls).to.equal(2);
        expect(frame.scripts.types.ai.postUpdateCalls).to.equal(1);
        expect(frame.cpu.scripts).to.be.closeTo(0.7, 1e-9);
        const rows = /** @type {any[]} */ (seriesRows(capture, 'scripts', 0, 2));
        expect(rows).to.have.length(3);
        expect(rows[0].mover).to.be.closeTo(0.2, 1e-6);
        expect(toCsv(rows).split('\n')[0]).to.equal('frame,total,ai,mover');
    });

    it('draws the scripts on the timeline and in a chart of their own', function () {
        const capture = recordScripts();
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        charts.pick(1);
        const bars = charts._timelineModel().bars.filter(bar => bar.lane === 'detail');
        const update = bars.find(bar => bar.name === 'Scripts');
        expect(update.duration).to.be.closeTo(0.6, 1e-9);
        expect(update.children.map(child => child.name)).to.deep.equal(['ai', 'mover']);
        expect(bars.find(bar => bar.name === 'Post-update scripts').children.map(child => child.name)).to.deep.equal(['ai']);
        // the line below breaks them down by type, back to back in the order the types first ran
        const model = charts._timelineModel();
        const types = model.bars.filter(bar => bar.lane === 'types');
        expect(types.map(bar => [bar.name, bar.calls])).to.deep.equal([['ai', 1], ['mover', 1], ['ai', 1]]);
        expect(types[1].start).to.be.closeTo(types[0].start + types[0].duration, 1e-9);
        expect(types[0].start).to.equal(update.start);
        expect(charts._scriptList().lines.map(line => [line.name, line.color])).to.deep.equal([['ai', SCRIPT_COLORS[0]], ['mover', SCRIPT_COLORS[1]]]);
        charts.destroy();
    });

    /**
     * @returns {PerfCapture} A capture of three frames running fifteen script types, the later
     * ones longer, and in the second frame a spike of the shortest.
     */
    function recordMany() {
        const app = createApp();
        const component = addScripts(app);
        const capture = new PerfCapture(app);
        capture.timeScripts = true;
        capture.start();
        capture.callCost = 0;
        const types = Array.from({ length: 15 }, (_, i) => script(`script${i}`, { update: (i + 1) / 100 }));
        const spike = script('script0', { update: 1 });
        for (let f = 0; f < 3; f++) {
            tick(app, {
                update: 8,
                during: () => {
                    for (const type of types) component._scriptMethod(type, 'update');
                    if (f === 1) component._scriptMethod(spike, 'update');
                }
            });
        }
        tick(app);
        return capture;
    }

    it('bands the pinned script types, then the longest, ranked over the frames selected', function () {
        const capture = recordMany();
        const names = legend => legend.types.map(type => type.name);
        // over the whole capture the spike makes the shortest type the longest
        const all = scriptLegend(capture, 0, 2, 10, new Set());
        expect(names(all)[0]).to.equal('script0');
        expect(all.others).to.equal(5);
        // over a frame without the spike it is the shortest, among the others
        const quiet = scriptLegend(capture, 2, 2, 10, new Set());
        expect(names(quiet)).to.deep.equal(['script14', 'script13', 'script12', 'script11', 'script10', 'script9', 'script8', 'script7', 'script6', 'script5']);
        // a type pinned comes first, whatever its time
        const pinned = scriptLegend(capture, 2, 2, 10, new Set(['script1']));
        expect(pinned.types[0]).to.include({ name: 'script1', pinned: true, color: SCRIPT_COLORS[0] });
        expect(pinned.others).to.equal(4);
        // more rows go round the colors again, lighter
        const more = scriptLegend(capture, 2, 2, 20, new Set());
        expect(more.types).to.have.length(15);
        expect(more.types[10].color).to.match(/^rgb\(/);
        expect(more.others).to.equal(0);
    });

    it('pins a script type, shows one alone, and lists what the other scripts hold', function () {
        const capture = recordMany();
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        let saved = 0;
        charts.onCollapse = () => saved++;
        charts.pick(2);
        let list = charts._scriptList();
        expect(list.controls).to.deep.equal(['more']);
        expect(list.lines.at(-1).name).to.equal('Other scripts');

        charts.togglePin('script1');
        expect(saved).to.equal(1);
        list = charts._scriptList();
        expect(list.lines[0]).to.include({ name: 'script1', pinned: true });
        // the details offer to unpin it
        const scripts = { enabled: true, enable: () => {}, rows: charts.scriptRows, pinned: charts.pinned, pin: name => charts.togglePin(name) };
        const section = buildPerfModel({ capture, seq: 2, range: null, gpu, scripts }).find(s => s.key === 'scripts');
        const row = section.rows.find(r => r.label === 'script1');
        expect(row.value.actions[0].text).to.equal('Unpin');
        row.value.actions[0].run();
        expect(charts.pinned.has('script1')).to.be.false;

        // Alt+click shows one line alone, and again shows them all
        charts.scriptRows = 20;
        list = charts._scriptList();
        expect(list.controls).to.deep.equal(['fewer']);
        charts._lineCharts.scripts = { lines: list.lines };
        charts._solo('scripts', 3);
        expect(list.lines.filter(line => !charts.hidden.has(`scripts:${line.key}`)).map(line => line.name)).to.deep.equal([list.lines[3].name]);
        charts._solo('scripts', 3);
        expect(charts.hidden.size).to.equal(0);

        // the other scripts of a frame, longest first: over the whole capture the spike gives the
        // shortest type a band, leaving five
        charts.scriptRows = 10;
        const legend = charts._scriptLegend();
        expect(charts._otherScriptLines(2, legend).map(line => line.text)).to.deep.equal([
            'script5 0.06 ms · 1 call', 'script4 0.05 ms · 1 call', 'script3 0.04 ms · 1 call', 'script2 0.03 ms · 1 call', 'script1 0.02 ms · 1 call'
        ]);
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
        // an app without a script system has no scripts to time
        const scripts = [...root.querySelectorAll('.pci-check')].find(label => label.textContent === 'Script timing').querySelector('input');
        expect(scripts.disabled).to.be.true;
        inspector.destroy();
        expect(app.hasEvent('frameupdate')).to.be.false;
    });

    it('records from the start when asked to, and from code', function () {
        const inspector = new Inspector(app, { storageKey: null, record: true });
        const root = panel(inspector);
        expect(inspector.recording).to.be.true;
        expect(app.hasEvent('frameupdate')).to.be.true;
        // the Record button shows it, though another tab is open
        const record = root.querySelector('.pci-record');
        expect(record.classList.contains('pci-active')).to.be.true;
        inspector.recording = false;
        expect(app.hasEvent('frameupdate')).to.be.false;
        expect(record.getAttribute('aria-label')).to.equal('Record');
        inspector.recording = true;
        expect(app.hasEvent('frameupdate')).to.be.true;
        inspector.destroy();
        expect(inspector.recording).to.be.false;
        inspector.recording = true;
        expect(app.hasEvent('frameupdate')).to.be.false;
    });

    it('shows a GPU pass clicked on the timeline on the Frame graph tab', function () {
        const inspector = /** @type {any} */ (new Inspector(app, { storageKey: null }));
        inspector._setTab('perf');
        inspector._perfCharts.onSelectPass({ name: 'Downsample', occurrence: 1 });
        expect(inspector._tab).to.equal('passes');
        inspector.destroy();
    });

    it('shows a script type clicked on the timeline on the Scripts tab', function () {
        class Mover extends Script {
            static scriptName = 'mover';
        }
        const inspector = /** @type {any} */ (new Inspector(app, { storageKey: null }));
        inspector._perf.scriptNames.push('mover');
        inspector._perf.scriptClasses.push(Mover);
        inspector._setTab('perf');
        inspector._perfCharts.onSelectScript(0);
        expect(inspector._tab).to.equal('scripts');
        inspector.destroy();
    });

    it('times scripts while Script timing is on, and stops when the panel goes', function () {
        const component = addScripts(app);
        const original = component._scriptMethod;
        const inspector = new Inspector(app, { storageKey: null });
        const root = panel(inspector);
        [...root.querySelectorAll('.pci-tab')].find(tab => tab.textContent === 'Performance').click();
        const toggle = [...root.querySelectorAll('.pci-check')].find(label => label.textContent === 'Script timing').querySelector('input');
        expect(toggle.disabled).to.be.false;
        toggle.click();
        root.querySelector('.pci-record').click();
        expect(component._scriptMethod).to.not.equal(original);
        inspector.destroy();
        expect(component._scriptMethod).to.equal(original);
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

    it('remembers the script types pinned and how many the Scripts chart lists', function () {
        const first = new Inspector(app, { storageKey: 'pci-perf-pins-test' });
        const charts = /** @type {any} */ (first)._perfCharts;
        charts.togglePin('mover');
        charts.scriptRows = 20;
        charts.onCollapse();
        first.destroy();
        const second = new Inspector(app, { storageKey: 'pci-perf-pins-test' });
        const restored = /** @type {any} */ (second)._perfCharts;
        expect([...restored.pinned]).to.deep.equal(['mover']);
        expect(restored.scriptRows).to.equal(20);
        second.destroy();
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
