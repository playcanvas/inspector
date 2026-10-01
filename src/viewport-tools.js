import {
    BoundingBox, Entity, PROJECTION_ORTHOGRAPHIC, RENDERSTYLE_SOLID, RENDERSTYLE_WIREFRAME, SHADERPASS_ALBEDO, SHADERPASS_AO, SHADERPASS_EMISSION, SHADERPASS_FORWARD, SHADERPASS_GLOSS, SHADERPASS_LIGHTING, SHADERPASS_METALNESS, SHADERPASS_OPACITY, SHADERPASS_SPECULARITY, SHADERPASS_UV0, SHADERPASS_WORLDNORMAL, Vec2, Vec3, math
} from 'playcanvas';

import { Picker } from './picker/picker.js';
import { FlyController } from './input/fly-controller.js';
import { OrbitController } from './input/orbit-controller.js';
import { InputFrame } from './input/input.js';
import { Pose } from './input/pose.js';

import { collectMeshInstances } from './instance-survey.js';

/** @import { Quat } from 'playcanvas' */
/** @import { AppBase } from 'playcanvas' */
/** @import { CameraComponent } from 'playcanvas' */
/** @import { GraphNode } from 'playcanvas' */
/** @import { MeshInstance } from 'playcanvas' */

/**
 * The shader passes a camera can render with, as the editor offers them: the lit scene, and the
 * debug views of the standard material's inputs.
 */
const RENDER_MODES = [
    [SHADERPASS_FORWARD, 'standard'], [SHADERPASS_ALBEDO, 'albedo'], [SHADERPASS_OPACITY, 'opacity'],
    [SHADERPASS_WORLDNORMAL, 'world normal'], [SHADERPASS_SPECULARITY, 'specularity'], [SHADERPASS_GLOSS, 'gloss'],
    [SHADERPASS_METALNESS, 'metalness'], [SHADERPASS_AO, 'ao'], [SHADERPASS_EMISSION, 'emission'],
    [SHADERPASS_LIGHTING, 'lighting'], [SHADERPASS_UV0, 'uv0']
];

// the input events the pick and fly modes take ahead of the app while they are on
const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu', 'touchstart', 'touchmove', 'touchend'];

/**
 * @param {Event} e - An event.
 * @returns {boolean} Whether it is aimed at a text field, which keeps its keys.
 */
function isTextTarget(e) {
    const target = /** @type {HTMLElement|undefined} */ (e.composedPath?.()[0]);
    return !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}

/**
 * @param {CameraComponent} camera - A camera.
 * @returns {boolean} Whether it draws to the screen, the ones a pointer can be over.
 */
function isScreenCamera(camera) {
    return camera.enabled && camera.entity.enabled && !camera.renderTarget;
}

/**
 * The screen camera whose viewport holds a point of the canvas, the last one drawn when several
 * overlap, which is the one on top.
 *
 * @param {AppBase} app - The app.
 * @param {number} x - The point, as a fraction of the canvas width from its left edge.
 * @param {number} y - The point, as a fraction of the canvas height from its top edge.
 * @returns {CameraComponent|null} The camera, or null when no camera draws there.
 */
function screenCameraAt(app, x, y) {
    const cameras = /** @type {CameraComponent[]} */ (app.systems.camera?.cameras ?? []);
    let found = null;
    for (const camera of cameras) {
        if (!isScreenCamera(camera)) continue;
        // a camera rect has its origin at the bottom left
        const rect = camera.rect;
        const up = 1 - y;
        if (x >= rect.x && x <= rect.x + rect.z && up >= rect.y && up <= rect.y + rect.w) found = camera;
    }
    return found;
}

/**
 * @param {GraphNode|null} node - A node.
 * @returns {Entity|null} The node, or the closest entity above it: the node of a mesh instance an
 * imported model creates can be a plain graph node.
 */
function entityOf(node) {
    let current = node;
    while (current && !(current instanceof Entity)) current = current.parent;
    return /** @type {Entity|null} */ (current);
}

/**
 * Takes the pointer events on the canvas ahead of the app's own handlers, for a mode of the
 * inspector that uses the pointer itself. The listeners sit in the capture phase on the window, so
 * they run before any listener of the app, and stop the events there.
 */
class CanvasCapture {
    /** @type {HTMLCanvasElement} */
    canvas;

