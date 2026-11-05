import {
    AssetRegistry, Entity, EventHandler, GraphNode, Mesh, MeshInstance, NullGraphicsDevice, PIXELFORMAT_RGBA8, RenderTarget, StandardMaterial, Texture
} from 'playcanvas';

import { expect } from 'chai';

import { Inspector } from '../src/inspector.js';
import { fitSize, textureSampling } from '../src/image-capture.js';
import { RefRegistry } from '../src/ref-registry.js';
import { jsdomSetup, jsdomTeardown } from './jsdom.mjs';

/**
 * @returns {any} An app stub with just what the inspector touches, holding a robot whose render
 * component draws two instances of one material, which samples one texture.
 */
function createApp() {
    const app = /** @type {any} */ (new EventHandler());
    const device = new NullGraphicsDevice(document.createElement('canvas'));
    app.graphicsDevice = device;
    app.scene = Object.assign(new EventHandler(), { immediate: {}, defaultDrawLayer: null, layers: { layerList: [] } });
    app.systems = { list: [] };
    app.stats = { frame: { fps: 60, ms: 16.6 }, drawCalls: { total: 2 } };
    app.timeScale = 1;
    app.root = new GraphNode('root');
    app.assets = new AssetRegistry(null);
    app._entityIndex = {};

    const texture = new Texture(device, { name: 'albedo', width: 4, height: 4, format: PIXELFORMAT_RGBA8 });
    // the null device does not track what it creates
    device.textures.add(texture);
    const material = new StandardMaterial();
    material.name = 'painted';
    material.diffuseMap = texture;
    const mesh = new Mesh(device);
    mesh.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    mesh.update();
    const robot = new Entity('robot', app);
    robot.tags.add('enemy');
    robot.c.render = /** @type {any} */ ({
        enabled: true,
        system: { app },
        meshInstances: [new MeshInstance(mesh, material, robot), new MeshInstance(mesh, material, robot)]
    });
    const arm = new Entity('robot arm', app);
    robot.addChild(arm);
    app.root.addChild(robot);
    app.root.addChild(new Entity('ground', app));
    return { app, robot, material, texture };
}

