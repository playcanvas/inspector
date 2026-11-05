import {
    drawQuadWithShader, FILTER_NEAREST, FILTER_NEAREST_MIPMAP_LINEAR, FILTER_NEAREST_MIPMAP_NEAREST, isIntegerPixelFormat,
    isSrgbPixelFormat, PIXELFORMAT_DEPTH, PIXELFORMAT_DEPTH16, PIXELFORMAT_DEPTHSTENCIL, PIXELFORMAT_R16F, PIXELFORMAT_R32F,
    PIXELFORMAT_R8, PIXELFORMAT_RG32F, PIXELFORMAT_RGB32F, PIXELFORMAT_RGBA32F, PIXELFORMAT_RGBA8, PIXELFORMAT_SRGBA8,
    RenderTarget, SEMANTIC_POSITION, ShaderUtils, Texture
} from 'playcanvas';

import { storedBottomUp } from './render-target-view.js';
import { createTextureShaderDesc } from './renderers/texture-renderer-shaders.js';

/** @import { AppBase, GraphicsDevice, Shader } from 'playcanvas' */

/**
 * An image captured from the app, ready to hand to an agent.
 *
 * @typedef {object} CapturedImage
 * @ignore
 * @property {number} width - The width of the image in pixels.
 * @property {number} height - The height of the image in pixels.
 * @property {string} png - The image as a PNG file, base64 encoded.
 */

/**
 * @typedef {object} CaptureJob
 * @ignore
 * @property {'texture'|'canvas'} kind - What is captured.
 * @property {Texture|null} texture - The texture, for a texture.
 * @property {number} maxSize - The longest side of the image, at most.
 * @property {string} channels - Three of r, g, b and a, or 'rgb' to decode the texture.
 * @property {boolean} flip - Whether the texture holds its rows bottom-up.
 * @property {(image: CapturedImage) => void} resolve - Called with the image.
 * @property {(error: Error) => void} reject - Called when it cannot be captured.
 * @property {ReturnType<typeof setTimeout>} timer - Gives up when no frame renders.
 */

// how long a capture waits for the app to render a frame
const FRAME_TIMEOUT = 5000;

// the red channel replicated, for a single channel and for the default selection
const SINGLE_CHANNEL_INDICES = new Int32Array([0, 0, 0]);

// the full-screen quad of the device, whose positions run from -1 to 1, with its texture coordinate
const QUAD_GLSL = /* glsl */ `
    attribute vec2 vertex_position;
    varying vec2 uv0;

    void main(void) {
        gl_Position = vec4(vertex_position, 0.5, 1.0);
        uv0 = vertex_position * 0.5 + 0.5;
    }
`;

const QUAD_WGSL = /* wgsl */ `
    attribute vertex_position: vec2f;
    varying uv0: vec2f;

    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = vec4f(input.vertex_position, 0.5, 1.0);
        output.uv0 = input.vertex_position * 0.5 + vec2f(0.5);
        return output;
    }
`;

/**
 * How a texture is sampled to show it, the way the texture previews choose, see
 * TextureRenderer#draw, which this follows so a capture looks like the preview.
 *
 * @param {Texture} texture - The texture.
 * @param {GraphicsDevice} device - The device.
 * @param {string} channels - Three of r, g, b and a; 'rgb' decodes the texture's encoding.
 * @returns {{ mode: string, encoding: string, channelIndices: Int32Array }|string} How to sample
 * it, or why it cannot be captured.
 */
function textureSampling(texture, device, channels) {
    if (texture.device !== device || texture.cubemap || texture.volume || texture.arrayLength ||
        texture.samples > 1 || isIntegerPixelFormat(texture.format)) {
        return 'Only 2D color and depth textures can be captured, not cube, volume, array, multisampled or integer ones';
    }
    const format = texture.format;
    const depth = format === PIXELFORMAT_DEPTH || format === PIXELFORMAT_DEPTH16 || format === PIXELFORMAT_DEPTHSTENCIL;
    if (depth && device.isWebGL2 && texture.compareOnRead) {
        return 'A comparison depth texture, such as a shadow map, cannot be captured on WebGL2';
    }
    const unfilterable = !device.textureFloatFilterable &&
        (format === PIXELFORMAT_R32F || format === PIXELFORMAT_RG32F || format === PIXELFORMAT_RGB32F || format === PIXELFORMAT_RGBA32F);
    if (device.isWebGL2 && (depth || unfilterable)) {
        const minFilter = texture.minFilter;
        const nearestMin = minFilter === FILTER_NEAREST || minFilter === FILTER_NEAREST_MIPMAP_NEAREST ||
            (!texture.mipmaps && minFilter === FILTER_NEAREST_MIPMAP_LINEAR);
        if (!nearestMin || texture.magFilter !== FILTER_NEAREST) {
            return 'A depth or unfilterable float texture needs nearest filtering to be captured on WebGL2';
        }
    }
    const singleChannel = format === PIXELFORMAT_R8 || format === PIXELFORMAT_R16F || format === PIXELFORMAT_R32F;
    const decoded = channels === 'rgb' && !singleChannel;
    const encoding = depth ? 'linear' : decoded ? texture.encoding : isSrgbPixelFormat(format) ? 'raw-srgb' : 'raw';
    const channelIndices = channels === 'rgb' ? SINGLE_CHANNEL_INDICES : Int32Array.from(channels, c => 'rgba'.indexOf(c));
    return { mode: depth ? 'depth' : unfilterable ? 'unfilterable' : 'filtered', encoding, channelIndices };
}