    /** @type {(e: Event) => void} */
    _listener;

    /**
     * @param {HTMLCanvasElement} canvas - The canvas.
     * @param {(e: Event) => void} onEvent - Called with every pointer event on the canvas.
     */
    constructor(canvas, onEvent) {
        this.canvas = canvas;
        this._listener = (e) => {
            // a drag started on the canvas keeps its moves and release when the pointer leaves it
            if (e.target !== canvas && !(this._dragging && (e.type.endsWith('move') || e.type.endsWith('up')))) return;
            if (e.type === 'pointerdown' || e.type === 'mousedown') this._dragging = true;
            if (e.type === 'pointerup' || e.type === 'mouseup') this._dragging = false;
            e.stopImmediatePropagation();
            if (e.cancelable) e.preventDefault();
            onEvent(e);
        };
        this._dragging = false;
        for (const type of POINTER_EVENTS) window.addEventListener(type, this._listener, { capture: true, passive: false });
    }

    destroy() {
        for (const type of POINTER_EVENTS) window.removeEventListener(type, this._listener, { capture: true });
    }
}

/**
 * Picks the entity under the pointer, through the screen camera whose viewport holds it, the way
 * the editor picks: an id buffer the size of the canvas is rendered for that camera, which draws
 * into its own viewport of it, and read back under the pointer.
 */
class ViewportPicker {
    /** @type {AppBase} */
    app;

    /** @type {Picker|null} */
    _picker = null;

    /**
     * The picks in flight, one after the other, as each reads back the id buffer the next renders.
     *
     * @type {Promise<*>}
     */
    _queue = Promise.resolve();

    /**
     * @param {AppBase} app - The app.
     */
    constructor(app) {
        this.app = app;
    }

    /**
     * @param {number} clientX - The pointer, in client pixels.
     * @param {number} clientY - The pointer, in client pixels.
     * @returns {Promise<{ entity: Entity, instance: MeshInstance, camera: CameraComponent }|null>} What
     * is under the pointer, or null for nothing. Picks run one after the other.
     */
    pick(clientX, clientY) {
        const result = this._queue.then(() => this._pickNow(clientX, clientY));
        this._queue = result.catch(() => null);
        return result;
    }

    /**
     * @param {number} clientX - The pointer, in client pixels.
     * @param {number} clientY - The pointer, in client pixels.
     * @returns {Promise<{ entity: Entity, instance: MeshInstance, camera: CameraComponent }|null>} What
     * is under the pointer.
     * @private
     */
    async _pickNow(clientX, clientY) {
        if (!this._picker && this._destroyed) return null;
        const device = this.app.graphicsDevice;
        const canvas = /** @type {HTMLCanvasElement} */ (device.canvas);
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return null;
        const fx = (clientX - bounds.left) / bounds.width;
        const fy = (clientY - bounds.top) / bounds.height;
        const camera = screenCameraAt(this.app, fx, fy);
        if (!camera) return null;

        this._picker ??= new Picker(this.app, device.width, device.height);
        if (this._picker.width !== device.width || this._picker.height !== device.height) {
            this._picker.resize(device.width, device.height);
        }
        this._picker.prepare(camera, this.app.scene);

        const [hit] = await this._picker.getSelectionAsync(Math.floor(fx * device.width), Math.floor(fy * device.height));
        const node = /** @type {any} */ (hit)?.node ?? /** @type {any} */ (hit)?.entity ?? null;
        const entity = entityOf(node);
        return entity ? { entity, instance: /** @type {MeshInstance} */ (hit), camera } : null;
    }

    destroy() {
        this._destroyed = true;
        this._picker?.destroy();
        this._picker = null;
    }
}

const _position = new Vec3();
const _target = new Vec3();
const _offset = new Vec3();
const _focus = new Vec3();
const _from = new Pose();

// fly speeds: units a second, and degrees of turn per pixel dragged
const FLY_SPEED = 5;
const FLY_FAST = 4;
const LOOK_SPEED = 0.2;

// an orthographic view pans by this share of its height a second, and zooms by this rate
const ORTHO_PAN = 0.5;
const ORTHO_ZOOM = 1;

// orbit speeds: degrees of turn per pixel dragged, and the share of the distance a wheel pixel zooms
const ORBIT_SPEED = 0.3;
const ORBIT_ZOOM = 0.0012;

