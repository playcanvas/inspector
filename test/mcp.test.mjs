import {
    AssetRegistry, Entity, EventHandler, GraphNode, Mesh, MeshInstance, NullGraphicsDevice, PIXELFORMAT_RGBA8, StandardMaterial, Texture
} from 'playcanvas';

import { expect } from 'chai';

import { Inspector } from '../src/inspector.js';
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

    it('describes read-only tools while on', function () {
        inspector = new Inspector(app, { storageKey: null, mcp: true });
        const tools = inspector.getTools();
        expect(tools.map(t => t.name)).to.deep.equal(['playcanvas_app_summary', 'playcanvas_find_entities', 'playcanvas_list', 'playcanvas_get']);
        for (const tool of tools) {
            expect(tool.annotations.readOnlyHint).to.be.true;
            expect(tool.inputSchema.type).to.equal('object');
            expect(tool).to.not.have.property('execute');
        }
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
        expect(registered.map(r => r.tool.name)).to.have.lengthOf(4);
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
