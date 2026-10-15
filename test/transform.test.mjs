import { GraphNode, Quat, Vec3 } from 'playcanvas';

import { expect } from 'chai';

import { copySubject } from '../src/copy-json.js';
import { HierarchyView } from '../src/hierarchy-view.js';
import { buildNodeModel } from '../src/node-model.js';
import { PropertyView } from '../src/property-view.js';
import { TransformTool } from '../src/transform-tool.js';
import { jsdomSetup, jsdomTeardown } from './jsdom.mjs';

describe('Inspector transform editing', function () {
    beforeEach(jsdomSetup);
    afterEach(jsdomTeardown);

    /**
     * @param {GraphNode} node - A node.
     * @returns {Record<string, import('../src/describe.js').Described>} The values of its
     * transform section, by label.
     */
    const transform = node => Object.fromEntries(buildNodeModel(node).find(section => section.key === 'transform').rows.map(row => [row.label, row.value]));

    it('edits the positions, rotations and local scale of a node, and nothing else', function () {
        const parent = new GraphNode('parent');
        const node = new GraphNode('node');
        parent.addChild(node);
        parent.setLocalPosition(10, 0, 0);
        node.setLocalPosition(0.1, 0.2, 0.3);

        let values = transform(node);
        // the text holds every digit, so a component left alone is set back exactly as it was
        expect(values['local position'].edit.text).to.equal('0.1, 0.2, 0.3');
        expect(values['world scale'].edit).to.equal(undefined);
        expect(values.forward.edit).to.equal(undefined);

        expect(values['local position'].edit.apply('1, 2, 3')).to.be.true;
        expect(node.getLocalPosition().toString()).to.equal('[1, 2, 3]');
        expect(values['world position'].edit.apply('(0 5 0)')).to.be.true;
        expect(node.getPosition().toString()).to.equal('[0, 5, 0]');
        expect(node.getLocalPosition().toString()).to.equal('[-10, 5, 0]');
        expect(values['local rotation'].edit.apply('0, 90, 0')).to.be.true;
        expect(node.getLocalEulerAngles().y).to.be.closeTo(90, 1e-4);

        // a single number scales uniformly, and text that is not three numbers is not taken
        expect(values['local scale'].edit.apply('2')).to.be.true;
        expect(node.getLocalScale().toString()).to.equal('[2, 2, 2]');
        expect(values['local position'].edit.apply('1, 2')).to.be.false;
        expect(values['local position'].edit.apply('1, two, 3')).to.be.false;
        expect(values['local scale'].edit.apply('')).to.be.false;
        expect(node.getLocalPosition().toString()).to.equal('[-10, 5, 0]');

        values = transform(node);
        expect(values['local scale'].edit.text).to.equal('2, 2, 2');
    });

    it('moves the physics body of an entity along with it', function () {
        const node = /** @type {any} */ (new GraphNode('body'));
        const calls = [];
        node.c = { rigidbody: { enabled: true, body: {}, teleport: (position, rotation) => calls.push([position.clone(), rotation.clone()]) } };

        expect(transform(node)['world position'].edit.apply('1, 2, 3')).to.be.true;
        expect(calls).to.have.lengthOf(1);
        expect(calls[0][0].toString()).to.equal('[1, 2, 3]');
        expect(calls[0][1]).to.be.instanceOf(Quat);

        // a body that is off, or not created yet, is left alone
        node.c.rigidbody.enabled = false;
        transform(node)['world position'].edit.apply('4, 5, 6');
        expect(calls).to.have.lengthOf(1);
    });

    it('edits a value in a text field: Enter takes it, Escape gives up, and a refresh leaves it alone', function () {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const view = new PropertyView(container, () => {});
        let value = new Vec3(1, 2, 3);
        const applied = [];
        const model = () => [{
            key: 's',
            title: 'Transform',
            rows: [{
                key: 'p',
                label: 'position',
                value: {
                    text: `(${value.x}, ${value.y}, ${value.z})`,
                    cls: 'num',
                    edit: {
                        text: `${value.x}, ${value.y}, ${value.z}`,
                        apply: (text) => {
                            const numbers = text.split(',').map(Number);
                            if (numbers.length !== 3 || numbers.some(Number.isNaN)) return false;
                            applied.push(text);
                            value = new Vec3(...numbers);
                            return true;
                        }
                    }
                }
            }]
        }];
        view.setSubject({}, model);
        const row = container.querySelector('.pci-prop');
        const valueEl = row.querySelector('.pci-value');
        // an editable value is drawn as a text field, and says how it is edited
        expect(row.classList.contains('pci-editable')).to.be.true;
        expect(valueEl.dataset.tip).to.equal('Click to edit. Enter applies, Esc cancels');
        const field = () => /** @type {HTMLInputElement|null} */ (container.querySelector('.pci-edit'));
        const key = key => field().dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));

        valueEl.click();
        expect(field().value).to.equal('1, 2, 3');
        expect(row.classList.contains('pci-editing')).to.be.true;
        expect(document.activeElement).to.equal(field());
        // the panel refreshes all the time; the text being typed is left as it is
        field().value = '4, 5, 6';
        view.refresh();
        expect(field().value).to.equal('4, 5, 6');
        key('Enter');
        expect(field()).to.equal(null);
        expect(row.classList.contains('pci-editing')).to.be.false;
        expect(applied).to.deep.equal(['4, 5, 6']);
        expect(valueEl.textContent).to.equal('(4, 5, 6)');

        // text the edit does not take keeps the field open, marked, until it is fixed or given up on
        valueEl.click();
        field().value = 'nope';
        key('Enter');
        expect(field().classList.contains('pci-invalid')).to.be.true;
        key('Escape');
        expect(field()).to.equal(null);
        expect(applied).to.have.lengthOf(1);
        expect(valueEl.textContent).to.equal('(4, 5, 6)');

        // leaving the field takes its text, and a field left untouched changes nothing
        valueEl.click();
        field().blur();
        expect(field()).to.equal(null);
        expect(applied).to.have.lengthOf(1);
        valueEl.click();
        field().value = '7, 8, 9';
        field().blur();
        expect(applied).to.deep.equal(['4, 5, 6', '7, 8, 9']);
    });

    it('leaves a node the panel added, such as its gizmo, out of the tree and of copies', function () {
        const root = new GraphNode('root');
        const box = new GraphNode('box');
        const gizmo = new GraphNode('gizmo:translate');
        gizmo.addChild(new GraphNode('handle'));
        root.addChild(box);
        root.addChild(gizmo);

        const container = document.createElement('div');
        const view = new HierarchyView(container, () => {});
        view.isHidden = node => node === gizmo;
        // the root starts open
        view.setRoot(root);
        view.refresh();
        const names = [...container.querySelectorAll('.pci-name')].map(name => name.textContent);
        expect(names).to.deep.equal(['root', 'box']);
        expect(view.nodeCount).to.equal(2);
        expect(container.querySelector('.pci-count').textContent).to.equal('1');

        const json = copySubject(root, buildNodeModel(root), { depth: Infinity, modelFor: node => buildNodeModel(/** @type {GraphNode} */ (node)), exclude: node => node === gizmo }).json;
        expect(json.children.map(child => child.GraphNode.name)).to.deep.equal(['box']);
    });

    it('gives the gizmo a press on a handle and the drag after it, and the app everything else', function () {
        const canvas = document.createElement('canvas');
        const calls = [];
        let handle = null;
        const listeners = {};
        const gizmo = {
            on: (name, fn) => {
                listeners[name] = fn;
            },
            _onPointerDown: (e) => {
                calls.push(`down ${e.type}`);
                listeners['pointer:down']?.(0, 0, handle);
            },
            _onPointerMove: () => calls.push('move'),
            _onPointerUp: () => calls.push('up')
        };
        // the routing alone, without an engine gizmo behind it
        const tool = Object.assign(Object.create(TransformTool.prototype), {
            _app: { graphicsDevice: { canvas } }, _gizmo: gizmo, _dragging: false, _endingDrag: false
        });
        gizmo.on('pointer:down', (x, y, meshInstance) => {
            tool._dragging = !!meshInstance;
        });
        const event = (type, target = canvas) => ({ type, target });

        // away from the handles: the gizmo sees the pointer, to light up what is under it, and so does the app
        expect(tool.handle(event('pointerdown'))).to.be.false;
        expect(tool.handle(event('pointermove'))).to.be.false;
        expect(tool.handle(event('pointerup'))).to.be.false;
        expect(tool.handle(event('click'))).to.be.false;
        expect(tool.handle(event('wheel'))).to.be.false;

        // on a handle: the press, the drag, its release and the click that follows are the gizmo's alone
        handle = {};
        expect(tool.handle(event('pointerdown'))).to.be.true;
        expect(tool.handle(event('mousedown'))).to.be.true;
        expect(tool.handle(event('pointermove', document.body))).to.be.true;
        expect(tool.handle(event('wheel'))).to.be.true;
        expect(tool.handle(event('pointerup', document.body))).to.be.true;
        expect(tool.handle(event('click'))).to.be.true;
        expect(tool.handle(event('click'))).to.be.false;

        // the pointer anywhere else in the page is no business of the gizmo
        expect(tool.handle(event('pointerdown', document.body))).to.be.false;
        expect(calls).to.deep.equal(['down pointerdown', 'move', 'up', 'down pointerdown', 'move', 'up']);
    });
});
