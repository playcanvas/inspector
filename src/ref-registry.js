import { Asset, Component, FramePass, GraphNode, Material, Mesh, MeshInstance, RenderTarget, Shader, Texture } from 'playcanvas';

import { LayerStepSelection } from './frame-graph-view.js';
import { isScriptClass } from './script-view.js';

/**
 * @param {object} obj - An object.
 * @returns {string} The kind its id is prefixed with, so an id says what it stands for.
 */
function kindOf(obj) {
    if (obj instanceof GraphNode) return 'node';
    if (obj instanceof Component) return 'component';
    if (obj instanceof MeshInstance) return 'meshInstance';
    if (obj instanceof Mesh) return 'mesh';
    if (obj instanceof Material) return 'material';
    if (obj instanceof Shader) return 'shader';
    if (obj instanceof Texture) return 'texture';
    if (obj instanceof RenderTarget) return 'renderTarget';
    if (obj instanceof FramePass) return 'pass';
    if (obj instanceof LayerStepSelection) return 'step';
    if (obj instanceof Asset) return 'asset';
    if (isScriptClass(obj)) return 'script';
    return 'object';
}

/**
 * Gives objects of the app ids that stay the same for as long as the registry lives, and looks
 * them up again by id, without keeping them alive: an object the app lets go of is collected as
 * usual, and its id then finds nothing.
 *
 * @ignore
 */
class RefRegistry {
    /**
     * @type {WeakMap<object, string>}
     * @private
     */
    _ids = new WeakMap();

    /**
     * @type {Map<string, WeakRef<object>>}
     * @private
     */
    _objects = new Map();

    /**
     * @type {number}
     * @private
     */
    _next = 1;

    /**
     * The number of ids at which the ids of collected objects are next dropped.
     *
     * @type {number}
     * @private
     */
    _sweepAt = 1024;

    /**
     * The ids given by key, see {@link RefRegistry#keyedId}, and how each finds its object.
     *
     * @type {Map<string, string>}
     * @private
     */
    _keyIds = new Map();

    /**
     * @type {Map<string, () => object|null>}
     * @private
     */
    _resolvers = new Map();

    /**
     * @param {object} obj - An object or a function, such as a script class.
     * @returns {string} Its id, such as `material:12`.
     */
    idOf(obj) {
        let id = this._ids.get(obj);
        if (!id) {
            id = `${kindOf(obj)}:${this._next++}`;
            this._ids.set(obj, id);
            this._objects.set(id, new WeakRef(obj));
            if (this._objects.size >= this._sweepAt) this._sweep();
        }
        return id;
    }

    /**
     * Gives an id to whatever stands at a stable key, rather than to one object, for things the
     * app rebuilds every frame, such as some passes of the frame graph. The id then finds the
     * object standing at the key when it is looked up.
     *
     * @param {string} kind - The kind the id is prefixed with.
     * @param {string} key - The stable key.
     * @param {() => object|null} resolve - Finds the object at the key now.
     * @returns {string} The id, the same for every call with the same kind and key.
     */
    keyedId(kind, key, resolve) {
        const full = `${kind}\0${key}`;
        let id = this._keyIds.get(full);
        if (!id) {
            id = `${kind}:${this._next++}`;
            this._keyIds.set(full, id);
        }
        this._resolvers.set(id, resolve);
        return id;
    }

    /**
     * @param {string} id - An id given by {@link RefRegistry#idOf} or {@link RefRegistry#keyedId}.
     * @returns {object|null} The object, or null when the id is unknown or its object is gone.
     */
    get(id) {
        const resolve = this._resolvers.get(id);
        if (resolve) return resolve() ?? null;
        const obj = this._objects.get(id)?.deref();
        if (!obj) this._objects.delete(id);
        return obj ?? null;
    }

    /**
     * Drops the ids of objects that were collected.
     *
     * @private
     */
    _sweep() {
        for (const [id, ref] of this._objects) {
            if (!ref.deref()) this._objects.delete(id);
        }
        this._sweepAt = Math.max(1024, this._objects.size * 2);
    }
}

export { RefRegistry, kindOf };
