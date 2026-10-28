import { EventHandler, GraphNode, NullGraphicsDevice, Script } from 'playcanvas';

import { expect } from 'chai';

import { Inspector } from '../src/inspector.js';
import { PerfCapture, SCRIPT_STRIDE } from '../src/perf-capture.js';
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
    // an app that has run its first frames, so a recording begins with frames rather than its start
    app.frame = 1;
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

/**
 * Records four frames of an app loading two assets: a model that begins loading in the first
 * frame and finishes in the third, its request told of by the browser only after that, and an
 * image that fails in the fourth.
 *
 * @returns {{ app: any, capture: PerfCapture }} The app and the capture.
 */
function recordLoads() {
    const app = createApp();
    const capture = new PerfCapture(app);
    capture.start();
    const statue = { id: 7, name: 'statue.glb', type: 'container', getFileUrl: () => 'http://localhost/statue.glb' };
    const missing = { id: 8, name: 'missing.png', type: 'texture', getFileUrl: () => 'http://localhost/missing.png' };
    tick(app, { during: () => app.assets.fire('load:start', statue) });
    tick(app, { during: () => app.assets.fire('load:start', missing) });
    tick(app, { during: () => app.assets.fire('load', statue) });
    /** @type {any} */ (capture)._addRequest({
        name: 'http://localhost/statue.glb', initiatorType: 'fetch', startTime: 1005, responseEnd: 1030, responseStart: 1010, transferSize: 5000, encodedBodySize: 4800
    });
    tick(app, { during: () => app.assets.fire('error', 'not found', missing) });
    tick(app);
    return { app, capture };
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
        expect(capture.loads(0).map(load => load.name)).to.deep.equal(['statue.glb']);
        expect(capture.loads(1)).to.be.empty;
    });

    it('begins with the start of the app when recording before its first frame', function () {
        const app = createApp();
        app.frame = 0;
        const capture = new PerfCapture(app);
        capture.start();
        expect(capture.startedAtStartup).to.be.true;
        // the first frame begins a second after the page opened
        tick(app);
        tick(app);
        tick(app);
        expect(capture.count).to.equal(3);
        expect(capture.isStartup(0)).to.be.true;
        expect(capture.get('width', 0)).to.equal(1000);
        expect(capture.label(0)).to.equal('Startup');
        expect(capture.label(1)).to.equal('Frame 1');
        expect(capture.rangeLabel(0, 2)).to.equal('Startup to frame 2');
        expect(capture.loads(0).map(load => load.name)).to.deep.equal(['First frame']);
        // the first frame follows it on the time axis
        expect(capture.get('pos', 1)).to.equal(1000);
    });

    it('begins with frames once the app has run one', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        tick(app);
        tick(app);
        expect(capture.startedAtStartup).to.be.false;
        expect(capture.isStartup(0)).to.be.false;
        expect(capture.label(0)).to.equal('Frame 1');
        expect(capture.rangeLabel(0, 0)).to.equal('Frames 1–1');
    });

    it('places the entries along their time, folding a long pause', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        for (let i = 0; i < 3; i++) tick(app);
        capture.stop();
        clock.time += 5000;
        capture.start();
        tick(app);
        tick(app);
        expect([0, 1, 2].map(seq => capture.get('pos', seq))).to.deep.equal([0, 16, 282]);
        // the pause of over five seconds is a quarter of a second on the axis, and kept as it was
        expect(capture.get('gap', 2)).to.equal(5016);
        expect(capture.posAt(1005)).to.equal(5);
        expect(capture.posAt(1032 + 2508)).to.equal(157);
        expect(capture.posAt(6048 + 5)).to.equal(287);
        expect(capture.seqAtPos(-5)).to.equal(0);
        expect(capture.seqAtPos(100)).to.equal(1);
        expect(capture.seqAtPos(282)).to.equal(2);
        expect(capture.endPos).to.equal(298);
    });

    it('keeps an asset in the frame it finished loading in, with the request of its file', function () {
        const { capture } = recordLoads();
        expect(capture.pendingLoads()).to.be.empty;
        const asset = capture.loads(2).find(load => load.kind === 'asset');
        expect(asset).to.include({ name: 'statue.glb', id: 7, type: 'container', start: 1000, end: 1032, netStart: 1005, netEnd: 1030, firstByte: 1010, bytes: 5000 });
        // the request in the frame it ended in, though the browser told of it later
        expect(capture.loads(1).map(load => [load.kind, load.name])).to.deep.equal([['request', 'statue.glb']]);
        // and a failure in the frame it failed in
        expect(capture.loads(3).find(load => load.kind === 'asset')).to.include({ name: 'missing.png', failed: true });
    });

    it('keeps an asset loading open until it ends', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        tick(app, { during: () => app.assets.fire('load:start', { id: 3, name: 'big.sog', type: 'gsplat' }) });
        tick(app);
        expect(capture.pendingLoads().map(load => load.name)).to.deep.equal(['big.sog']);
        expect(capture.loads(0)).to.be.empty;
        capture.stop();
        expect(capture.pendingLoads()).to.be.empty;
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

    it('says whether the main thread held a hitch back', function () {
        const gaps = new Array(40).fill(11.7);
        gaps[10] = 60;
        gaps[30] = 60;
        const capture = /** @type {any} */ (record(gaps));
        capture.supports = { ...capture.supports, longFrames: true };
        // the browser reported its main thread busy through one of them
        capture._addEventTo(capture.slot(10), { kind: 'long', name: 'enemyAi.update', start: capture.get('tick', 10), duration: 58 });
        expect(eventLines(capture, 10, 'hitch')[1]).to.equal('Main thread blocked 58.0 ms, longest script enemyAi.update');
        expect(eventLines(capture, 30, 'hitch')[1]).to.match(/^Main thread not blocked/);
        // a browser that does not report it says nothing either way
        capture.supports.longFrames = false;
        expect(eventLines(capture, 30, 'hitch')).to.have.length(1);
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
                app.graphicsDevice.textures.add({});
                app.graphicsDevice.shaders.push({});
            }
        });
        tick(app);
        const bit = key => 1 << EVENT_KINDS.findIndex(kind => kind.key === key);
        expect(eventMask(capture, 0)).to.equal(0);
        const mask = eventMask(capture, 1);
        expect(mask).to.equal(bit('resource') | bit('compile'));
        expect(eventLines(capture, 1, 'resource')).to.deep.equal(['Textures 0 → 1 (+1)']);
        expect(eventLines(capture, 1, 'compile')).to.deep.equal(['Shaders 0 → 1 (+1)']);

        // a heap that shrinks by over a megabyte is a collection
        const d = capture.data;
        d.heap[capture.slot(0)] = 50 * 1024 * 1024;
        d.heap[capture.slot(1)] = 40 * 1024 * 1024;
        expect(eventMask(capture, 1) & bit('gc')).to.not.equal(0);
        expect(eventLines(capture, 1, 'gc')[0]).to.match(/freed$/);

        const events = buildPerfModel({ capture, seq: 1, range: null, gpu }).find(section => section.key === 'events');
        expect(events.rows.map(row => row.label)).to.deep.equal(['Shaders', 'Heap shrank', 'Resources']);
    });

    it('compares the first frame with nothing, as the start of the app before it has no figures', function () {
        const app = createApp();
        app.frame = 0;
        const capture = new PerfCapture(app);
        capture.start();
        // the textures the app made while it started
        app.graphicsDevice.textures.add({});
        app.graphicsDevice.textures.add({});
        tick(app);
        tick(app);
        tick(app);
        const bit = key => 1 << EVENT_KINDS.findIndex(kind => kind.key === key);
        expect(capture.isStartup(0)).to.be.true;
        expect(eventMask(capture, 1) & bit('resource')).to.equal(0);
        expect(eventLines(capture, 1, 'resource')).to.be.empty;
        const resources = buildPerfModel({ capture, seq: 1, range: null, gpu }).find(section => section.key === 'resources');
        expect(resources.rows.find(row => row.key === 'textures').value.text).to.equal('2');
    });

    it('says which kinds of event the browser cannot report', function () {
        const capture = new PerfCapture(createApp());
        capture.supports = { longFrames: false, measures: true, heap: false };
        expect(eventUnsupported(capture, 'long')).to.match(/main thread is blocked/);
        expect(eventUnsupported(capture, 'gc')).to.match(/Chromium/);
        expect(eventUnsupported(capture, 'marker')).to.equal('');
        expect(eventUnsupported(capture, 'resource')).to.equal('');
    });

    it('describes the start of the app: its length, what it loaded and its moments', function () {
        const app = createApp();
        app.frame = 0;
        const capture = new PerfCapture(app);
        capture.start();
        const statue = { id: 7, name: 'statue.glb', type: 'container', getFileUrl: () => 'http://localhost/statue.glb' };
        /** @type {any} */ (capture)._addRequest({
            name: 'http://localhost/statue.glb', initiatorType: 'fetch', startTime: 1020, responseEnd: 1070, responseStart: 1030, transferSize: 0, encodedBodySize: 4800
        });
        app.assets.fire('load:start', statue);
        clock.time += 100;
        app.assets.fire('load', statue);
        tick(app);
        tick(app);
        const sections = buildPerfModel({ capture, seq: 0, range: null, gpu });
        expect(sections.map(section => section.key)).to.deep.equal(['frame', 'milestones', 'assets']);
        const [startup, moments, assets] = sections;
        expect(startup.title).to.equal('Startup');
        expect(startup.rows.find(row => row.key === 'length').value.text).to.equal('1.10 s after the page opened');
        expect(startup.rows.find(row => row.key === 'requests').value.text).to.equal('1 · 4.7 KB · 1 from the cache');
        expect(startup.rows.find(row => row.key === 'assets').value.text).to.equal('1 loaded');
        expect(moments.rows.map(row => [row.label, row.value.text])).to.deep.equal([['First frame', '1.10 s']]);
        expect(assets.rows[0].label).to.equal('statue.glb');
        expect(assets.rows[0].value.text).to.equal('container · 100.0 ms · request 50.0 ms · processing 30.0 ms · 4.7 KB, cached');
    });

    it('lists what loaded in a frame', function () {
        const { capture } = recordLoads();
        const sections = buildPerfModel({ capture, seq: 2, range: null, gpu });
        expect(sections.map(section => section.key)).to.deep.equal(['frame', 'cpu', 'loading', 'gpu', 'work', 'memory', 'resources', 'events']);
        const loading = sections.find(section => section.key === 'loading');
        expect(loading.rows.map(row => row.label)).to.deep.equal(['Assets', 'statue.glb']);
        expect(buildPerfModel({ capture, seq: 0, range: null, gpu }).some(section => section.key === 'loading')).to.be.false;
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
        expect(frame.loads[0]).to.include({ kind: 'asset', name: 'statue, "big".glb' });
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

    it('copies what loaded in a frame, from when the frame began', function () {
        const { capture } = recordLoads();
        const frame = /** @type {any} */ (frameJson(capture, 2));
        expect(frame.loads.length).to.equal(1);
        const [load] = frame.loads;
        expect(load).to.include({ kind: 'asset', name: 'statue.glb', type: 'container', start: -32, duration: 32, end: 0, bytes: 5000 });
        expect(load.request).to.deep.equal({ start: -27, duration: 25, firstByte: 5 });
        const rows = /** @type {any[]} */ (seriesRows(capture, 'loading', 0, 3));
        expect(rows.map(row => [row.frame, row.kind, row.name])).to.deep.equal([[2, 'request', 'statue.glb'], [3, 'asset', 'statue.glb'], [4, 'asset', 'missing.png']]);
        expect(rows[1]).to.include({ requestStart: -27, requestDuration: 25 });
        expect(rows[2].failed).to.be.true;
    });

    it('copies a series a row per frame, as JSON rows or as CSV', function () {
        const capture = record();
        const cpu = /** @type {any[]} */ (seriesRows(capture, 'cpu', 0, 2));
        expect(cpu.map(row => row.total)).to.deep.equal([5, 9, 5]);
        const gpu = /** @type {any[]} */ (seriesRows(capture, 'gpu', 0, 2));
        expect(gpu[1]).to.deep.equal({ frame: 2, gpu: 6, 'pass Forward': 4, 'pass Compose': 2 });
        // the events series lists only the frames that had events, and these had none
        expect(seriesRows(capture, 'events', 0, 2)).to.be.empty;
        const loading = /** @type {any[]} */ (seriesRows(capture, 'loading', 0, 2));
        // every column any row has, and text quoted where it has to be
        const csv = toCsv([...gpu, ...loading]).split('\n');
        expect(csv[0]).to.equal('frame,gpu,pass Forward,pass Compose,kind,name,end');
        expect(csv[2]).to.equal('2,6,4,2,,,');
        expect(csv[4]).to.equal('2,,,,asset,"statue, ""big"".glb",0');
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

    it('draws what loaded in a frame on lanes of its timeline', function () {
        const { capture } = recordLoads();
        const charts = new PerfCharts(document.createElement('div'), capture);
        charts.pick(1);
        const model = /** @type {any} */ (charts)._timelineModel();
        // both assets were loading through the second frame, and the request ended in it
        const loading = model.bars.filter(bar => /^(?:asset|request)\d$/.test(bar.lane));
        expect(loading.map(bar => [bar.lane, bar.name, bar.start, bar.duration])).to.deep.equal([
            ['asset0', 'statue.glb', 0, 16], ['asset1', 'missing.png', 0, 16], ['request0', 'statue.glb', 0, 14]
        ]);
        expect(loading[0].asset).to.equal(7);
        charts.destroy();
    });

    it('shows the start of the app as long as it lasted', function () {
        const app = createApp();
        app.frame = 0;
        const capture = new PerfCapture(app);
        capture.start();
        tick(app);
        tick(app);
        const charts = new PerfCharts(document.createElement('div'), capture);
        charts.pick(0);
        const model = /** @type {any} */ (charts)._timelineModel();
        expect(model.title).to.equal('Startup');
        expect(model.interval).to.equal(1000);
        expect(model.bars.filter(bar => bar.lane === 'milestones').map(bar => [bar.name, bar.start])).to.deep.equal([['First frame', 1000]]);
        charts.destroy();
    });

    it('lists what was loading over a span of the charts, by row', function () {
        const { capture } = recordLoads();
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        const items = charts._loadingItems(0, 64);
        expect(items.assets.map(item => item.load.name)).to.have.members(['statue.glb', 'missing.png']);
        expect(items.requests.map(item => item.load.name)).to.deep.equal(['statue.glb']);
        // a part of the axis before them has nothing
        const none = charts._loadingItems(-50, -10);
        expect(none.assets).to.be.empty;
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
        // a name in the gutter stops before the plot
        const drawn = [];
        const gutter = { ...ctx, fillText: (text, x) => drawn.push([text, x]) };
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), new PerfCapture(createApp())));
        charts._gutterText(gutter, 'Index buffers', 23, 0);
        charts._gutterText(gutter, 'Storage buffers', 23, 0);
        expect(drawn).to.deep.equal([['Index buffers', 23], ['Storage buff…', 23]]);
        // and fits whole once the names are made wider, within the least and the most they take
        charts.gutter = 120;
        charts._gutterText(gutter, 'Storage buffers', 23, 0);
        expect(drawn[2]).to.deep.equal(['Storage buffers', 23]);
        charts.gutter = 10;
        expect(charts.gutter).to.equal(70);
        charts.gutter = 1000;
        expect(charts.gutter).to.equal(320);
        charts.destroy();
    });

    it('pans the zoomed charts with a Shift+drag, showing a hand', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        for (let i = 0; i < 400; i++) tick(app);
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        // zoomed into a second of the capture, drawn 300 pixels wide
        charts._view = { from: 1000, span: 1000, follow: false };
        Object.assign(charts._layout, { from: 1000, span: 1000, plot: 300 });
        const event = (type, x, shiftKey = true) => ({ type, button: 0, ctrlKey: false, shiftKey, clientX: 108 + x, clientY: 10, pointerId: 1 });
        charts._onPointerMove(event('pointermove', 200));
        expect(charts._canvas.style.cursor).to.equal('grab');
        charts._onPointerMove(event('pointermove', 200, false));
        expect(charts._canvas.style.cursor).to.equal('');
        const shown = charts.shown;
        charts._onPointerDown(event('pointerdown', 200));
        expect(charts._canvas.style.cursor).to.equal('grabbing');
        // dragged left half the plot: the view moves on half its span
        charts._onPointerMove(event('pointermove', 50));
        expect(charts._view.from).to.equal(1500);
        charts._onPointerUp(event('pointerup', 50));
        expect(charts._canvas.style.cursor).to.equal('grab');
        // a pan picks no frame and selects none
        expect(charts.shown).to.equal(shown);
        expect(charts.range).to.equal(null);
        charts.destroy();
    });

    it('drags the divider beside the names to make them wider, and saves it', function () {
        const capture = new PerfCapture(createApp());
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        let saved = 0;
        charts.onCollapse = () => saved++;
        const event = (type, clientX) => ({ type, button: 0, ctrlKey: false, shiftKey: false, clientX, clientY: 10, pointerId: 1 });
        charts._onPointerMove(event('pointermove', 107));
        expect(charts._canvas.style.cursor).to.equal('col-resize');
        charts._onPointerDown(event('pointerdown', 107));
        charts._onPointerMove(event('pointermove', 137));
        expect(charts.gutter).to.equal(138);
        // the scrollbars under the charts and the timeline start where the plot does
        expect(charts._scrollbar.el.style.marginLeft).to.equal('146px');
        charts._onPointerUp(event('pointerup', 137));
        expect(saved).to.equal(1);
        charts.destroy();
    });

    it('pans the zoomed frame timeline with a Shift+drag, which clicks nothing', function () {
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), new PerfCapture(createApp())));
        // four milliseconds of a sixteen millisecond frame, drawn 200 pixels wide
        charts._timeView = { from: 2, span: 4 };
        Object.assign(charts._timeLayout, { from: 2, span: 4, length: 16, plot: 200 });
        const event = (type, x) => ({ type, button: 0, ctrlKey: false, shiftKey: true, clientX: 108 + x, clientY: 40, pointerId: 1 });
        charts._onTimelineDown(event('pointerdown', 100));
        expect(charts._timeline.style.cursor).to.equal('grabbing');
        charts._onTimelineMove(event('pointermove', 50));
        expect(charts._timeView.from).to.equal(3);
        charts._onTimelineUp(event('pointerup', 50));
        expect(charts._timeline.style.cursor).to.equal('grab');
        let selected = 0;
        charts.onSelectScript = () => selected++;
        charts._onTimelineClick(event('click', 50));
        expect(charts._timeDragged).to.be.false;
        expect(selected).to.equal(0);
        charts.destroy();
    });

    it('collapses the frame timeline to its title', function () {
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), new PerfCapture(createApp())));
        let saved = 0;
        charts.onCollapse = () => saved++;
        // the title as drawn, sixty pixels wide
        charts._timelineTitleEnd = 60;
        charts._onTimelineClick({ clientX: 20, clientY: 5 });
        expect(charts.collapsed.has('timeline')).to.be.true;
        charts._onTimelineClick({ clientX: 20, clientY: 5 });
        expect(charts.collapsed.has('timeline')).to.be.false;
        expect(saved).to.equal(2);
        charts.destroy();
    });

    it('zooms into a capture shorter than the charts are wide', function () {
        const app = createApp();
        const capture = new PerfCapture(app);
        capture.start();
        for (let i = 0; i < 51; i++) tick(app);
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        // the geometry a draw leaves: 50 frames of 16 ms spread over the 5 s the charts show at least
        Object.assign(charts._layout, { from: 0, span: 5000, plot: 300 });
        const wheel = deltaY => charts._onWheel({ deltaY, deltaX: 0, shiftKey: false, clientX: 108 + 30, clientY: 10, preventDefault() {} });
        wheel(-400);
        expect(charts._view).to.not.equal(null);
        expect(charts._view.span).to.be.below(5000);
        // no closer than a quarter of a second
        for (let i = 0; i < 20; i++) {
            Object.assign(charts._layout, { from: charts._view.from, span: charts._view.span });
            wheel(-400);
        }
        expect(charts._view.span).to.equal(250);
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

    it('keeps the passes a forward pass renders first, its internal before-passes, apart from it', function () {
        // engine 2.24 renders the directional shadows of a forward pass as its internal
        // before-passes; they are what the frame needs ahead of the pass, so they are not grouped
        // under it as the passes of an effect are
        const app = createApp();
        const profiler = { enabled: true, frameTime: undefined, renderVersion: -1, passTimings: new Map(), passTimingsInOrder: { names: [], times: [] } };
        app.graphicsDevice.gpuProfiler = profiler;
        const shadow = pass('RenderPassShadowDirectional');
        const forward = { ...pass('RenderPassForward'), internalBeforePasses: [shadow] };
        const compose = pass('RenderPassCompose');
        app.frameGraph = { passes: [shadow, forward, compose] };
        const capture = new PerfCapture(app);
        capture.start();
        tick(app);
        tick(app);
        profiler.frameTime = 2;
        profiler.renderVersion = 1;
        profiler.passTimingsInOrder = { names: ['ShadowDirectional', 'Forward', 'Compose'], times: [0.3, 1, 0.2] };
        tick(app);

        // matched to the frame graph, each a pass of its own
        expect(capture.passesInOrder(0).map(p => [p.name, p.owner, p.occurrence])).to.deep.equal([
            ['ShadowDirectional', null, 0], ['Forward', null, 0], ['Compose', null, 0]
        ]);
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        charts.pick(0);
        const bars = charts._timelineModel().bars;
        expect(bars.filter(bar => bar.lane === 'gpu').map(bar => bar.name)).to.deep.equal(['ShadowDirectional', 'Forward', 'Compose']);
        expect(bars.filter(bar => bar.lane === 'gpuPasses')).to.have.length(0);
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
            'made up of', 'script5 0.06 ms · 1 call', 'script4 0.05 ms · 1 call', 'script3 0.04 ms · 1 call', 'script2 0.03 ms · 1 call', 'script1 0.02 ms · 1 call'
        ]);
        // a type whose calls read as no time, as the clock stepped over them, is counted apart
        const figures = capture.scriptFigures(2);
        const base = capture.scriptNames.indexOf('script1') * SCRIPT_STRIDE;
        figures.fill(0, base, base + 3);
        const lines = charts._otherScriptLines(2, legend);
        expect(lines.map(line => line.text).slice(-2)).to.deep.equal(['script2 0.03 ms · 1 call', 'and 1 call too short to time']);
        expect(lines.at(-1).muted).to.be.true;
        expect(lines[1].muted).to.be.undefined;
        charts.destroy();
    });
});