/**
 * @param {number} width - The width of the source.
 * @param {number} height - The height of the source.
 * @param {number} maxSize - The longest side wanted, at most.
 * @returns {{ width: number, height: number }} The size of the image: the source's, scaled down to
 * fit, never up.
 */
function fitSize(width, height, maxSize) {
    const scale = Math.min(1, maxSize / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * @param {HTMLCanvasElement} canvas - A canvas.
 * @returns {string} Its content as a PNG file, base64 encoded.
 */
function canvasPng(canvas) {
    const url = canvas.toDataURL('image/png');
    return url.slice(url.indexOf(',') + 1);
}

/**
 * @param {Uint8Array} pixels - RGBA pixels, row after row.
 * @param {number} width - The width.
 * @param {number} height - The height.
 * @param {boolean} flip - Whether the rows run bottom-up, to turn them the right way up.
 * @returns {string} The pixels as a PNG file, base64 encoded.
 */
function pixelsPng(pixels, width, height, flip) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const image = new ImageData(width, height);
    const stride = width * 4;
    for (let y = 0; y < height; y++) {
        const from = (flip ? height - 1 - y : y) * stride;
        image.data.set(pixels.subarray(from, from + stride), y * stride);
    }
    /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).putImageData(image, 0, 0);
    return canvasPng(canvas);
}

/**
 * Captures textures, render target attachments and the canvas into PNG images. A texture is drawn
 * with the shaders of the texture previews into an 8-bit render target the size of the image, and
 * read back, so an encoded or HDR texture, a depth buffer or a float target comes out as the
 * preview shows it. Each capture waits for the next frame: a texture is drawn once the app has
 * rendered it, inside the frame, and the canvas read once the frame is done.
 *
 * @ignore
 */
class ImageCapture {
    /**
     * @type {AppBase|null}
     * @private
     */
    _app;

    /**
     * @type {CaptureJob[]}
     * @private
     */
    _jobs = [];

    /**
     * The capture shaders, by mode and encoding.
     *
     * @type {Map<string, Shader>}
     * @private
     */
    _shaders = new Map();

    /**
     * @param {AppBase} app - The app.
     */
    constructor(app) {
        this._app = app;
        // a texture is drawn inside the frame, as the device takes render passes between its start
        // and end, and the canvas read once the frame is done, when it holds the frame on WebGPU too
        app.on('postrender', this._onPostRender, this);
        app.on('frameend', this._onFrameEnd, this);
    }

    destroy() {
        const app = this._app;
        if (!app) return;
        app.off('postrender', this._onPostRender, this);
        app.off('frameend', this._onFrameEnd, this);
        for (const job of this._jobs.splice(0)) this._fail(job, new Error('The inspector was destroyed'));
        for (const shader of this._shaders.values()) shader.destroy();
        this._shaders.clear();
        this._app = null;
    }

    /**
     * Captures a texture as its preview shows it.
     *
     * @param {Texture} texture - The texture.
     * @param {object} [options] - The options.
     * @param {number} [options.maxSize] - The longest side of the image, at most. Defaults to 512.
     * @param {string} [options.channels] - Three of r, g, b and a, to show stored channels; 'rgb'
     * decodes the texture's encoding. Defaults to 'rgb'.
     * @returns {Promise<CapturedImage>} The image.
     */
    texture(texture, { maxSize = 512, channels = 'rgb' } = {}) {
        const app = /** @type {AppBase} */ (this._app);
        const sampling = textureSampling(texture, app.graphicsDevice, channels);
        if (typeof sampling === 'string') return Promise.reject(new Error(sampling));
        return this._queue('texture', texture, maxSize, channels);
    }

    /**
     * Captures what the canvas shows at the end of the next frame.
     *
     * @param {object} [options] - The options.
     * @param {number} [options.maxSize] - The longest side of the image, at most. Defaults to 1024.
     * @returns {Promise<CapturedImage>} The image.
     */
    canvas({ maxSize = 1024 } = {}) {
        return this._queue('canvas', null, maxSize, 'rgb');
    }

    /**
     * @param {'texture'|'canvas'} kind - What is captured.
     * @param {Texture|null} texture - The texture, for a texture.
     * @param {number} maxSize - The longest side of the image.
     * @param {string} channels - The channels shown.
     * @returns {Promise<CapturedImage>} The image.
     * @private
     */
    _queue(kind, texture, maxSize, channels) {
        if (!this._app) return Promise.reject(new Error('The inspector was destroyed'));
        const device = this._app.graphicsDevice;
        return new Promise((resolve, reject) => {
            /** @type {CaptureJob} */
            const job = {
                kind,
                texture,
                maxSize,
                channels,
                resolve,
                reject,
                flip: !!texture && storedBottomUp(texture, device),
                timer: setTimeout(() => {
                    const index = this._jobs.indexOf(job);
                    if (index >= 0) this._jobs.splice(index, 1);
                    reject(new Error(`No frame rendered in ${FRAME_TIMEOUT / 1000} s, so nothing could be captured. Is the page hidden?`));
                }, FRAME_TIMEOUT)
            };
            this._jobs.push(job);
        });
    }

