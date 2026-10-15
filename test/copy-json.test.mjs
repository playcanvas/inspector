import {
    Entity, GraphNode, Material, Mesh, MeshInstance, NullGraphicsDevice, PIXELFORMAT_RGBA8, StandardMaterial, Texture, Vec3
} from 'playcanvas';

import { expect } from 'chai';

import { copyGroup, copyList, copyListRow, copyRow, copySection, copySubject, stringifyCopy } from '../src/copy-json.js';
import { describeValue } from '../src/describe.js';
import { buildMaterialModel } from '../src/material-view.js';
import { buildNodeModel, meshInstanceRows } from '../src/node-model.js';
import { buildTextureModel } from '../src/texture-view.js';
import { jsdomSetup, jsdomTeardown } from './jsdom.mjs';

describe('Inspector JSON copy', function () {
    let device;

    beforeEach(function () {
        jsdomSetup();
        device = new NullGraphicsDevice(document.createElement('canvas'));
    });

    afterEach(function () {
        device.destroy();
        jsdomTeardown();
    });

    /**
     * @param {object} obj - An object reached through a link.
     * @returns {*} Its model, the way the inspector's tabs show it.
     */
    const modelFor = (obj) => {
        if (obj instanceof GraphNode) return buildNodeModel(obj);
        if (obj instanceof MeshInstance) return meshInstanceRows(obj);
        if (obj instanceof Material) return buildMaterialModel(obj, { app: null, backlinks: false });
        if (obj instanceof Texture) return buildTextureModel(obj, { device, backlinks: false });
        return null;
    };

    /**
     * @returns {any} A robot whose render component draws two instances of one material, which
     * samples one texture.
     */
    function robot() {
        const app = /** @type {any} */ ({ systems: {}, _entityIndex: {} });
        const texture = new Texture(device, { name: 'albedo', width: 4, height: 4, format: PIXELFORMAT_RGBA8 });
        const material = new StandardMaterial();
        material.name = 'painted';
        material.diffuseMap = texture;
        const mesh = new Mesh(device);
        mesh.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        mesh.update();
        const entity = new Entity('robot', app);
        entity.c.render = /** @type {any} */ ({
            enabled: true,
            system: { app },
            meshInstances: [new MeshInstance(mesh, material, entity), new MeshInstance(mesh, material, entity)]
        });
        return { entity, material, texture };
    }

    it('copies a value at full precision, under its label', function () {
        const node = new GraphNode('node');
        node.setLocalPosition(0.123456789, 2, -3);
        const transform = buildNodeModel(node).find(section => section.key === 'transform');
        const row = transform.rows.find(r => r.label === 'local position');
        // the panel rounds what it shows
        expect(row.value.text).to.equal('(0.1235, 2, -3)');
        expect(copyRow(row, { depth: 0 }).json).to.deep.equal({ 'local position': [0.123456789, 2, -3] });

        // and cuts long strings
        node.name = 'n'.repeat(200);
        const name = buildNodeModel(node)[0].rows.find(r => r.label === 'name');
        expect(copyRow(name, { depth: 0 }).json.name).to.have.lengthOf(200);
    });

    it('copies the children of a node to the depth asked, and never its parent', function () {
        const root = new GraphNode('root');
        const parent = new GraphNode('parent');
        const child = new GraphNode('child');
        const grandchild = new GraphNode('grandchild');
        root.addChild(parent);
        parent.addChild(child);
        child.addChild(grandchild);

        const copy = depth => copySubject(parent, buildNodeModel(parent), { depth, modelFor }).json;

        const alone = copy(0);
        expect(alone.$type).to.equal('GraphNode');
        expect(alone.GraphNode.name).to.equal('parent');
        expect(alone.GraphNode).to.not.have.property('parent');
        expect(alone.Transform['world position']).to.deep.equal([0, 0, 0]);
        // a child out of reach is named, not copied
        expect(alone.children).to.deep.equal([{ $type: 'GraphNode', name: 'child', path: 'parent/child', $stub: true }]);

        const one = copy(1);
        expect(one.children[0].GraphNode.name).to.equal('child');
        expect(one.children[0].GraphNode).to.not.have.property('parent');
        expect(one.children[0].children[0].$stub).to.be.true;

        const all = copySubject(root, buildNodeModel(root), { depth: Infinity, modelFor });
        expect(all.json.children[0].children[0].children[0].GraphNode.name).to.equal('grandchild');
        expect(all.json.children[0].children[0].children[0].children).to.deep.equal([]);
        expect(all.objects).to.equal(4);
        expect(all.truncated).to.be.false;
    });

    it('follows a component into its mesh instances, their material and its textures, a level at a time', function () {
        const { entity, material } = robot();
        const render = buildNodeModel(entity).find(section => section.key === 'c:render');
        const copy = depth => copySection(render, { depth, modelFor }).json.render;

        // on its own, the component names its mesh instances
        const alone = copy(0);
        expect(alone.enabled).to.equal(true);
        expect(alone.meshInstances).to.have.lengthOf(2);
        expect(alone.meshInstances[0].$type).to.equal('MeshInstance');
        expect(alone.meshInstances[0].$stub).to.be.true;

        // a level deep, the instances are copied, naming their material and their node
        const one = copy(1);
        const instance = one.meshInstances[0];
        expect(instance.$type).to.equal('MeshInstance');
        expect(instance.$stub).to.equal(undefined);
        expect(instance.material).to.deep.equal({ $type: 'StandardMaterial', id: material.id, name: 'painted', $stub: true });
        // a node is only reached through the children of its parent, so the instance's node is named
        expect(instance.node.$stub).to.be.true;
        expect(instance.node.name).to.equal('robot');
        expect(one.meshInstances[1].material.$stub).to.be.true;

        // two levels deep, the material is copied once, and referenced by the second instance
        const two = copy(2);
        const copied = two.meshInstances[0].material;
        expect(copied.$type).to.equal('StandardMaterial');
        const general = copied['StandardMaterial "painted"'];
        expect(general.id).to.equal(material.id);
        expect(general.diffuseMap).to.deep.include({ $type: 'Texture', name: 'albedo', $stub: true });
        expect(two.meshInstances[1].material).to.deep.include({ $type: 'StandardMaterial', $ref: true });

        // three levels deep, the texture is copied too
        const three = copy(3);
        const texture = three.meshInstances[0].material['StandardMaterial "painted"'].textures[0];
        expect(texture.$type).to.equal('Texture');
        expect(texture.Texture.name).to.equal('albedo');
        expect(texture.Sampling).to.exist;
    });

    it('copies an object a row links to, and the entries of a list as if each was copied', function () {
        const { entity, material } = robot();
        const instanceRows = meshInstanceRows(entity.c.render.meshInstances[0]);
        const materialRow = instanceRows.find(row => row.label === 'material');
        const json = copyRow(materialRow, { depth: 0, modelFor }).json;
        expect(json.$type).to.equal('StandardMaterial');
        expect(json['StandardMaterial "painted"'].id).to.equal(material.id);
        expect(json['StandardMaterial "painted"'].diffuseMap.$stub).to.be.true;

        // even a node, such as a parent, is copied when it is what was asked for
        const nodeRow = instanceRows.find(row => row.label === 'node');
        expect(copyRow(nodeRow, { depth: 0, modelFor }).json.Entity.name).to.equal('robot');

        const render = buildNodeModel(entity).find(section => section.key === 'c:render');
        const list = render.rows.find(row => row.label === 'meshInstances');
        const entries = copyRow(list, { depth: 0, modelFor }).json.meshInstances;
        expect(entries.map(entry => entry.$type)).to.deep.equal(['MeshInstance', 'MeshInstance']);
        expect(entries[0].material.$stub).to.be.true;
    });

    it('leaves out what uses an object', function () {
        const { material } = robot();
        const sections = buildMaterialModel(material, { app: { root: null, assets: null, scene: null } });
        expect(sections.map(section => section.title)).to.include('Used by');
        const json = copySubject(material, sections, { depth: 0, modelFor }).json;
        expect(Object.keys(json)).to.deep.equal(['$type', 'StandardMaterial "painted"']);
    });

    it('copies source code only for the object copied', function () {
        class Program {}
        class Pipeline {}
        const program = new Program();
        const pipeline = new Pipeline();
        const source = { key: 'source', label: 'source', value: { text: '2 lines', code: 'a\nb' } };
        const models = new Map([
            [program, [source]],
            [pipeline, [{ key: 'program', label: 'program', value: describeValue(program) }, source]]
        ]);
        const json = copySubject(pipeline, models.get(pipeline), { depth: Infinity, modelFor: obj => models.get(obj) ?? null }).json;
        expect(json.source).to.equal('a\nb');
        expect(json.program.$type).to.equal('Program');
        expect(json.program.source).to.equal('2 lines');
    });

    it('copies plain data in place, cutting cycles, and stops at the object limit', function () {
        class Holder {
            constructor(next) {
                this.next = next;
                this.data = { scale: new Vec3(1, 2, 3), weights: new Float32Array([0.5, 1]), ratio: NaN, tags: new Map([['a', 1]]) };
                this.data.self = this.data;
            }
        }
        const chain = new Holder(new Holder(new Holder(null)));
        const row = { key: 'chain', label: 'chain', value: describeValue(chain) };

        const all = copyRow(row, { depth: Infinity });
        expect(all.json.$type).to.equal('Holder');
        expect(all.json.data).to.deep.equal({ scale: [1, 2, 3], weights: [0.5, 1], ratio: 'NaN', tags: { a: 1 }, self: '<circular>' });
        expect(all.json.next.next.next).to.equal(null);
        expect(all.objects).to.equal(3);

        const capped = copyRow(row, { depth: Infinity, maxObjects: 2 });
        expect(capped.truncated).to.be.true;
        expect(capped.json.next.next).to.deep.include({ $type: 'Holder', $stub: true, $truncated: true });
    });

    it('summarizes objects of the browser rather than following them', function () {
        // a rendering context, an element or a promise names its kind this way
        class Context {
            get [Symbol.toStringTag]() {
                return 'WebGL2RenderingContext';
            }

            get canvas() {
                throw new Error('never read');
            }
        }
        const row = { key: 'gl', label: 'gl', value: describeValue(new Context()) };
        expect(copyRow(row, { depth: Infinity }).json).to.deep.equal({ gl: 'Context' });
    });

    it('copies a list entry by entry, and a list in groups group by group', function () {
        const big = new GraphNode('big');
        const small = new GraphNode('small');
        const held = new GraphNode('held');
        const cells = (...list) => list.map(([text, cls]) => ({ text, cls }));
        const rows = [
            { key: 'group:a', item: null, name: 'Nodes', header: true, cells: cells(['Nodes', 'pci-cell-name'], ['2', 'pci-cell-count'], ['3 KB', 'pci-cell-size']) },
            { key: 'big', item: big, name: 'big', cells: cells(['big', 'pci-cell-name']) },
            { key: 'small', item: small, name: 'small', cells: cells(['small', 'pci-cell-name']) },
            { key: 'group:b', item: null, name: 'Figures', header: true, contents: () => [held], cells: cells(['Figures', 'pci-cell-name'], ['', 'pci-cell-count']) },
            { key: 'pool', item: null, name: 'pool', inert: true, cells: cells(['pool', 'pci-cell-name'], ['4 buffers', 'pci-cell-info'], ['', 'pci-cell-count'], ['1 KB', 'pci-cell-size']) }
        ];

        const json = copyList('Memory', rows, { depth: 0, modelFor }).json;
        expect(Object.keys(json.Memory)).to.deep.equal(['Nodes', 'Figures']);
        // a header's figures, then each object its rows select, copied as if on its own
        expect(json.Memory.Nodes.count).to.equal('2');
        expect(json.Memory.Nodes.size).to.equal('3 KB');
        expect(json.Memory.Nodes.entries.map(entry => entry.GraphNode.name)).to.deep.equal(['big', 'small']);
        // a row that selects nothing gives its figures, and a header the objects it counts without listing
        expect(json.Memory.Figures.entries[0]).to.deep.equal({ name: 'pool', info: '4 buffers', size: '1 KB' });
        expect(json.Memory.Figures.entries[1].GraphNode.name).to.equal('held');

        expect(copyGroup(rows, 'group:a', { depth: 0, modelFor }).json.Nodes.entries).to.have.lengthOf(2);
        expect(copyGroup(rows, 'gone', { depth: 0 }).json).to.deep.equal({});
        expect(copyListRow(rows[4]).json).to.deep.equal({ name: 'pool', info: '4 buffers', size: '1 KB' });

        // without groups, the entries are a plain list
        const flat = copyList('Nodes', rows.slice(1, 3), { depth: 0, modelFor }).json;
        expect(flat.Nodes.map(entry => entry.$type)).to.deep.equal(['GraphNode', 'GraphNode']);
    });

    it('prints lists of plain values on one line, and stays valid JSON', function () {
        const json = { position: [1, 2.5, null], name: 'a "b"', nested: { empty: {}, none: [], objects: [{ id: 1 }] } };
        const text = stringifyCopy(json);
        expect(text).to.equal([
            '{',
            '  "position": [1, 2.5, null],',
            '  "name": "a \\"b\\"",',
            '  "nested": {',
            '    "empty": {},',
            '    "none": [],',
            '    "objects": [',
            '      {',
            '        "id": 1',
            '      }',
            '    ]',
            '  }',
            '}'
        ].join('\n'));
        expect(JSON.parse(text)).to.deep.equal(json);
    });
});