describe('Inspector MCP tools', function () {
    let app, robot, material, texture, inspector;

    beforeEach(function () {
        jsdomSetup();
        ({ app, robot, material, texture } = createApp());
    });

    afterEach(function () {
        inspector?.destroy();
        inspector = null;
        delete /** @type {any} */ (document).modelContext;
        jsdomTeardown();
    });

    describe('RefRegistry', function () {
        it('gives an object one id, prefixed with its kind, and finds it by that id', function () {
            const refs = new RefRegistry();
            const id = refs.idOf(material);
            expect(id).to.match(/^material:\d+$/);
            expect(refs.idOf(material)).to.equal(id);
            expect(refs.get(id)).to.equal(material);
            expect(refs.idOf(robot)).to.match(/^node:\d+$/);
            expect(refs.get('material:999')).to.equal(null);
        });

        it('gives a stable key one id, which finds whatever stands at the key now', function () {
            const refs = new RefRegistry();
            let current = material;
            const id = refs.keyedId('pass', '3:Forward', () => current);
            expect(id).to.match(/^pass:\d+$/);
            expect(refs.get(id)).to.equal(material);
            current = texture;
            expect(refs.keyedId('pass', '3:Forward', () => current)).to.equal(id);
            expect(refs.get(id)).to.equal(texture);
            expect(refs.keyedId('pass', '4:Bloom', () => null)).to.not.equal(id);
        });
    });

    it('offers no tools while off, and rejects calls', async function () {
        inspector = new Inspector(app, { storageKey: null });
        expect(inspector.mcp).to.be.false;
        expect(inspector.getTools()).to.deep.equal([]);
        let error;
        await inspector.executeTool('playcanvas_app_summary').catch((e) => {
            error = e;
        });
        expect(error?.message).to.match(/off/);
    });

    it('describes the tools while on: only the recording ones change anything, and never the app', function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const tools = inspector.getTools();
        expect(tools.map(t => t.name)).to.deep.equal([
            'playcanvas_app_summary', 'playcanvas_index', 'playcanvas_find_entities', 'playcanvas_list', 'playcanvas_get',
            'playcanvas_perf_record', 'playcanvas_perf_stop', 'playcanvas_perf_status', 'playcanvas_perf_summary',
            'playcanvas_perf_frame', 'playcanvas_perf_series', 'playcanvas_logs', 'playcanvas_screenshot',
            'playcanvas_pause', 'playcanvas_step'
        ]);
        const changing = ['playcanvas_perf_record', 'playcanvas_perf_stop', 'playcanvas_pause', 'playcanvas_step'];
        for (const tool of tools) {
            const changes = changing.includes(tool.name);
            expect(tool.annotations.readOnlyHint).to.equal(!changes);
            if (changes) expect(tool.annotations.destructiveHint).to.be.false;
            expect(tool.inputSchema.type).to.equal('object');
            expect(tool).to.not.have.property('execute');
        }
    });

    it('keeps what the page logs while on, counts repeats, and puts the console back when off', async function () {
        const warn = console.warn;
        const error = console.error;
        const log = console.log;
        // keep the test output quiet: the capture wraps whatever the console methods are
        console.warn = console.error = console.log = () => {};
        try {
            app.frame = 7;
            const subject = new Inspector(app, { storageKey: null });
            inspector = subject;
            console.warn('before the tools');
            subject.mcp = true;
            console.log('%cstyled %s: %d%%', 'color: red', 'level', 7.9, 'text');
            console.warn('shader', { id: 3 });
            console.warn('shader', { id: 3 });
            console.error(new Error('broken'));

            const all = await subject.executeTool('playcanvas_logs');
            expect(all.capturing).to.be.true;
            expect(all.entries.map(e => [e.level, e.text, e.count])).to.deep.equal([
                ['log', 'styled level: 7% text', 1], ['warn', 'shader {"id":3}', 2], ['error', 'Error: broken', 1]
            ]);
            expect(all.entries[0].frame).to.equal(7);
            expect(all.counts).to.include({ error: 1, warn: 2, log: 1 });

            const warnings = await subject.executeTool('playcanvas_logs', { level: 'warn' });
            expect(warnings.entries.map(e => e.level)).to.deep.equal(['warn', 'error']);
            const after = await subject.executeTool('playcanvas_logs', { since: all.entries[1].seq });
            expect(after.entries.map(e => e.text)).to.deep.equal(['Error: broken']);
            // the counts cover what was logged after since, not everything kept
            expect(after.counts).to.include({ error: 1, warn: 0, log: 0 });
            expect((await subject.executeTool('playcanvas_logs', { filter: 'SHADER' })).total).to.equal(1);

            const wrapper = console.warn;
            subject.mcp = false;
            expect(console.warn).to.not.equal(wrapper);
            console.warn('after the tools');
            expect(subject._mcpHost.logs.entries).to.have.lengthOf(3);
        } finally {
            inspector?.destroy();
            console.warn = warn;
            console.error = error;
            console.log = log;
        }
    });

    it('pauses, steps a number of frames and holds the app paused', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        app.frame = 10;
        expect(await inspector.executeTool('playcanvas_pause', { paused: true })).to.deep.equal({ paused: true, frame: 10 });
        expect(app.timeScale).to.equal(0);

        const stepping = inspector.executeTool('playcanvas_step', { frames: 3 });
        await Promise.resolve();
        expect(app.timeScale).to.equal(1);
        for (let i = 0; i < 3; i++) {
            app.frame++;
            app.fire('frameend');
        }
        const result = await stepping;
        expect(result).to.include({ paused: true, stepped: 3, from: 10, frame: 13 });
        expect(app.timeScale).to.equal(0);

        expect(await inspector.executeTool('playcanvas_pause', { paused: false })).to.include({ paused: false });
        expect(app.timeScale).to.equal(1);
    });

    it('steps fewer frames when they stop coming, and says so', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const result = await inspector.executeTool('playcanvas_step', { frames: 2, timeout: 1 });
        expect(result.stepped).to.equal(0);
        expect(result.note).to.match(/Only 0 of 2 frames/);
        expect(inspector.paused).to.be.true;
    });

    it('takes screenshots of textures and render targets only, and checks the channels', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const failure = async (args) => {
            let error;
            await inspector.executeTool('playcanvas_screenshot', args).catch((e) => {
                error = e;
            });
            return error?.message;
        };
        expect(await failure({ id: inspector._refs.idOf(material) })).to.match(/takes the id of a texture or a render target/);
        expect(await failure({ id: inspector._refs.idOf(texture), channels: 'rgbx' })).to.match(/"channels" must match/);
        const rt = new RenderTarget({ colorBuffer: texture, depth: false });
        expect(await failure({ id: inspector._refs.idOf(rt), attachment: 'depth' })).to.match(/has no depth attachment/);
    });

    it('samples textures for a capture the way the previews do, and fits images inside a size', function () {
        const device = app.graphicsDevice;
        expect(textureSampling(texture, device, 'rgb')).to.deep.include({ mode: 'filtered', encoding: texture.encoding });
        expect(textureSampling(texture, device, 'aaa').encoding).to.equal('raw');
        expect(Array.from(textureSampling(texture, device, 'aaa').channelIndices)).to.deep.equal([3, 3, 3]);
        const cube = new Texture(device, { width: 4, height: 4, cubemap: true });
        expect(textureSampling(cube, device, 'rgb')).to.match(/Only 2D color and depth textures/);
        expect(fitSize(3073, 1000, 512)).to.deep.equal({ width: 512, height: 167 });
        expect(fitSize(64, 32, 512)).to.deep.equal({ width: 64, height: 32 });
    });

    it('summarizes the app', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const summary = await inspector.executeTool('playcanvas_app_summary');
        expect(summary.entities).to.equal(4);
        expect(summary.stats).to.deep.equal({ fps: 60, ms: 16.6, drawCalls: 2 });
        expect(summary.device.type).to.equal('null');
        expect(summary.root).to.match(/^node:/);
        expect(summary.lists).to.include('textures');
    });

    it('indexes every entity and every object the lists hold in one call, with ids to get', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const index = await inspector.executeTool('playcanvas_index');
        expect(index.summary.entities).to.equal(4);
        // the root is the summary's
        expect(index.entities.entries.map(e => e.path)).to.deep.equal(['robot', 'robot/robot arm', 'ground']);
        expect(index.entities.entries[0].components).to.deep.equal(['render']);
        expect(index.entities.truncated).to.be.false;
        expect(index).to.include.keys('cameras', 'materials', 'textures', 'shaders', 'meshes', 'renderTargets', 'scripts', 'assets', 'passes');
        expect(index).to.not.have.property('memory');

        const tex = index.textures.entries.find(e => e.name === 'albedo');
        expect(inspector._refs.get(tex.$id)).to.equal(texture);
        const robotEntry = await inspector.executeTool('playcanvas_get', { id: index.entities.entries[0].$id });
        expect(robotEntry.Entity.name).to.equal('robot');
    });

    it('finds entities by name, component and tag', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const byName = await inspector.executeTool('playcanvas_find_entities', { name: 'ROBOT' });
        expect(byName.entities.map(e => e.path)).to.deep.equal(['robot', 'robot/robot arm']);
        expect(byName.entities[0].components).to.deep.equal(['render']);

        const byComponent = await inspector.executeTool('playcanvas_find_entities', { component: 'render' });
        expect(byComponent.entities.map(e => e.name)).to.deep.equal(['robot']);

        const byTag = await inspector.executeTool('playcanvas_find_entities', { tag: 'enemy', name: 'robot' });
        expect(byTag.total).to.equal(1);

        const limited = await inspector.executeTool('playcanvas_find_entities', { limit: 1 });
        expect(limited.entities).to.have.lengthOf(1);
        expect(limited.truncated).to.be.true;
    });

    it('follows links by id from an entity to the texture its material samples, and back', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const { entities } = await inspector.executeTool('playcanvas_find_entities', { component: 'render' });

        // the entity names its mesh instances, each with an id
        const entity = await inspector.executeTool('playcanvas_get', { id: entities[0].$id });
        expect(entity.$id).to.equal(entities[0].$id);
        const instances = entity.render.meshInstances;
        expect(instances[0]).to.include({ $type: 'MeshInstance', $stub: true });
        expect(instances[0].$id).to.match(/^meshInstance:/);
        expect(instances[1].$id).to.not.equal(instances[0].$id);

        const instance = await inspector.executeTool('playcanvas_get', { id: instances[0].$id });
        expect(instance.material).to.include({ $type: 'StandardMaterial', name: 'painted', $stub: true });

        const mat = await inspector.executeTool('playcanvas_get', { id: instance.material.$id });
        expect(mat['StandardMaterial "painted"'].diffuseMap).to.include({ $type: 'Texture', name: 'albedo' });

        // the texture lists the materials sampling it, as references that lead back
        const tex = await inspector.executeTool('playcanvas_get', { id: mat['StandardMaterial "painted"'].diffuseMap.$id });
        expect(JSON.stringify(tex)).to.include(instance.material.$id);

        // depth copies linked objects in place
        const deep = await inspector.executeTool('playcanvas_get', { id: instances[0].$id, depth: 1 });
        expect(deep.material.$stub).to.equal(undefined);
        expect(deep.material.$id).to.equal(instance.material.$id);
    });

    it('rejects an unknown id', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        let error;
        await inspector.executeTool('playcanvas_get', { id: 'material:12345' }).catch((e) => {
            error = e;
        });
        expect(error?.message).to.match(/No object/);
    });

    it('lists what a tab lists, with ids to get', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const textures = await inspector.executeTool('playcanvas_list', { kind: 'textures', filter: 'ALB' });
        expect(textures.total).to.equal(1);
        expect(textures.entries[0].$type).to.equal('Texture');
        expect(textures.entries[0].name).to.equal('albedo');
        expect(textures.entries[0].size).to.equal('84 B');
        expect(textures.entries[0]).to.not.have.property('info (2)');
        const tex = await inspector.executeTool('playcanvas_get', { id: textures.entries[0].$id });
        expect(tex.$type).to.equal('Texture');
        expect(inspector._refs.get(textures.entries[0].$id)).to.equal(texture);

        const memory = await inspector.executeTool('playcanvas_list', { kind: 'memory' });
        expect(memory.entries.length).to.be.greaterThan(0);
        expect(memory.entries[0]).to.have.property('group');

        let error;
        await inspector.executeTool('playcanvas_list', { kind: 'nope' }).catch((e) => {
            error = e;
        });
        expect(error?.message).to.match(/"kind" must be one of: textures/);
    });

    it('checks arguments against the input schema', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const failure = async (name, args) => {
            let error;
            await inspector.executeTool(name, args).catch((e) => {
                error = e;
            });
            return error?.message;
        };
        expect(await failure('playcanvas_get', {})).to.equal('"id" is required');
        expect(await failure('playcanvas_get', { id: 7 })).to.equal('"id" must be a string');
        expect(await failure('playcanvas_get', { id: 'node:1', depth: 9 })).to.equal('"depth" must be at most 4');
        expect(await failure('playcanvas_find_entities', { limit: 2.5 })).to.equal('"limit" must be an integer');
        expect(await failure('playcanvas_find_entities', { colour: 'red' })).to.match(/^Unknown argument "colour"/);
    });

    it('leaves out the settings of empty texture slots and the tables of a material', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const id = inspector._refs.idOf(material);
        const json = await inspector.executeTool('playcanvas_get', { id });
        const general = json['StandardMaterial "painted"'];
        // the slot in use keeps its settings
        expect(general).to.include.keys('diffuseMap', 'diffuseMapTiling', 'diffuseMapUv');
        // an empty one keeps only itself
        expect(general.normalMap).to.equal(null);
        expect(general).to.not.have.any.keys('normalMapTiling', 'normalMapUv', 'aoMapChannel', 'propertyDescriptors');
        expect(Object.keys(general).length).to.be.lessThan(200);
    });

    it('names the size of a buffer in the memory list', async function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const memory = await inspector.executeTool('playcanvas_list', { kind: 'memory', limit: 500 });
        const buffer = memory.entries.find(e => e.$type === 'VertexBuffer');
        expect(buffer).to.have.property('size');
        expect(buffer).to.not.have.property('info (2)');
    });

    it('registers the tools with WebMCP while on, keeps them while hidden, and withdraws them when off', async function () {
        const registered = [];
        /** @type {any} */ (document).modelContext = {
            registerTool: (tool, options) => {
                registered.push({ tool, signal: options.signal });
                return Promise.resolve();
            }
        };
        expect(Inspector.webMcpSupported).to.be.true;

        inspector = new Inspector(app, { storageKey: null });
        await Promise.resolve();
        expect(registered).to.have.lengthOf(0);

        inspector.mcp = true;
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(registered.map(r => r.tool.name)).to.have.lengthOf(15);
        expect(registered[0].tool.annotations.readOnlyHint).to.be.true;

        inspector.visible = false;
        expect(registered.every(r => !r.signal.aborted)).to.be.true;
        const result = await registered[0].tool.execute({});
        expect(result.content[0].type).to.equal('text');
        expect(JSON.parse(result.content[0].text).entities).to.equal(4);

        // a failure comes back as an error result, which keeps its message
        const get = registered.find(r => r.tool.name === 'playcanvas_get').tool;
        const failure = await get.execute({ id: 'node:99999' });
        expect(failure.isError).to.be.true;
        expect(failure.content[0].text).to.match(/No object with id "node:99999"/);

        inspector.mcp = false;
        expect(registered.every(r => r.signal.aborted)).to.be.true;
    });

    describe('performance capture', function () {
        const realNow = performance.now;
        let time;

        /**
         * Runs one frame of the app the way the engine's tick does, on a clock the capture reads,
         * so frame times are exact. The capture completes a frame as the next begins.
         *
         * @param {object} [frame] - The frame.
         * @param {number} [frame.update] - Its update time, the inspector's included.
         * @param {number} [frame.render] - Its render time.
         * @param {number} [frame.gap] - The time from the end of its work to the next frame.
         * @param {number} [frame.inspector] - The inspector's own time in its update.
         */
        const tick = ({ update = 4, render = 3, gap = 9, inspector: own = 1 } = {}) => {
            const f = app.stats.frame;
            app.fire('frameupdate');
            app.frame++;
            Object.assign(f, {
                updateStart: time,
                updateTime: update,
                scriptUpdateStart: time,
                scriptUpdate: update / 2,
                animUpdateStart: time,
                animUpdate: 0,
                scriptPostUpdateStart: time,
                scriptPostUpdate: 0,
                physicsStart: 0,
                physicsTime: 0
            });
            inspector._perf.addOverhead(time, own);
            time += update;
            app.graphicsDevice.renderVersion++;
            f.renderStart = time;
            f.renderTime = render;
            time += render;
            app.fire('frameend');
            time += gap;
        };

        /**
         * @param {number} n - How many frames to run.
         * @param {object} [frame] - Each frame, as {@link tick} takes it.
         */
        const run = (n, frame) => {
            for (let i = 0; i < n; i++) tick(frame);
        };

        beforeEach(function () {
            time = 1000;
            performance.now = () => time;
            // an app past its first frame, so a capture begins with frames rather than its start
            app.frame = 1;
            inspector = /** @type {any} */ (new Inspector(app, { storageKey: null, mcp: true }));
        });

        afterEach(function () {
            performance.now = realNow;
        });

        it('records a number of frames, stops by itself and returns their summary', async function () {
            const pending = inspector.executeTool('playcanvas_perf_record', { frames: 4 });
            expect(inspector.recording).to.be.true;
            const status = await inspector.executeTool('playcanvas_perf_status');
            expect(status).to.include({ recording: true, frames: 0, framesLeft: 4, recordedBy: 'agent' });
            expect(status.visibility).to.be.a('string');

            // the fourth frame is complete once the fifth begins
            run(5);
            const result = await pending;
            expect(result.ended).to.equal('recorded');
            expect(result.frames).to.equal(4);
            expect(inspector.recording).to.be.false;

            const summary = result.summary;
            expect(summary.range).to.deep.equal({ from: 1, to: 4, frames: 4 });
            expect(summary.recording).to.be.false;
            expect(summary.frameTime).to.deep.equal({ min: 16, avg: 16, p95: 16, max: 16 });
            expect(summary.fps).to.equal(62.5);
            // the inspector's own millisecond of each update is left out, and said to be
            expect(summary.cpu.total).to.deep.equal({ min: 6, avg: 6, p95: 6, max: 6 });
            expect(summary.cpu.update.avg).to.equal(3);
            expect(summary.cpu.render.avg).to.equal(3);
            expect(summary.inspectorTime).to.match(/left out .* 1 ms a frame/);
            expect(summary.device.type).to.equal('null');
            expect(summary.hitches.count).to.equal(0);
            expect(JSON.stringify(summary).length).to.be.below(4096);

            const counted = await inspector.executeTool('playcanvas_perf_summary', { includeInspector: true });
            expect(counted.cpu.total.avg).to.equal(7);
            expect(counted.cpu.inspector.avg).to.equal(1);
        });

        it('names the hitches, the longest first', async function () {
            const pending = inspector.executeTool('playcanvas_perf_record', { frames: 6 });
            run(3);
            tick({ gap: 60 });
            tick({ gap: 40 });
            run(2);
            const { summary } = await pending;
            expect(summary.hitches.count).to.equal(2);
            expect(summary.hitches.longest.map(h => h.frame)).to.deep.equal([4, 5]);
            expect(summary.hitches.longest[0]).to.include({ interval: 67, cpu: 6 });
        });

        it('does not discard a capture the user recorded unless told to', async function () {
            inspector.recording = true;
            run(4);
            inspector.recording = false;
            expect((await inspector.executeTool('playcanvas_perf_status')).recordedBy).to.equal('user');

            let error;
            await inspector.executeTool('playcanvas_perf_record', { frames: 2 }).catch((e) => {
                error = e;
            });
            expect(error?.message).to.match(/user recorded the 3 frames kept.*clear: true.*clear: false/);
            expect(inspector._perf.count).to.equal(3);

            // adding to it summarizes only the frames added
            const adding = inspector.executeTool('playcanvas_perf_record', { frames: 2, clear: false });
            run(3);
            const added = await adding;
            expect(added.summary.range).to.deep.equal({ from: 4, to: 5, frames: 2 });
            expect(inspector._perf.count).to.equal(5);

            // the agent's own capture is cleared without asking
            const again = inspector.executeTool('playcanvas_perf_record', { frames: 1 });
            run(2);
            expect((await again).summary.range).to.deep.equal({ from: 1, to: 1, frames: 1 });
        });

        it('refuses to take over a recording the user is making, unless told to', async function () {
            inspector.recording = true;
            run(2);
            let error;
            await inspector.executeTool('playcanvas_perf_record', {}).catch((e) => {
                error = e;
            });
            expect(error?.message).to.match(/user is recording/);
            expect(inspector.recording).to.be.true;

            const status = await inspector.executeTool('playcanvas_perf_record', { clear: true });
            expect(status).to.include({ recording: true, frames: 0, recordedBy: 'agent' });
            run(4);
            const summary = await inspector.executeTool('playcanvas_perf_stop');
            expect(inspector.recording).to.be.false;
            expect(summary.range.frames).to.equal(3);
        });

        it('turns the timings on through the panel\'s switches', async function () {
            app.systems.script = {
                app,
                ComponentType: class {
                    _scriptMethod() {}
                }
            };
            inspector.destroy();
            inspector = /** @type {any} */ (new Inspector(app, { storageKey: null, mcp: true }));
            let error;
            await inspector.executeTool('playcanvas_perf_record', { gpuTimings: true }).catch((e) => {
                error = e;
            });
            expect(error?.message).to.match(/cannot time the GPU/);

            await inspector.executeTool('playcanvas_perf_record', { scriptTiming: true });
            expect(inspector._perfScriptsToggle.checked).to.be.true;
            expect((await inspector.executeTool('playcanvas_perf_status')).options.scriptTiming).to.be.true;
        });

        it('returns at once without waiting, and stops by itself', async function () {
            const status = await inspector.executeTool('playcanvas_perf_record', { frames: 2, wait: false });
            expect(status).to.include({ recording: true, framesLeft: 2 });
            run(3);
            expect(inspector.recording).to.be.false;
            const summary = await inspector.executeTool('playcanvas_perf_summary');
            expect(summary.range.frames).to.equal(2);
        });

        it('gives up when the frames do not come, as in a hidden page', async function () {
            this.timeout(4000);
            const result = await inspector.executeTool('playcanvas_perf_record', { frames: 10, timeout: 1 });
            expect(result.ended).to.equal('timed out');
            expect(result.frames).to.equal(0);
            expect(result.note).to.match(/hidden/);
            expect(result.status.recording).to.be.false;
        });

        it('ends the wait when the user stops recording, or MCP is turned off', async function () {
            const pending = inspector.executeTool('playcanvas_perf_record', { frames: 10 });
            run(3);
            inspector.recording = false;
            tick();
            const result = await pending;
            expect(result.ended).to.equal('stopped from the panel');
            expect(result.summary.range.frames).to.equal(2);

            const again = inspector.executeTool('playcanvas_perf_record', { frames: 10 });
            inspector.mcp = false;
            expect((await again).ended).to.equal('MCP turned off');
            expect(inspector.recording).to.be.false;
        });

        it('returns a frame in full, and a series a page at a time, as JSON or CSV', async function () {
            let error;
            await inspector.executeTool('playcanvas_perf_frame', { frame: 1 }).catch((e) => {
                error = e;
            });
            expect(error?.message).to.match(/Nothing is recorded/);

            const pending = inspector.executeTool('playcanvas_perf_record', { frames: 5 });
            run(6);
            await pending;
            const frame = await inspector.executeTool('playcanvas_perf_frame', { frame: 2 });
            expect(frame).to.include({ frame: 2, interval: 16, hitch: false });
            expect(frame.cpu).to.include({ update: 4, render: 3, inspector: 1 });
            await inspector.executeTool('playcanvas_perf_frame', { frame: 9 }).catch((e) => {
                error = e;
            });
            expect(error?.message).to.match(/Frames kept: 1 to 5/);

            const series = await inspector.executeTool('playcanvas_perf_series', { key: 'cpu', from: 2, to: 3 });
            expect(series.range).to.deep.equal({ from: 2, to: 3 });
            expect(series.rows.map(row => row.frame)).to.deep.equal([2, 3]);
            expect(series.rows[0]).to.include({ total: 7, update: 4, render: 3 });
            expect(series).to.not.have.property('next');

            const csv = await inspector.executeTool('playcanvas_perf_series', { key: 'frame', format: 'csv' });
            expect(csv.csv).to.equal('frame,interval\n1,16\n2,16\n3,16\n4,16\n5,16\n');

            await inspector.executeTool('playcanvas_perf_series', { key: 'shaders' }).catch((e) => {
                error = e;
            });
            expect(error?.message).to.match(/must be one of/);
        });
    });

    it('remembers the switch, shown on its toolbar button', function () {
        window.localStorage.removeItem('test-mcp');
        inspector = /** @type {any} */ (new Inspector(app, { storageKey: 'test-mcp' }));
        expect(inspector._mcpBtn.classList.contains('pci-active')).to.be.false;
        inspector._mcpBtn.click();
        expect(inspector.mcp).to.be.true;
        expect(inspector._mcpBtn.classList.contains('pci-active')).to.be.true;
        inspector.destroy();

        inspector = new Inspector(app, { storageKey: 'test-mcp' });
        expect(inspector.mcp).to.be.true;
        window.localStorage.removeItem('test-mcp');
    });
});