    /**
     * @param {CaptureJob} job - A job.
     * @param {Error} error - Why it failed.
     * @private
     */
    _fail(job, error) {
        clearTimeout(job.timer);
        job.reject(error);
    }

    /**
     * @param {CaptureJob} job - A job.
     * @param {CapturedImage} image - The image.
     * @private
     */
    _done(job, image) {
        clearTimeout(job.timer);
        job.resolve(image);
    }

    /**
     * @param {string} mode - The sampling mode.
     * @param {string} encoding - The encoding.
     * @returns {Shader} The shader drawing a texture with them over the full-screen quad.
     * @private
     */
    _shader(mode, encoding) {
        const key = `${mode}-${encoding}`;
        let shader = this._shaders.get(key);
        if (!shader) {
            const desc = createTextureShaderDesc(mode, encoding);
            shader = ShaderUtils.createShader(/** @type {AppBase} */ (this._app).graphicsDevice, {
                uniqueName: `InspectorCapture-${key}`,
                attributes: { vertex_position: SEMANTIC_POSITION },
                vertexGLSL: QUAD_GLSL,
                fragmentGLSL: desc.fragmentGLSL,
                vertexWGSL: QUAD_WGSL,
                fragmentWGSL: desc.fragmentWGSL
            });
            this._shaders.set(key, shader);
        }
        return shader;
    }

    /**
     * Draws the textures waiting to be captured, once the app has rendered them.
     *
     * @private
     */
    _onPostRender() {
        const jobs = this._jobs.filter(job => job.kind === 'texture');
        if (!jobs.length) return;
        this._jobs = this._jobs.filter(job => job.kind !== 'texture');
        for (const job of jobs) {
            try {
                this._captureTexture(job);
            } catch (e) {
                this._fail(job, e instanceof Error ? e : new Error(String(e)));
            }
        }
    }

    /**
     * @param {CaptureJob} job - A texture job.
     * @private
     */
    _captureTexture(job) {
        const app = /** @type {AppBase} */ (this._app);
        const device = app.graphicsDevice;
        const texture = /** @type {Texture} */ (job.texture);
        if (!texture.impl || /** @type {any} */ (texture)._destroyed) throw new Error('The texture was destroyed');
        const sampling = textureSampling(texture, device, job.channels);
        if (typeof sampling === 'string') throw new Error(sampling);

        const { width, height } = fitSize(texture.width, texture.height, job.maxSize);
        // decoded color is linear, and the sRGB target encodes it the way the screen shows it;
        // stored channels and depth are written as they are
        const raw = sampling.mode === 'depth' || sampling.encoding === 'raw' || sampling.encoding === 'raw-srgb';
        const target = new Texture(device, {
            name: 'InspectorCapture',
            width,
            height,
            format: raw ? PIXELFORMAT_RGBA8 : PIXELFORMAT_SRGBA8,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST
        });
        const rt = new RenderTarget({ name: 'InspectorCapture', colorBuffer: target, depth: false });
        device.scope.resolve('colorMap').setValue(texture);
        if (sampling.encoding === 'raw' || sampling.encoding === 'raw-srgb') {
            device.scope.resolve('textureChannels').setValue(sampling.channelIndices);
        }
        drawQuadWithShader(device, rt, this._shader(sampling.mode, sampling.encoding), undefined, undefined, 'InspectorCapture');

        // the quad puts the texture's first row at the bottom of the target, which WebGL reads
        // back first and WebGPU last
        const flip = device.isWebGPU !== job.flip;
        target.read(0, 0, width, height, { renderTarget: rt, immediate: true }).then((pixels) => {
            this._done(job, { width, height, png: pixelsPng(/** @type {Uint8Array} */ (pixels), width, height, flip) });
        }, (e) => {
            this._fail(job, e instanceof Error ? e : new Error(String(e)));
        }).finally(() => {
            rt.destroy();
            target.destroy();
        });
    }

    /**
     * Reads the canvas for the captures waiting for it, now that the frame is done.
     *
     * @private
     */
    _onFrameEnd() {
        const jobs = this._jobs.filter(job => job.kind === 'canvas');
        if (!jobs.length) return;
        this._jobs = this._jobs.filter(job => job.kind !== 'canvas');
        const source = /** @type {AppBase} */ (this._app).graphicsDevice.canvas;
        for (const job of jobs) {
            try {
                const { width, height } = fitSize(source.width, source.height, job.maxSize);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(source, 0, 0, width, height);
                this._done(job, { width, height, png: canvasPng(canvas) });
            } catch (e) {
                this._fail(job, e instanceof Error ? e : new Error(String(e)));
            }
        }
    }
}

export { ImageCapture, fitSize, textureSampling };