// the pitch an orbit stays within, short of straight up and down, where it would flip over
const ORBIT_PITCH = new Vec2(-89, 89);

// the keys that fly, as offsets along right, up and forward
const FLY_KEYS = {
    KeyW: [0, 0, 1],
    ArrowUp: [0, 0, 1],
    KeyS: [0, 0, -1],
    ArrowDown: [0, 0, -1],
    KeyA: [-1, 0, 0],
    ArrowLeft: [-1, 0, 0],
    KeyD: [1, 0, 0],
    ArrowRight: [1, 0, 0],
    KeyE: [0, 1, 0],
    PageUp: [0, 1, 0],
    KeyQ: [0, -1, 0],
    PageDown: [0, -1, 0]
};

/**
 * Drives a camera the app keeps drawing with, from the inspector's own input. The app may move the
 * camera itself, from a script or from code of its own, so the camera is not taken over: its
 * transform is swapped for the driven one on the app's prerender event, after every update has run,
 * and put back on postrender, so the frame is drawn from the driven pose while the app keeps seeing
 * and moving its own. Its projection is held the same way, at the field of view or orthographic
 * height it had when the drive started, as an app may animate those too. Ending the drive needs no
 * restoring. The keyboard and the pointer on the canvas are taken ahead of the app while driving,
 * and the drive runs on the wall clock, so a paused app can be looked around.
 *
 * @abstract
 */
class CameraDrive {
    /** @type {AppBase} */
    app;

    /** @type {CameraComponent} */
    camera;

    /** @type {{ position: Vec3, rotation: Quat, fov: number, orthoHeight: number }|null} */
    _saved = null;

    /** Whether the camera is orthographic, which zooms by its height rather than by moving. */
    _ortho = false;

    /** The field of view the driven view keeps. */
    _fov = 0;

    /** The orthographic height the driven view keeps, changed by zooming. */
    _orthoHeight = 0;

    _lastTime = 0;

    /** @type {CanvasCapture} */
    _capture;

    /**
     * @param {AppBase} app - The app.
     * @param {CameraComponent} camera - The camera to drive.
     * @param {() => void} onEnd - Called when the drive ends from the keyboard.
     */
    constructor(app, camera, onEnd) {
        this.app = app;
        this.camera = camera;
        this._onEnd = onEnd;
        this._ortho = camera.projection === PROJECTION_ORTHOGRAPHIC;
        this._fov = camera.fov;
        this._orthoHeight = camera.orthoHeight;

        // the subclasses' handlers are methods, so they are bound here rather than as fields,
        // which would not exist yet while this constructor runs
        this._pointerListener = e => this._onPointer(e);
        this._keyDownListener = (e) => {
            if (isTextTarget(e)) return;
            if (e.key === 'Escape') {
                e.stopImmediatePropagation();
                this._onEnd();
                return;
            }
            this._onKey(e, true);
        };
        this._keyUpListener = e => this._onKey(e, false);
        this._blurListener = () => this._onBlur();

        this._capture = new CanvasCapture(/** @type {HTMLCanvasElement} */ (app.graphicsDevice.canvas), this._pointerListener);
        window.addEventListener('keydown', this._keyDownListener, true);
        window.addEventListener('keyup', this._keyUpListener, true);
        window.addEventListener('blur', this._blurListener);
        app.on('prerender', this._onPrerender, this);
        app.on('postrender', this._onPostrender, this);
        this._lastTime = performance.now();
    }

    destroy() {
        this.app.off('prerender', this._onPrerender, this);
        this.app.off('postrender', this._onPostrender, this);
        window.removeEventListener('keydown', this._keyDownListener, true);
        window.removeEventListener('keyup', this._keyUpListener, true);
        window.removeEventListener('blur', this._blurListener);
        this._capture.destroy();
        this._onPostrender();
    }

    /**
     * @param {Event} e - A pointer event on the canvas.
     * @abstract
     */
    _onPointer(e) {}

    /**
     * @param {KeyboardEvent} e - A key pressed or released, other than Esc.
     * @param {boolean} down - Whether it was pressed.
     */
    _onKey(e, down) {}

    _onBlur() {}

    /**
     * @param {number} dt - Seconds since the last frame.
     * @returns {Pose} The pose to draw from this frame.
     * @abstract
     */
    _update(dt) {
        return new Pose();
    }