describe('Performance counters, batching and lightmaps', function () {
    beforeEach(function () {
        jsdomSetup();
        clock.install();
    });
    afterEach(function () {
        clock.uninstall();
        jsdomTeardown();
    });

    const gpu = { supported: true, enabled: false, enable: () => {} };

    /**
     * @returns {{ app: any, capture: PerfCapture }} Three frames of an app counting enemies from
     * the second and its AI time in the first two, batching each frame and creating batches in the
     * second, and baking lightmaps in the third.
     */
    function record() {
        const app = createApp(true);
        app.stats.user = new Map();
        app._batcher = { _stats: { createTime: 0, updateLastFrameTime: 0 } };
        app.lightmapper = { stats: {} };
        const capture = new PerfCapture(app);
        capture.start();
        const frames = [
            () => app.stats.user.set('ai', 0.25),
            () => {
                app.stats.user.set('enemies', 12);
                app.stats.user.set('ai', 1.5);
                app._batcher._stats.createTime += 5;
            },
            () => {
                app.stats.user.delete('ai');
                const stats = { lightmapCount: 3, renderPasses: 9, shadowMapTime: 20, forwardTime: 60, fboTime: 4, shadersLinked: 2, compileTime: 30 };
                app.graphicsDevice.fire('lightmapper:start', { timestamp: clock.time });
                app.graphicsDevice.fire('lightmapper:end', { timestamp: clock.time + 150, target: { stats } });
            }
        ];
        for (const during of frames) {
            tick(app, {
                during: () => {
                    app._batcher._stats.updateLastFrameTime = 0.2;
                    during();
                }
            });
        }
        tick(app);
        return { app, capture };
    }

    it('keeps the counters of app.stats.user as each frame ended', function () {
        const { capture } = record();
        expect(capture.supports.counters).to.be.true;
        expect(capture.counterNames).to.deep.equal(['ai', 'enemies']);
        const [ai, enemies] = capture.counterRings;
        expect([0, 1, 2].map(seq => ai[capture.slot(seq)])).to.deep.equal([0.25, 1.5, NaN]);
        expect([0, 1, 2].map(seq => enemies[capture.slot(seq)])).to.deep.equal([NaN, 12, 12]);
    });

    it('times the batching of each frame, with the batches it created', function () {
        const { capture } = record();
        expect([0, 1, 2].map(seq => capture.get('batching', seq))).to.deep.equal([0.2, 5.2, 0.2]);
        expect(capture.get('batchCreate', 1)).to.equal(5);
        const cpu = buildPerfModel({ capture, seq: 1, range: null, gpu }).find(section => section.key === 'cpu');
        expect(cpu.rows.find(row => row.key === 'batching').value.text).to.match(/ · creating batches 5\.00 ms$/);
        // an app without a batcher has no row for it
        const app = createApp(true);
        const plain = new PerfCapture(app);
        plain.start();
        tick(app);
        tick(app);
        const rows = buildPerfModel({ capture: plain, seq: 0, range: null, gpu }).find(section => section.key === 'cpu').rows;
        expect(rows.some(row => row.key === 'batching')).to.be.false;
    });

    it('marks a bake of lightmaps in the frame it ran in, with what took the time', function () {
        const { capture } = record();
        const bake = capture.events(2).find(event => event.kind === 'bake');
        expect(bake).to.include({ duration: 150 });
        expect(bake.bake).to.deep.equal({ lightmaps: 3, passes: 9, targets: 4, shaders: 2, compile: 30 });
        const bit = 1 << EVENT_KINDS.findIndex(kind => kind.key === 'bake');
        expect(eventMask(capture, 2) & bit).to.not.equal(0);
        expect(eventLines(capture, 2, 'bake')).to.deep.equal([
            '150.0 ms baking 3 lightmaps in 9 passes',
            'render targets created in 4.00 ms · 2 shaders linked in 30.0 ms'
        ]);
        expect(eventUnsupported(capture, 'bake')).to.equal('');
        // the charts have a row of bakes only for an app with a lightmapper
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        // the timeline draws it as work of the CPU, here under the update it ran inside
        charts.pick(2);
        const bars = charts._timelineModel().bars;
        expect(bars.filter(bar => bar.name === 'Lightmap bake').map(bar => [bar.lane, bar.duration])).to.deep.equal([['detail', 150]]);
        expect(bars.some(bar => bar.lane === 'events')).to.be.false;
        // one in the render, as the engine's first bake, takes the place of the render's phases,
        // whose times hold its own rendering
        charts.pick(0);
        expect(charts._timelineModel().bars.some(bar => bar.phase)).to.be.true;
        const renderStart = capture.get('renderStart', 0);
        /** @type {any} */ (capture)._addEventTo(capture.slot(0), { kind: 'bake', name: 'Lightmaps', start: renderStart + 0.5, duration: 1 });
        const inRender = charts._timelineModel().bars;
        expect(inRender.filter(bar => bar.name === 'Lightmap bake').map(bar => bar.lane)).to.deep.equal(['detail']);
        expect(inRender.some(bar => bar.phase)).to.be.false;
        expect(charts._eventKinds().map(k => EVENT_KINDS[k].key)).to.include('bake');
        const without = /** @type {any} */ (new PerfCharts(document.createElement('div'), new PerfCapture(createApp())));
        expect(without._eventKinds().map(k => EVENT_KINDS[k].key)).to.not.include('bake');
        charts.destroy();
        without.destroy();
    });

    it('lists the counters of a frame and of the frames selected together, and copies them', function () {
        const { capture } = record();
        const section = buildPerfModel({ capture, seq: 1, range: null, gpu }).find(s => s.key === 'counters');
        expect(section.rows.map(row => [row.label, row.value.text])).to.deep.equal([['ai', '1.50'], ['enemies', '12']]);
        const range = buildPerfModel({ capture, seq: 1, range: { from: 0, to: 2 }, gpu }).find(s => s.key === 'counters');
        expect(range.title).to.equal('Counters, frames 1–3');
        expect(range.rows[0].value.text).to.equal('avg 0.875 · p95 1.50 · max 1.50');
        // none for a frame the app set none in
        const app = createApp();
        const plain = new PerfCapture(app);
        plain.start();
        tick(app);
        tick(app);
        expect(buildPerfModel({ capture: plain, seq: 0, range: null, gpu }).some(s => s.key === 'counters')).to.be.false;

        expect(/** @type {any} */ (frameJson(capture, 1)).counters).to.deep.equal({ ai: 1.5, enemies: 12 });
        expect(/** @type {any} */ (frameJson(capture, 1)).cpu.renderPhases).to.include({ batching: 5.2, creatingBatches: 5 });
        expect(seriesRows(capture, 'counters', 0, 2)).to.deep.equal([{ frame: 1, ai: 0.25 }, { frame: 2, ai: 1.5, enemies: 12 }, { frame: 3, enemies: 12 }]);
        const charts = /** @type {any} */ (new PerfCharts(document.createElement('div'), capture));
        expect(charts._counterList().map(line => line.name)).to.deep.equal(['ai', 'enemies']);
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
        app.frame = 1;
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
