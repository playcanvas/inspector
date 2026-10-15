import { Gizmo, RotateGizmo, ScaleGizmo, TransformGizmo, TranslateGizmo } from 'playcanvas';

import { syncBody } from './node-model.js';

/** @import { AppBase } from 'playcanvas' */
/** @import { CameraComponent } from 'playcanvas' */
/** @import { Entity } from 'playcanvas' */
/** @import { GraphNode } from 'playcanvas' */
/** @import { Layer } from 'playcanvas' */

/**
 * @typedef {'translate'|'rotate'|'scale'} TransformMode
 * @ignore
 */

/** @type {Record<TransformMode, typeof TranslateGizmo|typeof RotateGizmo|typeof ScaleGizmo>} */
const GIZMOS = { translate: TranslateGizmo, rotate: RotateGizmo, scale: ScaleGizmo };

// the input the tool sees first, ahead of the app, so a handle being dragged keeps it to itself
const POINTER_EVENTS = [
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click',
    'dblclick', 'wheel', 'contextmenu', 'touchstart', 'touchmove', 'touchend'
];

/**
 * Moves, rotates or scales a node in the view with one of the engine's transform gizmos, drawn on
 * a layer of its own over the view of a camera. The gizmo listens to the canvas itself, after the
 * app's own listeners, so a drag of its handles would also reach the app and move its camera too.
 * The tool takes those listeners away and hands the gizmo the pointer itself: a press on a handle
 * and the drag that follows go to the gizmo alone, and everything else to the app as usual.
 *
 * The gizmo has no public way to be handed input, so it is handed its own pointer handlers. Engines
 * whose gizmos lack them get no tool, see {@link TransformTool.supported}.
 *
 * @ignore
 */
class TransformTool {
    /**
     * Whether the engine's gizmos can be driven by the tool.
     *
     * @type {boolean}
     */
    static get supported() {
        const proto = /** @type {any} */ (Gizmo.prototype);
        return ['_onPointerDown', '_onPointerMove', '_onPointerUp'].every(name => typeof proto[name] === 'function');
    }

    /**
     * What the tool does to the node.
     *
     * @type {TransformMode}
     */
    mode;

    /**
     * @type {AppBase}
     * @private
     */
    _app;

    /**
     * @type {Layer}
     * @private
     */
    _layer;

    /**
     * @type {any}
     * @private
     */
    _gizmo;

    /**
     * Whether a handle is being dragged, which keeps the pointer from the app until it is let go.
     *
     * @type {boolean}
     * @private
     */
    _dragging = false;

    /**
     * Whether the click that follows the end of a drag is still to come, to keep it from the app.
     *
     * @type {boolean}
     * @private
     */
    _endingDrag = false;

    /**
     * @param {AppBase} app - The app.
     * @param {TransformMode} mode - What the tool does to the node.
     * @param {CameraComponent} camera - The camera whose view the gizmo is drawn and used in.
     * @param {() => void} [onTransform] - Called whenever the gizmo changes the node.
     */
    constructor(app, mode, camera, onTransform) {
        this._app = app;
        this.mode = mode;
        this._layer = Gizmo.createLayer(app, 'Inspector gizmo');
        const gizmo = new GIZMOS[mode](camera, this._layer);
        this._gizmo = gizmo;

        const canvas = app.graphicsDevice.canvas;
        canvas.removeEventListener('pointerdown', gizmo._onPointerDown);
        canvas.removeEventListener('pointermove', gizmo._onPointerMove);
        canvas.removeEventListener('pointerup', gizmo._onPointerUp);

        gizmo.on(Gizmo.EVENT_POINTERDOWN, (x, y, meshInstance) => {
            this._dragging = !!meshInstance;
        });
        gizmo.on(TransformGizmo.EVENT_TRANSFORMMOVE, () => {
            for (const node of gizmo.nodes) syncBody(node);
            onTransform?.();
        });
    }

    /**
     * The entity of the gizmo, which the app's hierarchy holds while the tool is on.
     *
     * @type {Entity}
     */
    get root() {
        return this._gizmo.root;
    }

    /**
     * Puts the gizmo on a node, or takes it off.
     *
     * @param {GraphNode|null} node - The node, or null for none.
     */
    attach(node) {
        this._gizmo.detach();
        this._dragging = false;
        if (node) this._gizmo.attach([node]);
    }

    /**
     * Hands the gizmo a pointer event on the canvas, ahead of everything else listening to it.
     *
     * @param {Event} e - The event.
     * @returns {boolean} Whether the gizmo keeps the event, which nothing else is then to see.
     */
    handle(e) {
        const gizmo = this._gizmo;
        const onCanvas = e.target === this._app.graphicsDevice.canvas;
        switch (e.type) {
            case 'pointerdown':
                if (!onCanvas) return false;
                this._endingDrag = false;
                gizmo._onPointerDown(e);
                return this._dragging;
            case 'pointermove':
                // the gizmo lights up the handle under the pointer, whether it keeps the event or not
                if (onCanvas || this._dragging) gizmo._onPointerMove(e);
                return this._dragging;
            case 'pointerup':
            case 'pointercancel': {
                if (onCanvas || this._dragging) gizmo._onPointerUp(e);
                const dragged = this._dragging;
                this._dragging = false;
                this._endingDrag = dragged;
                return dragged;
            }
            case 'click':
            case 'dblclick': {
                const ending = this._endingDrag;
                this._endingDrag = false;
                return ending;
            }
            default:
                return this._dragging;
        }
    }

    /**
     * Takes the gizmo, its layer and its entity out of the app.
     */
    destroy() {
        const camera = this._gizmo.camera;
        this._gizmo.destroy();
        camera.layers = camera.layers.filter(id => id !== this._layer.id);
        this._app.scene.layers.remove(this._layer);
    }
}

export { POINTER_EVENTS as TRANSFORM_POINTER_EVENTS, TransformTool };