    _onPrerender() {
        const now = performance.now();
        const dt = Math.min(0.1, (now - this._lastTime) / 1000);
        this._lastTime = now;
        const pose = this._update(dt);

        // draw from the driven pose and projection, keeping the app's own to put back after the frame
        const camera = this.camera;
        const entity = camera.entity;
        if (!this._saved) {
            this._saved = {
                position: entity.getLocalPosition().clone(),
                rotation: entity.getLocalRotation().clone(),
                fov: camera.fov,
                orthoHeight: camera.orthoHeight
            };
        }
        entity.setPosition(pose.position);
        entity.setEulerAngles(pose.angles);
        if (this._ortho) {
            if (camera.orthoHeight !== this._orthoHeight) camera.orthoHeight = this._orthoHeight;
        } else if (camera.fov !== this._fov) {
            camera.fov = this._fov;
        }
    }

    _onPostrender() {
        const saved = this._saved;
        if (!saved) return;
        this._saved = null;
        const camera = this.camera;
        const entity = camera.entity;
        entity.setLocalPosition(saved.position);
        entity.setLocalRotation(saved.rotation);
        if (camera.fov !== saved.fov) camera.fov = saved.fov;
        if (camera.orthoHeight !== saved.orthoHeight) camera.orthoHeight = saved.orthoHeight;
    }

    /**
     * @returns {boolean} Whether the view zooms by its orthographic height rather than by moving.
     */
    get zooms() {
        return this._ortho;
    }
}

/**
 * Flies a camera with the mouse and WASD. An orthographic view shows no movement along its
 * direction, so there forward and back zoom instead, and panning scales with the height of the view.
 */
class CameraFly extends CameraDrive {
    /** Units a second, changed with the wheel. */
    speed = FLY_SPEED;

    /** @type {FlyController} */
    _controller = new FlyController();

    /** @type {InputFrame<{ move: number[], rotate: number[] }>} */
    _frame = new InputFrame({ move: [0, 0, 0], rotate: [0, 0] });

    /** @type {Pose} */
    _pose = new Pose();

    /** @type {Set<string>} */
    _keys = new Set();

    _fast = false;

    _looking = false;

    _lastX = 0;

    _lastY = 0;

    /**
     * @param {AppBase} app - The app.
     * @param {CameraComponent} camera - The camera to fly.
     * @param {() => void} onEnd - Called when the flight ends from the keyboard.
     */
    constructor(app, camera, onEnd) {
        super(app, camera, onEnd);

        // start where the camera is, looking where it looks
        const entity = camera.entity;
        _position.copy(entity.getPosition());
        _target.copy(entity.forward).add(_position);
        this._pose.look(_position, _target);
        this._controller.attach(this._pose, false);
        this._controller.moveDamping = 0.9;
        this._controller.rotateDamping = 0.8;
    }

    /** @param {Event} e - A pointer event on the canvas. */
    _onPointer(e) {
        const pointer = /** @type {PointerEvent} */ (e);
        if (e.type === 'pointerdown') {
            this._looking = true;
            this._lastX = pointer.clientX;
            this._lastY = pointer.clientY;
        } else if (e.type === 'pointerup') {
            this._looking = false;
        } else if (e.type === 'pointermove' && this._looking) {
            this._frame.deltas.rotate.append([(pointer.clientX - this._lastX) * LOOK_SPEED, (pointer.clientY - this._lastY) * LOOK_SPEED]);
            this._lastX = pointer.clientX;
            this._lastY = pointer.clientY;
        } else if (e.type === 'wheel') {
            const wheel = /** @type {WheelEvent} */ (e);
            this.speed = Math.min(1000, Math.max(0.05, this.speed * (wheel.deltaY < 0 ? 1.2 : 1 / 1.2)));
        }
    }

    /**
     * @param {KeyboardEvent} e - The event.
     * @param {boolean} down - Whether the key was pressed.
     */
    _onKey(e, down) {
        this._fast = e.shiftKey;
        if (!down) {
            if (this._keys.delete(e.code)) e.stopImmediatePropagation();
        } else if (FLY_KEYS[e.code] && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.stopImmediatePropagation();
            e.preventDefault();
            this._keys.add(e.code);
        }
    }

    _onBlur() {
        this._keys.clear();
        this._looking = false;
    }

    /**
     * @param {number} dt - Seconds since the last frame.
     * @returns {Pose} The flown pose.
     */
    _update(dt) {
        const move = [0, 0, 0];
        for (const code of this._keys) {
            const offset = FLY_KEYS[code];
            for (let i = 0; i < 3; i++) move[i] += offset[i];
        }
        const boost = this._fast ? FLY_FAST : 1;
        let step = this.speed * boost * dt;
        if (this._ortho) {
            // forward and back zoom, and the view pans in proportion to what it shows
            const rate = (this.speed / FLY_SPEED) * boost * ORTHO_ZOOM * dt;
            this._orthoHeight = Math.max(1e-3, this._orthoHeight * Math.exp(-move[2] * rate));
            move[2] = 0;
            step = this._orthoHeight * ORTHO_PAN * (this.speed / FLY_SPEED) * boost * dt;
        }
        this._frame.deltas.move.append(move.map(value => value * step));
        return this._controller.update(this._frame, dt);
    }
}

/**
 * Orbits a camera around a node: drag to orbit, right-drag or Shift-drag to pan, and the wheel to
 * zoom. The camera turns to the node from where it is, keeping its distance unless that is inside
 * the node's bounds. The orbit follows the node as it moves, around the center of its bounds when
 * the orbit started, or its position when it has none. An orthographic view zooms by its height.
 */
class CameraOrbit extends CameraDrive {
    /** @type {GraphNode} */
    target;

    /** @type {OrbitController} */
    _controller = new OrbitController();

    /** @type {InputFrame<{ move: number[], rotate: number[] }>} */
    _frame = new InputFrame({ move: [0, 0, 0], rotate: [0, 0] });

    /** The pose drawn last, for a change of target to turn from. */
    _pose = new Pose();

    /** The center of the target's bounds, relative to its position. */
    _center = new Vec3();

    /** Where the orbit was centered last frame, to follow the target by. */
    _focus = new Vec3();

    /** @type {'orbit'|'pan'|null} */
    _drag = null;

    _lastX = 0;

    _lastY = 0;

    /**
     * @param {AppBase} app - The app.
     * @param {CameraComponent} camera - The camera to orbit.
     * @param {GraphNode} target - The node to orbit around.
     * @param {() => void} onEnd - Called when the orbit ends from the keyboard.
     */
    constructor(app, camera, target, onEnd) {
        super(app, camera, onEnd);
        this._controller.pitchRange = ORBIT_PITCH;
        this._controller.moveDamping = 0.8;
        this._controller.rotateDamping = 0.8;
        this._controller.zoomDamping = 0.8;

        // the pose the camera has now, focused straight ahead, for the turn to the target to start from
        const entity = camera.entity;
        _position.copy(entity.getPosition());
        _target.copy(entity.forward).add(_position);
        this._pose.look(_position, _target);
        this._controller.attach(this._pose, false);
        this.setTarget(target);
    }

    /**
     * Turns the orbit to another node, from where the camera is now.
     *
     * @param {GraphNode} target - The node to orbit around.
     */
    setTarget(target) {
        this.target = target;
        const radius = boundsOf(target, this._center);
        this._focus.copy(this._center);
        this._center.sub(target.getPosition());

        // keep the distance the camera is at, unless that is inside the bounds
        const position = this._pose.position;
        const distance = Math.max(position.distance(this._focus), radius * 1.5, 1e-3);
        _offset.sub2(position, this._focus).normalize().mulScalar(distance);
        _from.look(_position.add2(this._focus, _offset), this._focus);
        this._controller.attach(_from, true);
    }

    /** @param {Event} e - A pointer event on the canvas. */
    _onPointer(e) {
        const pointer = /** @type {PointerEvent} */ (e);
        if (e.type === 'pointerdown') {
            this._drag = pointer.button === 2 || pointer.button === 1 || pointer.shiftKey ? 'pan' : 'orbit';
            this._lastX = pointer.clientX;
            this._lastY = pointer.clientY;
        } else if (e.type === 'pointerup') {
            this._drag = null;
        } else if (e.type === 'pointermove' && this._drag) {
            const dx = pointer.clientX - this._lastX;
            const dy = pointer.clientY - this._lastY;
            this._lastX = pointer.clientX;
            this._lastY = pointer.clientY;
            if (this._drag === 'orbit') {
                this._frame.deltas.rotate.append([dx * ORBIT_SPEED, dy * ORBIT_SPEED]);
            } else {
                // pan by what the view shows at the target, so the scene there moves with the pointer
                const height = this._ortho ?
                    this._orthoHeight * 2 :
                    2 * this._controller._childPose.position.z * Math.tan(this._fov * 0.5 * math.DEG_TO_RAD);
                const scale = height / Math.max(1, this._capture.canvas.clientHeight);
                this._frame.deltas.move.append([-dx * scale, dy * scale, 0]);
            }
        } else if (e.type === 'wheel') {
            const wheel = /** @type {WheelEvent} */ (e);
            const zoom = Math.max(-0.5, Math.min(0.5, wheel.deltaY * ORBIT_ZOOM));
            if (this._ortho) {
                this._orthoHeight = Math.max(1e-3, this._orthoHeight * (1 + zoom));
            } else {
                this._frame.deltas.move.append([0, 0, zoom]);
            }
        }
    }

    _onBlur() {
        this._drag = null;
    }

    /**
     * @param {number} dt - Seconds since the last frame.
     * @returns {Pose} The orbiting pose.
     */
    _update(dt) {
        // follow the target as it moves, without the lag of the smoothing. The controller has no
        // way to move its focus without easing, so its two root poses move directly
        _focus.add2(this.target.getPosition(), this._center);
        if (!_focus.equals(this._focus)) {
            _offset.sub2(_focus, this._focus);
            this._controller._rootPose.position.add(_offset);
            this._controller._targetRootPose.position.add(_offset);
            this._focus.copy(_focus);
        }
        const pose = this._controller.update(this._frame, dt);
        this._pose.copy(pose);
        return pose;
    }
}

/**
 * The world bounds of a node and everything under it, from the mesh instances of their render and
 * model components and the bounds of their splats.
 *
 * @param {GraphNode} node - The node.
 * @param {Vec3} center - Receives the center of the bounds, or the node's position when it has none.
 * @returns {number} The radius of the bounds, or 0 when the node has none.
 */
function boundsOf(node, center) {
    const bounds = new BoundingBox();
    let found = false;
    const add = (aabb) => {
        if (found) {
            bounds.add(aabb);
        } else {
            bounds.copy(aabb);
            found = true;
        }
    };
    node.forEach((child) => {
        if (!(child instanceof Entity) || !child.enabled) return;
        const meshInstances = child.render?.meshInstances ?? child.model?.meshInstances;
        if (meshInstances) {
            for (const meshInstance of meshInstances) {
                if (meshInstance.visible) add(meshInstance.aabb);
            }
        }
        const splat = child.gsplat?.customAabb;
        if (splat) {
            const world = new BoundingBox();
            world.setFromTransformedAabb(splat, child.getWorldTransform());
            add(world);
        }
    });
    if (!found) {
        center.copy(node.getPosition());
        return 0;
    }
    center.copy(bounds.center);
    return bounds.halfExtents.length();
}

/**
 * Draws every mesh instance of the app in wireframe while on, keeping the render style each had to
 * put back. Mesh instances the app adds while it is on take it on at the next apply.
 */
class WireframeMode {
    /** @type {Map<MeshInstance, number>} */
    _styles = new Map();

    /**
     * @param {AppBase} app - The app, whose mesh instances to draw in wireframe.
     */
    apply(app) {
        for (const { instance } of collectMeshInstances(app)) {
            if (this._styles.has(instance)) continue;
            this._styles.set(instance, instance.renderStyle);
            if (instance.renderStyle !== RENDERSTYLE_WIREFRAME) instance.renderStyle = RENDERSTYLE_WIREFRAME;
        }
    }

    /** Puts back the render style of every mesh instance drawn in wireframe. */
    restore() {
        for (const [instance, style] of this._styles) {
            if (instance.mesh && instance.renderStyle !== style) instance.renderStyle = style ?? RENDERSTYLE_SOLID;
        }
        this._styles.clear();
    }
}

export { CameraFly, CameraOrbit, CanvasCapture, RENDER_MODES, ViewportPicker, WireframeMode, isScreenCamera, screenCameraAt };
