import { formatBytes } from './model.js';
import { SCRIPT_CALLS, SCRIPT_ORDER, SCRIPT_STRIDE } from './perf-capture.js';
import {
    CPU_PARTS, EVENT_KINDS, HITCH_FACTOR, OTHER_SCRIPTS_COLOR, RENDER_PHASES, SCRIPT_ROWS, callCount, captureNorms, effectName,
    eventLines, eventMask, eventUnsupported, formatCount, formatMs, scriptLegend
} from './perf-view.js';

/** @import { PerfCapture } from './perf-capture.js' */
/** @import { PerfPart, PerfScriptLegend } from './perf-view.js' */

/**
 * @typedef {object} PerfChartDef
 * @ignore
 * @property {string} key - A key unique among the charts.
 * @property {string} title - The title drawn beside it.
 * @property {string} tip - What it shows, while the pointer is over its title.
 * @property {string} total - The channel holding the sum of its parts, which sets its scale and
 * picks the frame a column of many frames shows.
 * @property {PerfPart[]} parts - What it stacks, bottom up.
 * @property {PerfPart[]} [lines] - Parts of the stack drawn as lines across it, as they are
 * counted within the parts already.
 * @property {PerfPart[]} [plain] - What it stacks with an engine that does not break its total
 * down: the release engine.
 * @property {(value: number) => string} format - Formats its figures.
 * @property {boolean} [timing] - Whether it is a duration, scaled to show the display interval
 * as a watermark.
 * @property {number} [unit] - The unit its scale is rounded in, such as a megabyte for memory.
 * @property {string} [empty] - What it says while it has nothing to draw.
 */

/**
 * @typedef {object} PerfLine
 * @ignore
 * @property {string} key - The channel it draws.
 * @property {string} name - The display name.
 * @property {string} color - The color it is drawn in.
 * @property {string} [unsupported] - Why it cannot show, where it cannot.
 */

/**
 * @typedef {object} PerfLineChart
 * @ignore
 * @property {PerfLine[]} lines - Its lines.
 * @property {(value: number) => string} format - Formats their values.
 * @property {Int32Array} pick - The frame each column showed.
 * @property {number} min - The value at its bottom.
 * @property {number} max - The value at its top.
 * @property {PerfLevels|null} levels - How a height in it reads as a value, null while it has none.
 * @property {Float64Array[]} [values] - The ring each line was drawn from, where it is not a
 * channel of the capture.
 * @property {boolean} [stacked] - Whether its lines are stacked, as the times of the scripts are.
 * @property {PerfScriptLegend} [legend] - The script types it gives a band of their own.
 */

/**
 * @typedef {object} PerfScriptLine
 * @ignore
 * @property {string} key - The key it is hidden under.
 * @property {string} name - The display name.
 * @property {string} color - The color it is drawn in.
 * @property {number} id - The script type, by its index into the names of the capture, or -1 for
 * the other types together.
 * @property {boolean} pinned - Whether it has its band because it is pinned.
 */

/**
 * @typedef {object} PerfLevels
 * @ignore
 * @property {number} top - The top of the area its values are drawn in.
 * @property {number} bottom - Its bottom.
 * @property {number} min - The value at the bottom.
 * @property {number} max - The value at the top.
 * @property {(value: number) => string} format - Formats a value.
 */

/**
 * @typedef {object} PerfShape
 * @ignore
 * @property {string} total - The channel a chart is scaled to.
 * @property {PerfPart[]} parts - What it stacks.
 * @property {PerfPart[]} lines - Its lines across the stack.
 * @property {Float64Array[]} partData - The ring of each part.
 * @property {Float64Array[]} lineData - The ring of each line.
 * @property {boolean} reduced - Whether the inspector's time is left out.
 */

/**
 * @typedef {object} PerfRow
 * @ignore
 * @property {number} top - Its top edge in CSS pixels.
 * @property {number} height - Its height.
 * @property {number} [chart] - The index of the chart it holds, into {@link CHARTS}.
 * @property {PerfLevels} [levels] - How a height in it reads as a value, for a chart.
 * @property {string} [lines] - The section of the line chart it is a line of the list of:
 * 'scripts', 'memory' or 'resources'.
 * @property {number} [index] - Which line of that list it is, -1 for a row that is not one.
 * @property {'more'|'fewer'} [control] - The row of the Scripts list it is that shows more script
 * types, or fewer.
 * @property {number} [kind] - The index of the kind of event it marks, into {@link EVENT_KINDS}.
 * @property {string} [section] - The section it is the title of: 'memory', 'resources', 'events'
 * or the key of a collapsed chart.
 */

/**
 * @typedef {object} PerfHoverLine
 * @ignore
 * @property {string} text - The line.
 * @property {string} [color] - The color of what it names, shown as a chip in front of it.
 * @property {boolean} [indent] - Whether it is a part of the line above.
 * @property {boolean} [wrap] - Whether it is prose, wrapped to the width of the box.
 * @property {boolean} [strong] - Whether it is what the pointer is over, among the lines.
 * @property {boolean} [nested] - Whether it is a part of the indented line above, as a script type
 * among the other scripts.
 */

/**
 * @typedef {object} PerfTimeBar
 * @ignore
 * @property {string} lane - The key of the row of the frame timeline it goes on.
 * @property {number} start - When it began, in milliseconds from the start of the frame, NaN
 * where the engine did not time it.
 * @property {number} duration - How long it took in milliseconds.
 * @property {string} color - The color it is drawn in.
 * @property {string} name - What it is.
 * @property {boolean} positioned - Whether its start is known, rather than placed after the bar
 * before, as a GPU pass is.
 * @property {boolean} [instant] - Whether it has no duration, as an asset finishing loading.
 * @property {number} [calls] - How many calls it took, as a script type does; the mean per frame
 * for an average frame.
 * @property {string} [label] - What its hover box calls it, where its name alone is not enough.
 * @property {number} [script] - The script type it is, by its index into the names of the capture.
 * @property {PerfPassLink} [pass] - The pass of the frame graph it is, which a click shows on the
 * Frame graph tab.
 * @property {number} [run] - How many passes of its name follow on in a row from it, it among
 * them, which share one label; 0 for one inside such a run.
 * @property {number} [runDuration] - Their time together.
 * @property {PerfScriptType[]} [children] - What it is made of, which its hover box lists, as the
 * script types of the scripts.
 */

/**
 * @typedef {object} PerfPassLink
 * @ignore
 * @property {string} name - The profiler name of the pass.
 * @property {number} occurrence - Which of the passes of the frame graph with that name it is.
 */

/**
 * @typedef {object} PerfScriptType
 * @ignore
 * @property {number} id - The script type, by its index into the names of the capture.
 * @property {string} name - Its name.
 * @property {number} duration - Its own time in an update or a post-update, in milliseconds.
 * @property {number} [calls] - How many calls that took.
 * @property {number} [order] - Where its first call came among the types', 1 for the first.
 * @property {string} color - The color it is drawn in.
 */

/**
 * @typedef {object} PerfBar
 * @ignore
 * @property {number} x0 - Its left edge in CSS pixels.
 * @property {number} x1 - Its right edge.
 * @property {string} lane - The key of the row of the frame timeline it is on.
 * @property {string} name - What it is.
 * @property {string} color - The color it is drawn in.
 * @property {number} duration - How long it took in milliseconds, zero for an instant.
 * @property {number} start - When it began, in milliseconds into the frame, NaN where unknown.
 * @property {number} [calls] - How many calls it took.
 * @property {string} [label] - What its hover box calls it.
 * @property {number} [script] - The script type it is, which a click shows on the Scripts tab.
 * @property {PerfPassLink} [pass] - The pass of the frame graph it is, which a click shows on the
 * Frame graph tab.
 * @property {PerfScriptType[]} [children] - What it is made of.
 */

/**
 * The charts, top to bottom, above the rows of events.
 *
 * @type {PerfChartDef[]}
 */
const CHARTS = [
    {
        key: 'frame',
        title: 'Frame',
        tip: 'From the start of each frame to the start of the next, including any wait for the display',
        total: 'interval',
        format: formatMs,
        timing: true,
        parts: [{ key: 'interval', name: 'Frame', color: '#ffd60a', channel: 'interval' }]
    },
    {
        key: 'cpu',
        title: 'CPU',
        tip: 'Main-thread time of the update and the render, by part. What the frame takes beyond it is spent outside the engine',
        total: 'cpu',
        format: formatMs,
        timing: true,
        parts: CPU_PARTS
    },
    {
        key: 'gpu',
        title: 'GPU',
        tip: 'The time the GPU took for each frame',
        total: 'gpu',
        format: formatMs,
        timing: true,
        empty: 'Turn GPU timings on to record the GPU time of each frame',
        parts: [{ key: 'gpu', name: 'GPU', color: '#bf5af2', channel: 'gpu' }]
    },
    {
        key: 'draws',
        title: 'Draw calls',
        tip: 'The draw calls each frame submitted, by kind with the profiler and debug engines. Skinned draws are counted\nwithin the others, so they are a line across them',
        total: 'draws',
        format: formatCount,
        parts: [
            { key: 'forward', name: 'Forward', color: '#64d2ff', channel: 'drawsForward' },
            { key: 'shadow', name: 'Shadow', color: '#5e5ce6', channel: 'drawsShadow' },
            { key: 'misc', name: 'Other', color: '#ff9f0a', channel: 'drawsMisc' }
        ],
        lines: [{ key: 'skinned', name: 'Skinned', color: '#30d158', channel: 'drawsSkinned' }],
        plain: [{ key: 'draws', name: 'Draw calls', color: '#64d2ff', channel: 'draws' }]
    }
];

/**
 * The memory lines of the Memory chart, sharing its scale. The JavaScript heap is reported by
 * Chromium browsers only.
 *
 * @type {{ key: string, name: string, color: string }[]}
 */
const MEMORY = [
    { key: 'heap', name: 'JS heap', color: '#ffd60a' },
    { key: 'vram', name: 'Video memory', color: '#e5e5ea' },
    { key: 'vramTex', name: 'Textures', color: '#ff9f0a' },
    { key: 'vramVb', name: 'Vertex buffers', color: '#30d158' },
    { key: 'vramIb', name: 'Index buffers', color: '#00c7be' },
    { key: 'vramUb', name: 'Uniform buffers', color: '#0a84ff' },
    { key: 'vramSb', name: 'Storage buffers', color: '#bf5af2' }
];

// the smallest range the Memory chart spans, so the noise of a level that barely changes stays
// flat: a share of the largest value, or a fixed amount, whichever is larger
const MEMORY_MIN_SHARE = 0.01;
const MEMORY_MIN_BYTES = 256 * 1024;

// the least range of the Resources chart, so a count changing by one does not fill it
const RESOURCE_MIN_COUNT = 4;

/**
 * The resources on the device, a line each in the Resources section. Pipelines only exist on
 * WebGPU.
 *
 * @type {{ key: string, name: string, color: string }[]}
 */
const RESOURCES = [
    { key: 'textures', name: 'Textures', color: '#ff9f0a' },
    { key: 'targets', name: 'Render targets', color: '#ff375f' },
    { key: 'shaders', name: 'Shaders', color: '#bf5af2' },
    { key: 'buffers', name: 'Buffers', color: '#30d158' },
    { key: 'pipelines', name: 'Pipelines', color: '#64d2ff' }
];

// the phases of the render on the frame timeline, with their colors: shades around the green of
// the render
const RENDER_TIMELINE = RENDER_PHASES.map(([key, name], i) => [key, name, ['#34c759', '#8be0a4', '#00c7be', '#64d2ff', '#a2e85b', '#30b0c7', '#c4f0a0'][i]]);

// the colors GPU passes cycle through in the frame timeline
const PASS_COLORS = ['#bf5af2', '#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#64d2ff', '#ffd60a', '#5e5ce6'];

// the color of the update in the frame timeline, under its parts
const UPDATE_COLOR = '#2f6fdb';

// the fewest frames the charts spread over, so a short capture does not draw as a few wide bars
const MIN_SPAN = 300;

// the shortest part of a frame, in milliseconds, the timeline zooms in to
const MIN_TIME_SPAN = 0.05;

// the fewest frames the charts zoom in to
const MIN_ZOOM = 20;

// how far above the 95th percentile of its columns a chart scales to: beyond that a spike is cut
// off, marked along the top, rather than flattening everything else
const SPIKE_HEADROOM = 3;

// how far above the display interval a timing chart scales at least, so its watermark has room
const BUDGET_HEADROOM = 1.15;

// how often the charts redraw while recording, in milliseconds
const REDRAW_INTERVAL = 250;

// the most bars of a row of the frame timeline its hover box lists
const TIMELINE_HOVER_BARS = 12;

// the most script types and GPU passes a hover box lists: the script types of the timeline and
// those among the other scripts of the Scripts chart, and the GPU passes and effects of the timeline
const HOVER_SCRIPT_TYPES = 20;

// the most frames of a column the details of its events list
const HOVER_FRAMES = 3;

// the width of the names to the left of the charts and the timeline
const GUTTER = 96;

const CHART_GAP = 3;
// the least height of a chart: below it, the charts area scrolls rather than squeeze them further
const MIN_CHART_HEIGHT = 30;

// the dash patterns of the display interval line, made once
const DASH = [3, 3];
const NO_DASH = [];

// no parts, shared
const NO_PARTS = /** @type {PerfPart[]} */ ([]);

const SECTION_TITLE = 14;
const SCRIPT_ROW = 13;
// the fewest rows the Scripts chart is tall, for an app of few script types
const SCRIPT_CHART_ROWS = 3;
const MEMORY_ROW = 13;
const RESOURCE_ROW = 13;
const EVENT_ROW = 10;
const TIMELINE_HEIGHT = 88;
// how much taller the timeline is with its line of script types, and with its line of the passes
// of the GPU effects
const SCRIPT_TYPES_LINE = 13;
const GPU_PASSES_LINE = 11;
const FONT = '10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const BOLD = `600 ${FONT}`;

/**
 * @param {number} value - A positive value.
 * @returns {number} The smallest round number at or above it: one of a few steps between
 * consecutive powers of ten, close enough together that a chart keeps most of its height.
 */
function niceCeil(value) {
    if (!(value > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
        if (step * power >= value) return step * power;
    }
    return 10 * power;
}

/**
 * A horizontal scrollbar: a track with a thumb sized to the part of something in view. The thumb
 * is dragged to pan, the track beside it clicked to page and the bar scrolled over to pan. It only
 * says how the user moves it: its owner moves the view, and sets the thumb.
 *
 * @ignore
 */
class PerfScrollbar {
    /**
     * The bar, to place.
     *
     * @type {HTMLElement}
     */
    el;

    /**
     * @type {HTMLElement}
     * @private
     */
    _thumb;

    /** @private */
    _active = false;

    /** @private */
    _start = 0;

    /**
     * The thumb being dragged: where the pointer went down and where the thumb started then.
     *
     * @type {{ x: number, start: number }|null}
     * @private
     */
    _drag = null;

    /**
     * @param {Document} doc - The document to make it in.
     * @param {object} handlers - What the user does with it.
     * @param {(start: number) => void} handlers.onDrag - The thumb was dragged to start at this
     * fraction of the bar.
     * @param {(direction: number) => void} handlers.onPage - The track was clicked: -1 left of the
     * thumb, 1 right of it.
     * @param {(delta: number) => void} handlers.onWheel - The bar was scrolled over, by this many
     * pixels, sideways or down.
     */
    constructor(doc, { onDrag, onPage, onWheel }) {
        this.el = doc.createElement('div');
        this.el.className = 'pci-perf-hscroll pci-inactive';
        this._thumb = doc.createElement('div');
        this._thumb.className = 'pci-perf-hscroll-thumb';
        this.el.appendChild(this._thumb);

        this.el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.ctrlKey || !this._active) return;
            e.preventDefault();
            if (e.target === this._thumb) {
                this.el.setPointerCapture?.(e.pointerId);
                this._drag = { x: e.clientX, start: this._start };
                return;
            }
            onPage(e.clientX < this._thumb.getBoundingClientRect().left ? -1 : 1);
        });
        this.el.addEventListener('pointermove', (e) => {
            if (this._drag) onDrag(this._drag.start + (e.clientX - this._drag.x) / this.el.getBoundingClientRect().width);
        });
        const up = () => {
            this._drag = null;
        };
        this.el.addEventListener('pointerup', up);
        this.el.addEventListener('pointercancel', up);
        this.el.addEventListener('contextmenu', up);
        this.el.addEventListener('wheel', (e) => {
            if (!this._active) return;
            e.preventDefault();
            onWheel(Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
        }, { passive: false });
    }

    /**
     * Sizes the thumb. It fills the bar, dimmed, while everything is in view.
     *
     * @param {number} start - Where the view starts, as a fraction of the whole.
     * @param {number} size - How much of the whole is in view.
     */
    set(start, size) {
        this._active = size < 1;
        this._start = this._active ? start : 0;
        this._thumb.style.left = `${(100 * this._start).toFixed(3)}%`;
        this._thumb.style.width = `${(100 * (this._active ? size : 1)).toFixed(3)}%`;
        this.el.classList.toggle('pci-inactive', !this._active);
    }
}

/**
 * The charts of a capture, a column per frame or per group of frames, with the frame they show
 * picked by a cursor that every chart shares, the events of the frames in a row per kind below
 * them, and below that the timeline of the frame shown. A column of many frames shows the one
 * with the largest figure in that chart, so a spike never hides between pixels, and clicking the
 * column picks that frame. Hovering a column says what it shows.
 *
 * Click a frame to show it, drag to select frames together, scroll to zoom, scroll with Shift to
 * pan and double-click to see the whole capture again.
 *
 * @ignore
 */
class PerfCharts {
    /**
     * Called when the frame shown or the selected frames change.
     *
     * @type {() => void}
     */
    onChange = () => {};

    /**
     * The frame picked, or -1 to follow the newest.
     *
     * @type {number}
     */
    picked = -1;

    /**
     * The frames selected together, inclusive, or null.
     *
     * @type {{ from: number, to: number }|null}
     */
    range = null;

    /**
     * The charts and the sections under them that are collapsed to their titles: the keys of
     * {@link CHARTS}, 'resources' and 'events'.
     *
     * @type {Set<string>}
     */
    collapsed = new Set();

    /**
     * The lines of the Memory and Resources charts, and the rows of events, that are hidden: each
     * by its section and key, such as 'memory:vramTex' or 'events:resource'.
     *
     * @type {Set<string>}
     */
    hidden = new Set();

    /**
     * Called when a section is collapsed or expanded, or a line hidden or shown: what is kept
     * between sessions.
     *
     * @type {() => void}
     */
    onCollapse = () => {};

    /**
     * How many of the longest script types the Scripts chart gives a band of their own, besides
     * those pinned: a multiple of {@link SCRIPT_ROWS}, more with each Show more.
     *
     * @type {number}
     */
    scriptRows = SCRIPT_ROWS;

    /**
     * The names of the script types pinned, which the Scripts chart gives a band of their own
     * whatever their time.
     *
     * @type {Set<string>}
     */
    pinned = new Set();

    /**
     * Called with a script type clicked on the timeline, by its index into the names of the
     * capture, to show it on the Scripts tab.
     *
     * @type {(id: number) => void}
     */
    onSelectScript = () => {};

    /**
     * Called with a GPU pass or effect clicked on the timeline, to show it on the Frame graph tab.
     *
     * @type {(pass: PerfPassLink) => void}
     */
    onSelectPass = () => {};

    /**
     * Whether the CPU chart includes the inspector's own time. It runs inside the app's update and
     * can dwarf a light app, so leaving it out scales the chart to the app's own time.
     *
     * @type {boolean}
     */
    showInspector = true;

    /**
     * @type {PerfCapture}
     * @private
     */
    _capture;

    /**
     * The frames in view while zoomed in, null to view the whole capture. A view reaching the
     * newest frame follows it as frames are recorded.
     *
     * @type {{ from: number, span: number, follow: boolean }|null}
     * @private
     */
    _view = null;

    /** @private */
    _hover = -1;

    /**
     * The level under the pointer in a chart: a line across it there, labelled with its value, to
     * hold samples against. Null while the pointer is not over a chart.
     *
     * @type {{ y: number, value: number, format: (value: number) => string }|null}
     * @private
     */
    _level = null;

    /**
     * The bars of the frame timeline last drawn, and the one under the pointer.
     *
     * @type {PerfBar[]}
     * @private
     */
    _bars = [];

    /**
     * The rows of the frame timeline last drawn.
     *
     * @type {{ key: string, name: string, title: string, y: number, h: number }[]}
     * @private
     */
    _lanes = [];

    /**
     * The frame each column of each chart showed when last drawn, to pick it on a click.
     *
     * @type {Int32Array[]}
     * @private
     */
    _columns = [];


    /**
     * Arrays kept between redraws, by what they are for.
     *
     * @type {Map<string, Int32Array|Float64Array>}
     * @private
     */
    _scratch = new Map();

    /**
     * The ways each chart can be drawn, made once, see {@link _shape}.
     *
     * @type {Map<string, PerfShape>}
     * @private
     */
    _shapes = new Map();

    /**
     * The script types the Scripts chart last drew, telling when a new selection changes them.
     *
     * @private
     */
    _legendSignature = '';

    /**
     * The line charts, and the stacked chart of the scripts, as last drawn, by section, null while
     * collapsed or empty.
     *
     * @type {{ scripts: PerfLineChart|null, memory: PerfLineChart|null, resources: PerfLineChart|null }}
     * @private
     */
    _lineCharts = { scripts: null, memory: null, resources: null };

    /**
     * The first and one past the last frame of each column when last drawn.
     *
     * @type {{ lo: Int32Array, hi: Int32Array }}
     * @private
     */
    _spans = { lo: new Int32Array(0), hi: new Int32Array(0) };

    /**
     * The charts and rows of events when last drawn.
     *
     * @type {PerfRow[]}
     * @private
     */
    _rows = [];

    /**
     * What needs drawing on the next {@link update}: the charts, the frame timeline, and the
     * overlay marking the frame shown, the frame hovered and the frames selected together. The
     * overlay is a canvas of its own, so moving the pointer redraws only it.
     *
     * @private
     */
    _drawn = { version: -1, time: 0, charts: true, timeline: true, overlay: true };

    /**
     * Where the charts last drew their frames, which the overlay and the pointer go by, so they
     * match what is on screen between redraws while frames are being recorded.
     *
     * @private
     */
    _layout = { from: 0, span: MIN_SPAN, plot: 1, bottom: 0, barWidth: 1 };

    /**
     * The height the charts and their sections were last laid out in, which is taller than their
     * box when they do not fit it, so the box scrolls.
     *
     * @private
     */
    _contentHeight = 0;

    /**
     * The press on the charts being held: where it went down, the frame there, whether it drags
     * out a range, and the pointer it took.
     *
     * @type {{ x: number, seq: number, ranging: boolean, pointerId: number }|null}
     * @private
     */
    _press = null;

    /**
     * What each hover box shows, to rebuild its lines only when that changes.
     *
     * @type {WeakMap<HTMLElement, string>}
     * @private
     */
    _hoverSignatures = new WeakMap();

    /**
     * Redraws the charts and the timeline as soon as their boxes change size, before the browser
     * paints them stretched.
     *
     * @type {ResizeObserver|null}
     * @private
     */
    _resizeObserver = null;

    /**
     * The part of the frame the timeline shows while zoomed in, in milliseconds from its start, or
     * null for all of it.
     *
     * @type {{ from: number, span: number }|null}
     * @private
     */
    _timeView = null;

    /**
     * Where the timeline last drew: the part of the frame in view, the length of the frame and the
     * width it was drawn across.
     *
     * @private
     */
    _timeLayout = { from: 0, span: 1, length: 1, plot: 1 };

    /**
     * The height of the timeline, taller while it has a line of script types.
     *
     * @private
     */
    _timelineHeight = TIMELINE_HEIGHT;

    /**
     * The size of the charts and of the timeline, as the resize observer last reported them. A
     * draw goes by these rather than asking the page, which would lay out the whole panel there
     * and then after the property view changed it, inside the app's frame.
     *
     * @type {Map<Element, { width: number, height: number }>}
     * @private
     */
    _sizes = new Map();

    /**
     * The window the resize observer belongs to. The panel can move into a window of its own,
     * whose observer it then needs.
     *
     * @type {Window|null}
     * @private
     */
    _resizeView = null;

    /**
     * @param {HTMLElement} container - The element to fill.
     * @param {PerfCapture} capture - The capture to chart.
     */
    constructor(container, capture) {
        this._capture = capture;
        const doc = container.ownerDocument;

        this._chartsEl = doc.createElement('div');
        this._chartsEl.className = 'pci-perf-charts';
        this._canvas = doc.createElement('canvas');
        this._overlay = doc.createElement('canvas');
        this._overlay.className = 'pci-perf-overlay';
        this._chartsEl.append(this._canvas, this._overlay);
        // the hover box of the charts lives in the panel around them, so the scrolling of the
        // charts does not cut it off
        this._panelEl = container;
        this._panelEl.classList.add('pci-perf');
        this._hoverEl = doc.createElement('div');
        this._hoverEl.className = 'pci-perf-hover';

        this._timelineEl = doc.createElement('div');
        this._timelineEl.className = 'pci-perf-timeline';
        this._timelineEl.style.height = `${TIMELINE_HEIGHT}px`;
        this._timeline = doc.createElement('canvas');
        this._timelineHoverEl = doc.createElement('div');
        this._timelineHoverEl.className = 'pci-perf-hover';
        this._timelineEl.append(this._timeline, this._timelineHoverEl);

        // a scrollbar under the plot of the charts, for the frames in view while zoomed in, and one
        // under the timeline, for the part of the frame in view
        this._scrollbar = new PerfScrollbar(doc, {
            onDrag: start => this._scrollTo(this._capture.first + start * Math.max(1, this._capture.count)),
            onPage: direction => this._scrollTo(this._span().from + direction * this._span().span),
            onWheel: delta => this._scrollTo(this._span().from + (delta / this._layout.plot) * this._span().span)
        });
        this._timeScrollbar = new PerfScrollbar(doc, {
            onDrag: start => this._scrollTimeTo(start * this._timeLayout.length),
            onPage: direction => this._scrollTimeTo(this._timeLayout.from + direction * this._timeLayout.span),
            onWheel: delta => this._scrollTimeTo(this._timeLayout.from + (delta / this._timeLayout.plot) * this._timeLayout.span)
        });
        for (const bar of [this._scrollbar, this._timeScrollbar]) bar.el.style.marginLeft = `${8 + GUTTER}px`;

        container.append(this._chartsEl, this._scrollbar.el, this._timelineEl, this._timeScrollbar.el, this._hoverEl);

        const canvas = this._canvas;
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);
        canvas.addEventListener('pointercancel', this._onPointerUp);
        canvas.addEventListener('pointerleave', this._onPointerLeave);
        canvas.addEventListener('wheel', this._onWheel, { passive: false });
        canvas.addEventListener('dblclick', this._onDoubleClick);
        canvas.addEventListener('contextmenu', this._onContextMenu);
        this._timeline.addEventListener('pointermove', this._onTimelineMove);
        this._timeline.addEventListener('click', this._onTimelineClick);
        this._timeline.addEventListener('pointerleave', this._onTimelineLeave);
        this._timeline.addEventListener('wheel', this._onTimelineWheel, { passive: false });
        this._timeline.addEventListener('dblclick', this._onTimelineDoubleClick);
        this._observeSize();
    }

    /**
     * Stops watching the size of the charts.
     */
    destroy() {
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        this._resizeView = null;
    }

    /**
     * Watches the size of the charts and the timeline with an observer of the window they are in,
     * making a new one when they have moved to another window.
     *
     * @private
     */
    _observeSize() {
        const view = this._chartsEl.ownerDocument.defaultView;
        if (view === this._resizeView) return;
        this._resizeObserver?.disconnect();
        this._resizeView = view;
        const Observer = /** @type {any} */ (view)?.ResizeObserver;
        this._resizeObserver = Observer ? new Observer(this._onResize) : null;
        this._resizeObserver?.observe(this._chartsEl);
        this._resizeObserver?.observe(this._timelineEl);
    }

    /**
     * The charts or the timeline changed size, such as while the splitter above the property view
     * is dragged: draws them at their new size now, rather than leaving the browser to stretch the
     * last drawing until the next redraw.
     *
     * @private
     */
    _onResize = (entries) => {
        for (const entry of entries) this._sizes.set(entry.target, { width: entry.contentRect.width, height: entry.contentRect.height });
        this.draw();
        const drawn = this._drawn;
        drawn.charts = false;
        drawn.timeline = false;
        drawn.overlay = false;
    };

    /**
     * The element holding the charts, which scrolls when they do not fit it.
     *
     * @type {HTMLElement}
     */
    get chartsElement() {
        return this._chartsEl;
    }

    /**
     * The element holding the frame timeline, for a tooltip.
     *
     * @type {HTMLElement}
     */
    get timelineElement() {
        return this._timelineEl;
    }

    /**
     * The frame shown below the charts: the one picked, or the newest when none is.
     *
     * @type {number}
     */
    get shown() {
        const capture = this._capture;
        // a frame picked long ago has made way for newer ones: show the oldest kept instead
        if (this.picked >= 0) return Math.max(capture.first, Math.min(capture.end - 1, this.picked));
        return capture.end - 1;
    }

    /**
     * Whether the frame shown follows the newest one.
     *
     * @type {boolean}
     */
    get following() {
        return this.picked < 0;
    }

    /**
     * Shows a frame, which stops following the newest one.
     *
     * @param {number} seq - The frame, clamped to the frames kept.
     */
    pick(seq) {
        const capture = this._capture;
        if (capture.count === 0) return;
        this.picked = Math.max(capture.first, Math.min(capture.end - 1, seq));
        this._reveal(this.picked);
        this.invalidate();
        this.onChange();
    }

    /**
     * Follows the newest frame again.
     */
    follow() {
        this.picked = -1;
        if (this._view) this._view.follow = true;
        this.invalidate();
        this.onChange();
    }

    /**
     * Moves the frame shown.
     *
     * @param {number} delta - How many frames to move by, back when negative.
     */
    step(delta) {
        this.pick(this.shown + delta);
    }

    /**
     * Forgets the frames selected together, the zoom and the frame picked, as after a clear.
     */
    reset() {
        this.picked = -1;
        this.range = null;
        this._view = null;
        this._hover = -1;
        this.invalidate();
        this.onChange();
    }

    /**
     * Unselects the frames selected together.
     */
    clearRange() {
        if (!this.range) return;
        this.range = null;
        this._drawn.overlay = true;
        this._drawn.timeline = true;
        this._checkScriptLegend();
        this.onChange();
    }

    /**
     * Pins a script type to the Scripts chart, giving it a band of its own whatever its time, or
     * unpins it.
     *
     * @param {string} name - The name of the script type.
     */
    togglePin(name) {
        if (this.pinned.has(name)) this.pinned.delete(name);
        else this.pinned.add(name);
        this.invalidate();
        this.onCollapse();
        this.onChange();
    }

    /**
     * Asks for everything to be redrawn on the next {@link update}.
     */
    invalidate() {
        const drawn = this._drawn;
        drawn.charts = true;
        drawn.timeline = true;
        drawn.overlay = true;
    }

    /**
     * Redraws what changed: the charts and the frame timeline at most every
     * {@link REDRAW_INTERVAL} while frames are being recorded, and right away for a change of
     * view; the overlay alone as the pointer moves.
     *
     * @param {number} now - The current `performance.now()` time.
     * @returns {boolean} Whether it drew the charts or the timeline, the costly part, so other work
     * of the panel can wait for another frame.
     */
    update(now) {
        this._observeSize();
        const drawn = this._drawn;
        const recorded = drawn.version !== this._capture.version && now - drawn.time >= REDRAW_INTERVAL;
        let costly = false;
        if (recorded || drawn.charts) {
            drawn.version = this._capture.version;
            drawn.time = now;
            drawn.charts = false;
            this._drawCharts();
            costly = true;
            // the frames moved under the marks, and the newest frame shown may be a new one
            drawn.overlay = true;
            drawn.timeline ||= recorded;
        }
        // the timeline a frame after the charts, while frames are being recorded, so no one frame
        // draws both; a change of view draws it right away
        if (drawn.timeline && !(costly && recorded)) {
            drawn.timeline = false;
            this._drawTimeline();
            costly = true;
        }
        if (drawn.overlay) {
            drawn.overlay = false;
            this._drawOverlay();
        }
        return costly;
    }

    /**
     * Draws the charts, the frame timeline and the overlay now.
     */
    draw() {
        this._drawCharts();
        this._drawTimeline();
        this._drawOverlay();
    }

    /**
     * @param {HTMLCanvasElement} canvas - A canvas.
     * @param {HTMLElement} box - The element it fills.
     * @param {number} [height] - Its height, when it is taller than the element. Defaults to the
     * height of the element.
     * @returns {{ ctx: CanvasRenderingContext2D, width: number, height: number }|null} Its context,
     * scaled to CSS pixels, and its size in them, or null where it cannot be drawn.
     * @private
     */
    _prepare(canvas, box, height) {
        const size = this._sizeOf(box);
        const width = size.width;
        height ??= size.height;
        if (width <= GUTTER || height <= 0) return null;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
        const w = Math.round(width * ratio);
        const h = Math.round(height * ratio);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.font = FONT;
        ctx.textBaseline = 'top';
        return { ctx, width, height };
    }

    /**
     * @param {HTMLElement} box - The charts or the timeline.
     * @returns {{ width: number, height: number }} Its size, as the resize observer reported it, or
     * from the page where there is no observer.
     * @private
     */
    _sizeOf(box) {
        return this._sizes.get(box) ?? { width: box.clientWidth, height: box.clientHeight };
    }

    /**
     * @returns {{ from: number, span: number }} The frames in view: where they start and how many
     * fit across.
     * @private
     */
    _span() {
        const capture = this._capture;
        const view = this._view;
        if (view) {
            if (view.follow) view.from = capture.end - view.span;
            view.from = Math.max(capture.first, Math.min(capture.end - view.span, view.from));
            return view;
        }
        return { from: capture.first, span: Math.max(MIN_SPAN, capture.count) };
    }

    /**
     * @param {number} x - A position across the charts right of the names, in CSS pixels.
     * @returns {number} The frame drawn there, which may not be kept.
     * @private
     */
    _seqAt(x) {
        const { from, span, plot } = this._layout;
        return Math.floor(from + (x / plot) * span);
    }

    /**
     * @param {number} seq - A frame.
     * @returns {number} Where it was drawn across the canvas, in CSS pixels.
     * @private
     */
    _xOf(seq) {
        const { from, span, plot } = this._layout;
        return GUTTER + ((seq - from) / span) * plot;
    }

    /**
     * Scrolls a zoomed-in view to a frame, if it is out of view.
     *
     * @param {number} seq - The frame.
     * @private
     */
    _reveal(seq) {
        const view = this._view;
        if (!view) return;
        const { from, span } = this._span();
        if (seq < from || seq >= from + span) {
            view.from = seq - Math.floor(span / 2);
            view.follow = false;
        }
    }

    /**
     * @param {string} key - What the array is for.
     * @param {number} length - Its length.
     * @returns {Int32Array} An array kept for that, reused while its length stays the same, so a
     * redraw makes no garbage. Its content is left from the last use.
     * @private
     */
    _ints(key, length) {
        let array = this._scratch.get(key);
        if (!(array instanceof Int32Array) || array.length !== length) {
            array = new Int32Array(length);
            this._scratch.set(key, array);
        }
        return array;
    }

    /**
     * @param {string} key - What the array is for.
     * @param {number} length - Its length.
     * @returns {Float64Array} An array kept for that, as {@link _ints} keeps one.
     * @private
     */
    _floats(key, length) {
        let array = this._scratch.get(key);
        if (!(array instanceof Float64Array) || array.length !== length) {
            array = new Float64Array(length);
            this._scratch.set(key, array);
        }
        return array;
    }

    /**
     * @param {PerfChartDef} chart - A chart.
     * @returns {PerfShape} The
     * channel it is scaled to, the parts it stacks and the lines across them: without the
     * inspector's time in the CPU chart while that is left out, and the total alone where the
     * engine does not break it down. Reduced when the inspector's time is left out.
     * @private
     */
    _shape(chart) {
        const reduced = chart.key === 'cpu' && !this.showInspector;
        const plain = !!chart.plain && !this._capture.detailed;
        // made once for each way a chart can be drawn, as it is asked for on every redraw
        const key = `${chart.key}:${reduced ? 1 : 0}${plain ? 1 : 0}`;
        let shape = this._shapes.get(key);
        if (!shape) {
            const parts = reduced ? chart.parts.filter(part => part.key !== 'inspector') : plain ? chart.plain : chart.parts;
            const lines = reduced || plain ? NO_PARTS : chart.lines ?? NO_PARTS;
            // the rings the parts are read from, which stay the same for the life of the capture
            const d = this._capture.data;
            shape = {
                total: reduced ? 'cpuApp' : chart.total,
                parts,
                lines,
                partData: parts.map(part => d[part.channel]),
                lineData: lines.map(line => d[line.channel]),
                reduced
            };
            this._shapes.set(key, shape);
        }
        return shape;
    }

    /** @private */
    _drawCharts() {
        const scripts = this._scriptList();
        const scriptsOpen = !this.collapsed.has('scripts');
        const scriptsHeight = SECTION_TITLE + (scriptsOpen ? Math.max(SCRIPT_CHART_ROWS, scripts.lines.length + scripts.controls.length) * SCRIPT_ROW : 0);
        const resources = this._resourceList();
        const resourcesOpen = !this.collapsed.has('resources');
        const eventsOpen = !this.collapsed.has('events');
        const resourcesHeight = SECTION_TITLE + (resourcesOpen ? resources.length * RESOURCE_ROW : 0);
        const memoryOpen = !this.collapsed.has('memory');
        const memoryHeight = SECTION_TITLE + (memoryOpen ? MEMORY.length * MEMORY_ROW : 0);
        const eventsHeight = SECTION_TITLE + (eventsOpen ? EVENT_KINDS.length * EVENT_ROW : 0);
        // a collapsed chart keeps only its title, the open ones share the rest
        let openCharts = 0;
        for (let i = 0; i < CHARTS.length; i++) {
            if (!this.collapsed.has(CHARTS[i].key)) openCharts++;
        }
        const sections = scriptsHeight + memoryHeight + resourcesHeight + eventsHeight + (CHARTS.length - openCharts) * SECTION_TITLE + CHART_GAP * (CHARTS.length + 3);

        // taller than the box when the charts would get too short in it: the box scrolls then
        const contentHeight = Math.max(this._sizeOf(this._chartsEl).height, sections + openCharts * MIN_CHART_HEIGHT);
        if (contentHeight !== this._contentHeight) {
            this._contentHeight = contentHeight;
            this._canvas.style.height = `${contentHeight}px`;
            this._overlay.style.height = `${contentHeight}px`;
        }

        const prepared = this._prepare(this._canvas, this._chartsEl, contentHeight);
        if (!prepared) return;
        const { ctx, width, height } = prepared;
        const capture = this._capture;
        const d = capture.data;
        const { budget, median } = captureNorms(capture);
        const { from, span } = this._span();
        // whole columns, so a frame lands in the same column whether drawn or picked
        const plot = Math.max(1, Math.floor(width - GUTTER));
        const columns = plot;
        const perColumn = span / columns;
        const first = capture.first;
        const end = capture.end;
        const slots = capture.slots;
        const layout = this._layout;
        layout.from = from;
        layout.span = span;
        layout.plot = plot;

        // whole pixels throughout: the canvas boxes every fractional coordinate passed to it into an
        // object, which at thousands of bars a redraw is a steady stream of garbage
        const chartHeight = openCharts ? Math.floor((height - sections) / openCharts) : 0;
        this._rows = [];

        // the range of frames each column covers, shared by every chart
        const lo = this._ints('lo', columns);
        const hi = this._ints('hi', columns);
        for (let c = 0; c < columns; c++) {
            const a = Math.floor(from + c * perColumn);
            const b = Math.max(a + 1, Math.floor(from + (c + 1) * perColumn));
            lo[c] = Math.max(first, a);
            hi[c] = Math.min(end, b);
        }
        this._spans.lo = lo;
        this._spans.hi = hi;

        const shown = capture.count ? this.shown : -1;

        // where each bar goes across: a column each, showing the frame a chart picks for it, or
        // zoomed in until a frame spans several columns, a frame each, with a gap to the next once
        // there is room for one, so the frames read apart. Kept in arrays, so the many bars of a
        // redraw are drawn without making garbage
        const frameWidth = plot / span;
        const wide = frameWidth > 1;
        const barWidth = Math.max(1, frameWidth - (frameWidth >= 4 ? 1 : 0));
        layout.barWidth = barWidth;
        const visibleFrom = Math.max(first, Math.floor(from));
        const visibleTo = Math.min(end, Math.ceil(from + span));
        const bars = wide ? Math.max(0, visibleTo - visibleFrom) : columns;
        const barX = this._ints('barX', bars);
        const barW = this._ints('barW', bars);
        for (let i = 0; i < bars; i++) {
            if (wide) {
                // the frame cut by the left edge is drawn from the edge
                const x = this._xOf(visibleFrom + i);
                const left = Math.max(GUTTER, Math.round(x));
                barX[i] = left;
                barW[i] = Math.round(x + barWidth) - left;
            } else {
                barX[i] = GUTTER + i;
                barW[i] = 1;
            }
        }

        let chartsBottom = 0;
        for (let index = 0; index < CHARTS.length; index++) {
            const chart = CHARTS[index];
            const top = chartsBottom;
            const shape = this._shape(chart);
            const totals = d[shape.total];
            const pick = this._ints(`pick:${index}`, columns).fill(-1);
            this._columns[index] = pick;
            if (this.collapsed.has(chart.key)) {
                // its title alone, with the figure of the frame shown
                this._sectionTitle(ctx, chart.key, chart.title, top, false);
                if (capture.has(shown)) {
                    ctx.fillStyle = shape.parts.length === 1 ? shape.parts[0].color : '#b9c4c7';
                    ctx.fillText(chart.format(totals[capture.slot(shown)]), GUTTER + 4, top + 2);
                }
                chartsBottom += SECTION_TITLE + CHART_GAP;
                continue;
            }
            chartsBottom += chartHeight + CHART_GAP;
            this._rows.push({ top, height: chartHeight, chart: index });
            ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
            ctx.fillRect(GUTTER, top, plot, chartHeight);

            // the frame each column shows: its largest in this chart
            const peaks = this._floats('peaks', columns);
            const peakCount = PerfCharts._pickLargest(totals, slots, lo, hi, pick, peaks);
            const sorted = peaks.subarray(0, peakCount).sort();
            const max = peakCount ? sorted[peakCount - 1] : 0;
            const typical = peakCount ? sorted[Math.floor(0.95 * (peakCount - 1))] : 0;
            const unit = chart.unit ?? 1;
            // a duration is scaled to show the display interval too, its watermark, so the time a
            // frame has to spare reads off every timing chart alike
            const watermark = chart.timing && Number.isFinite(budget) ? budget * BUDGET_HEADROOM : 0;
            const scale = niceCeil(Math.max(Math.min(max, SPIKE_HEADROOM * typical), watermark) / unit) * unit;
            const bottom = top + chartHeight;
            const toY = v => Math.max(top, (bottom - (v / scale) * chartHeight + 0.5) | 0);
            this._rows[this._rows.length - 1].levels = { top, bottom, min: 0, max: scale, format: chart.format };

            // the parts stacked, with the spikes cut off by the scale marked along the top, and in
            // the frame chart the hitches
            const hitchAbove = chart.key === 'frame' && Number.isFinite(median) ? HITCH_FACTOR * median : Infinity;
            PerfCharts._drawStack(ctx, shape, totals, slots, wide ? null : pick, visibleFrom, bars, barX, barW, top, chartHeight, scale, hitchAbove,
                this._ints('stackBase', bars), this._floats('stackSum', bars));

            if (chart.timing && budget <= scale) {
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
                ctx.setLineDash(DASH);
                ctx.beginPath();
                const y = Math.round(toY(budget)) + 0.5;
                ctx.moveTo(GUTTER, y);
                ctx.lineTo(width, y);
                ctx.stroke();
                ctx.setLineDash(NO_DASH);
            }

            if (peakCount === 0 && chart.empty && capture.count) {
                PerfCharts._message(ctx, chart.empty, '#7f8f93', plot, top + chartHeight / 2 - 5);
            }

            // the name and the figure of the frame shown beside the chart, its scale in its corner
            ctx.font = BOLD;
            ctx.fillStyle = '#dbe2e4';
            ctx.fillText(`▾ ${chart.title}`, 4, top + 2);
            ctx.font = FONT;
            if (capture.has(shown)) {
                ctx.fillStyle = shape.parts.length === 1 ? shape.parts[0].color : '#b9c4c7';
                ctx.fillText(chart.format(totals[capture.slot(shown)]), 14, top + 14);
            }
            PerfCharts._label(ctx, chart.format(scale), width - 3, top + 2, 'right');
        }

        // the time of each script type, stacked beside the list of them
        const scriptsTop = chartsBottom;
        this._sectionTitle(ctx, 'scripts', 'Scripts', scriptsTop, scriptsOpen);
        this._lineCharts.scripts = scriptsOpen ?
            this._drawScriptChart(ctx, scripts, scriptsTop + SECTION_TITLE, width, plot, lo, hi, wide, visibleFrom, visibleTo, bars, barX, barW) : null;

        // memory and the resources: a chart each, of lines sharing a scale from the smallest to
        // the largest value of the lines shown, beside a list of them that hides or shows each, so
        // hiding the large ones lets the small ones fill the chart
        const memoryTop = scriptsTop + scriptsHeight + CHART_GAP;
        this._sectionTitle(ctx, 'memory', 'Memory', memoryTop, memoryOpen);
        this._lineCharts.memory = memoryOpen ?
            this._drawLineChart(ctx, 'memory', this._memoryList(), formatBytes, max => Math.max(MEMORY_MIN_SHARE * max, MEMORY_MIN_BYTES),
                memoryTop + SECTION_TITLE, MEMORY_ROW, width, plot, lo, hi, wide, visibleFrom, visibleTo, bars, barX, barW) : null;

        const resourcesTop = memoryTop + memoryHeight + CHART_GAP;
        this._sectionTitle(ctx, 'resources', 'Resources', resourcesTop, resourcesOpen);
        this._lineCharts.resources = resourcesOpen ?
            this._drawLineChart(ctx, 'resources', resources, formatCount, max => Math.max(MEMORY_MIN_SHARE * max, RESOURCE_MIN_COUNT),
                resourcesTop + SECTION_TITLE, RESOURCE_ROW, width, plot, lo, hi, wide, visibleFrom, visibleTo, bars, barX, barW) : null;

        // the events: a row per kind, each bar marked when its frame, or one of its column's, had
        // one
        const eventsTop = resourcesTop + resourcesHeight + CHART_GAP;
        this._sectionTitle(ctx, 'events', 'Events', eventsTop, eventsOpen);
        if (eventsOpen) {
            const masks = this._ints('masks', bars).fill(0);
            for (let i = 0; i < bars; i++) {
                if (wide) {
                    masks[i] = eventMask(capture, visibleFrom + i);
                } else {
                    for (let seq = lo[i]; seq < hi[i]; seq++) masks[i] |= eventMask(capture, seq);
                }
            }
            for (let k = 0; k < EVENT_KINDS.length; k++) {
                const kind = EVENT_KINDS[k];
                const top = eventsTop + SECTION_TITLE + k * EVENT_ROW;
                this._rows.push({ top, height: EVENT_ROW, kind: k });
                ctx.fillStyle = k % 2 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 0.04)';
                ctx.fillRect(GUTTER, top, plot, EVENT_ROW);
                const unsupported = !!eventUnsupported(capture, kind.key);
                const on = !unsupported && !this.hidden.has(`events:${kind.key}`);
                PerfCharts._checkbox(ctx, 10.5, top + 1.5, unsupported ? '#56656a' : kind.color, on);
                ctx.fillStyle = on ? '#b9c4c7' : '#56656a';
                ctx.fillText(kind.name, 23, top);
                if (!on) continue;
                ctx.fillStyle = kind.color;
                PerfCharts._drawMarks(ctx, masks, 1 << k, bars, barX, barW, top + 1, EVENT_ROW - 2);
            }
        }

        layout.bottom = eventsTop + eventsHeight;
        this._updateScrollbar();

        // nothing recorded yet: said in the first chart open, or beside the first title, where
        // nothing else is drawn while the capture is empty
        if (capture.count === 0) {
            const first = this._rows.find(row => row.chart !== undefined);
            const y = first ? first.top + first.height / 2 - 5 : 2;
            PerfCharts._message(ctx, capture.recording ? 'Recording…' : 'Press Record to capture frames', '#93a2a6', plot, y);
        }
    }

    /**
     * Sizes the thumb of the scrollbar to the frames in view, out of all those kept. It fills the
     * bar, dimmed, while the whole capture is in view.
     *
     * @private
     */
    _updateScrollbar() {
        const capture = this._capture;
        const { from, span } = this._span();
        const total = Math.max(1, capture.count);
        const zoomed = !!this._view && span < total;
        this._scrollbar.set(zoomed ? (from - capture.first) / total : 0, zoomed ? span / total : 1);
    }

    /**
     * Moves a zoomed-in view so it starts at a frame, following the newest frames when it reaches
     * them.
     *
     * @param {number} from - The first frame to view.
     * @private
     */
    _scrollTo(from) {
        const view = this._view;
        if (!view) return;
        const capture = this._capture;
        view.from = Math.max(capture.first, Math.min(capture.end - view.span, from));
        view.follow = view.from + view.span >= capture.end;
        this._updateScrollbar();
        this.invalidate();
    }

    // the loops over every column or frame of a redraw, apart in small functions the engine
    // compiles to tight code soon, rather than in the large one drawing everything, where its
    // numbers would be boxed into garbage until that is optimized

    /**
     * Picks the frame each column shows: the one with the largest value.
     *
     * @param {Float64Array} values - The ring of the channel.
     * @param {number} slots - The length of the ring.
     * @param {Int32Array} lo - The first frame of each column.
     * @param {Int32Array} hi - One past the last frame of each column.
     * @param {Int32Array} pick - Receives the frame of each column, left as it was for a column
     * without a value.
     * @param {Float64Array} peaks - Receives the values picked, packed.
     * @returns {number} How many columns had a value.
     * @private
     */
    static _pickLargest(values, slots, lo, hi, pick, peaks) {
        let count = 0;
        for (let c = 0; c < lo.length; c++) {
            let best = -1;
            let bestValue = -Infinity;
            for (let seq = lo[c]; seq < hi[c]; seq++) {
                const v = values[seq % slots];
                if (v > bestValue) {
                    bestValue = v;
                    best = seq;
                }
            }
            if (best >= 0 && bestValue > -Infinity && bestValue < Infinity) {
                pick[c] = best;
                peaks[count++] = bestValue;
            }
        }
        return count;
    }

    /**
     * Draws the parts of a chart stacked, a bar each, each part at least a pixel high so none of
     * them goes missing, with the lines across the stack, the spikes cut off by the scale marked
     * along the top and the hitches above them.
     *
     * @param {CanvasRenderingContext2D} ctx - The context.
     * @param {PerfShape} shape - What the chart draws.
     * @param {Float64Array} totals - The ring of its total.
     * @param {number} slots - The length of the rings.
     * @param {Int32Array|null} pick - The frame of each column, or null when each bar is a frame
     * of its own, from the first in view.
     * @param {number} visibleFrom - The first frame in view.
     * @param {number} bars - How many bars there are.
     * @param {Int32Array} barX - The left edge of each bar.
     * @param {Int32Array} barW - The width of each bar.
     * @param {number} top - The top of the chart, a whole pixel.
     * @param {number} height - Its height, a whole number of pixels.
     * @param {number} scale - The value at its top.
     * @param {number} hitchAbove - The total a hitch takes over, Infinity for none.
     * @param {Int32Array} base - Room for where the stack of each bar has got to.
     * @param {Float64Array} sums - Room for the sum of each bar so far.
     * @private
     */
    static _drawStack(ctx, shape, totals, slots, pick, visibleFrom, bars, barX, barW, top, height, scale, hitchAbove, base, sums) {
        const { parts, lines, partData, lineData } = shape;
        const bottom = top + height;
        // a part at a time across every bar, so its color is set once: setting it per bar parses
        // the color thousands of times a redraw. Each bar keeps where its stack has got to
        base.fill(bottom);
        sums.fill(0);
        for (let n = 0; n < parts.length; n++) {
            const data = partData[n];
            ctx.fillStyle = parts[n].color;
            for (let i = 0; i < bars; i++) {
                const seq = pick ? pick[i] : visibleFrom + i;
                const w = barW[i];
                const y0 = base[i];
                if (seq < 0 || w <= 0 || y0 <= top) continue;
                const v = data[seq % slots];
                if (!(v > 0)) continue;
                const sum = sums[i] + v;
                sums[i] = sum;
                const y1 = Math.min(y0 - 1, Math.max(top, (bottom - (sum / scale) * height + 0.5) | 0));
                ctx.fillRect(barX[i], y1, w, y0 - y1);
                base[i] = y1;
            }
        }
        for (let n = 0; n < lines.length; n++) {
            const data = lineData[n];
            ctx.fillStyle = lines[n].color;
            for (let i = 0; i < bars; i++) {
                const seq = pick ? pick[i] : visibleFrom + i;
                if (seq < 0 || barW[i] <= 0) continue;
                const v = data[seq % slots];
                if (v > 0 && v <= scale) ctx.fillRect(barX[i], ((bottom - (v / scale) * height + 0.5) | 0) - 1, barW[i], 2);
            }
        }
        // the spikes cut off by the scale, and above them the hitches
        for (const [above, color, h] of [[scale, '#ffffff', 2], [hitchAbove, '#ff3b30', 3]]) {
            if (above === Infinity) continue;
            ctx.fillStyle = color;
            for (let i = 0; i < bars; i++) {
                const seq = pick ? pick[i] : visibleFrom + i;
                if (seq >= 0 && barW[i] > 0 && totals[seq % slots] > above) ctx.fillRect(barX[i], top, barW[i], h);
            }
        }
    }

    /**
     * Draws a line through the values of the bars, scaled from the smallest to the largest. A
     * frame without a value breaks it.
     *
     * @param {CanvasRenderingContext2D} ctx - The context, with its stroke set.
     * @param {Float64Array} values - The ring of the channel.
     * @param {number} slots - The length of the ring.
     * @param {Int32Array|null} pick - The frame of each column, or null when each bar is a frame
     * of its own, from the first in view.
     * @param {number} visibleFrom - The first frame in view.
     * @param {number} bars - How many bars there are.
     * @param {Int32Array} barX - The left edge of each bar.
     * @param {Int32Array} barW - The width of each bar.
     * @param {number} bottom - Where the smallest value goes down the canvas.
     * @param {number} reach - How far up the largest goes from there.
     * @param {number} min - The smallest value.
     * @param {number} max - The largest.
     * @private
     */
    static _drawLine(ctx, values, slots, pick, visibleFrom, bars, barX, barW, bottom, reach, min, max) {
        const spread = max - min;
        ctx.beginPath();
        let drawing = false;
        for (let i = 0; i < bars; i++) {
            const seq = pick ? pick[i] : visibleFrom + i;
            const v = seq >= 0 ? values[seq % slots] : NaN;
            if (Number.isNaN(v) || barW[i] <= 0) {
                drawing = false;
                continue;
            }
            const x = barX[i] + (barW[i] >> 1);
            const y = (bottom - (spread > 0 ? (v - min) / spread : 0.5) * reach + 0.5) | 0;
            if (drawing) {
                ctx.lineTo(x, y);
            } else {
                ctx.moveTo(x, y);
                drawing = true;
            }
        }
        ctx.stroke();
    }

    /**
     * Marks the bars whose mask has a bit.
     *
     * @param {CanvasRenderingContext2D} ctx - The context, with its fill set.
     * @param {Int32Array} masks - The kinds of event of each bar.
     * @param {number} bit - The kind to mark.
     * @param {number} bars - How many bars there are.
     * @param {Int32Array} barX - The left edge of each bar.
     * @param {Int32Array} barW - The width of each bar.
     * @param {number} top - The top of the marks.
     * @param {number} height - Their height.
     * @private
     */
    static _drawMarks(ctx, masks, bit, bars, barX, barW, top, height) {
        for (let i = 0; i < bars; i++) {
            if ((masks[i] & bit) && barW[i] > 0) ctx.fillRect(barX[i], top, barW[i], height);
        }
    }

    /**
     * @returns {PerfScriptLegend} The script types the Scripts chart gives a band of their own,
     * ranked over the frames selected together, or the whole capture.
     * @private
     */
    _scriptLegend() {
        const capture = this._capture;
        const range = this.range;
        const from = range ? Math.max(capture.first, range.from) : capture.first;
        const to = range ? Math.min(capture.end - 1, range.to) : capture.end - 1;
        return scriptLegend(capture, from, to, this.scriptRows, this.pinned);
    }

    /**
     * The Scripts chart ranks its types over the frames selected together, so a new selection can
     * change its bands: redraws it when it does.
     *
     * @private
     */
    _checkScriptLegend() {
        if (!this.collapsed.has('scripts') && this._scriptLegend().signature !== this._legendSignature) this._drawn.charts = true;
    }

    /**
     * @returns {{ legend: PerfScriptLegend, lines: PerfScriptLine[], controls: ('more'|'fewer')[] }}
     * What the Scripts chart stacks: the script types with a band of their own and the others
     * together; and the rows of its list that show more types or fewer.
     * @private
     */
    _scriptList() {
        const legend = this._scriptLegend();
        /** @type {PerfScriptLine[]} */
        const lines = legend.types.map(type => ({ key: type.name, name: type.name, color: type.color, id: type.id, pinned: type.pinned }));
        if (legend.others) lines.push({ key: '#other', name: 'Other scripts', color: OTHER_SCRIPTS_COLOR, id: -1, pinned: false });
        /** @type {('more'|'fewer')[]} */
        const controls = [];
        if (legend.others) controls.push('more');
        if (this.scriptRows > SCRIPT_ROWS) controls.push('fewer');
        return { legend, lines, controls };
    }

    /**
     * @returns {string} Why the Scripts chart has nothing to draw.
     * @private
     */
    _scriptsEmpty() {
        const capture = this._capture;
        if (!capture.supports.scripts) return 'This app has no script system';
        if (!capture.timeScripts) return 'Turn Script timing on to time each script type while recording';
        return capture.count ? 'No script was timed in the frames kept' : 'Each script type is timed while recording';
    }

    /**
     * Draws the time of each script type stacked, beside the list of them, each with a box ticked
     * while it shows, so hiding the large ones lets the small ones fill the chart.
     *
     * @param {CanvasRenderingContext2D} ctx - The context.
     * @param {{ legend: PerfScriptLegend, lines: PerfScriptLine[], controls: ('more'|'fewer')[] }} list - What
     * it stacks, and the rows of its list that show more types or fewer.
     * @param {number} top - The top of the chart.
     * @param {number} width - The width of the canvas.
     * @param {number} plot - The width of the plot.
     * @param {Int32Array} lo - The first frame of each column.
     * @param {Int32Array} hi - One past the last frame of each column.
     * @param {boolean} wide - Whether each bar is a frame of its own.
     * @param {number} visibleFrom - The first frame in view.
     * @param {number} visibleTo - One past the last frame in view.
     * @param {number} bars - How many bars there are.
     * @param {Int32Array} barX - The left edge of each bar.
     * @param {Int32Array} barW - The width of each bar.
     * @returns {PerfLineChart|null} What it drew, for the pointer, or null for nothing.
     * @private
     */
    _drawScriptChart(ctx, { legend, lines: list, controls }, top, width, plot, lo, hi, wide, visibleFrom, visibleTo, bars, barX, barW) {
        const capture = this._capture;
        const d = capture.data;
        const slots = capture.slots;
        const rows = Math.max(SCRIPT_CHART_ROWS, list.length + controls.length);
        const height = rows * SCRIPT_ROW;
        this._legendSignature = legend.signature;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.fillRect(GUTTER, top, plot, height);
        if (!list.length) {
            PerfCharts._message(ctx, this._scriptsEmpty(), '#7f8f93', plot, top + height / 2 - 5);
            return null;
        }

        // the time of each type in each frame in view, in a ring of its own, the others' being what
        // the listed ones leave of all the scripts' time, and the sum of those shown
        const hidden = list.map(line => this.hidden.has(`scripts:${line.key}`));
        const rings = list.map((line, i) => this._floats(`scripts:${i}`, slots));
        const sums = this._floats('scripts:sum', slots);
        for (let seq = visibleFrom; seq < visibleTo; seq++) {
            const slot = seq % slots;
            const times = capture.scriptFigures(seq);
            let listed = 0;
            let shown = 0;
            for (let i = 0; i < list.length; i++) {
                const id = list[i].id;
                let v = NaN;
                if (times && id >= 0) {
                    const base = id * SCRIPT_STRIDE;
                    v = base < times.length ? times[base] + times[base + 1] + times[base + 2] : 0;
                    listed += v;
                } else if (times) {
                    v = Math.max(0, d.scriptsTotal[slot] - listed);
                }
                rings[i][slot] = v;
                if (!hidden[i] && v > 0) shown += v;
            }
            sums[slot] = times ? shown : NaN;
        }

        // the list: a box each, ticked while the type shows, a pin before the types pinned, then the
        // rows showing more types or fewer, and the others last; the rows below it still read the
        // chart
        const parts = [];
        const partData = [];
        const other = list.length && list[list.length - 1].id === -1 ? list.length - 1 : -1;
        /** @type {{ index: number, control?: 'more'|'fewer' }[]} */
        const order = [];
        for (let i = 0; i < list.length; i++) {
            if (i !== other) order.push({ index: i });
        }
        for (const control of controls) order.push({ index: -1, control });
        if (other >= 0) order.push({ index: other });
        for (let r = 0; r < rows; r++) {
            const y = top + r * SCRIPT_ROW;
            const entry = order[r];
            if (entry?.control) {
                this._rows.push({ top: y, height: SCRIPT_ROW, lines: 'scripts', index: -1, control: entry.control });
                ctx.fillStyle = '#93a2a6';
                ctx.fillText(entry.control === 'more' ? `▸ ${Math.min(SCRIPT_ROWS, legend.others)} more` : '▴ Fewer', 10, y + 1);
                continue;
            }
            const i = entry ? entry.index : -1;
            this._rows.push({ top: y, height: SCRIPT_ROW, lines: 'scripts', index: i });
            if (i < 0) continue;
            const line = list[i];
            PerfCharts._checkbox(ctx, 10.5, y + 2.5, line.color, !hidden[i]);
            ctx.fillStyle = hidden[i] ? '#56656a' : '#b9c4c7';
            ctx.fillText(PerfCharts._fit(ctx, `${line.pinned ? '📌' : ''}${line.name}`, '', GUTTER - 26), 23, y + 1);
        }
        // stacked from the first of the list up, so the longest is the steady base and the others
        // ride on top
        for (let i = 0; i < list.length; i++) {
            if (hidden[i]) continue;
            const line = list[i];
            parts.push({ key: line.key, name: line.name, color: line.color, channel: '' });
            partData.push(rings[i]);
        }

        // scaled to the largest frame of the columns, short of the spikes, as the CPU chart is
        const pick = this._ints('scripts:pick', lo.length).fill(-1);
        const peaks = this._floats('peaks', lo.length);
        const peakCount = PerfCharts._pickLargest(sums, slots, lo, hi, pick, peaks);
        const sorted = peaks.subarray(0, peakCount).sort();
        const max = peakCount ? sorted[peakCount - 1] : 0;
        const typical = peakCount ? sorted[Math.floor(0.95 * (peakCount - 1))] : 0;
        const scale = niceCeil(Math.min(max, SPIKE_HEADROOM * typical));
        /** @type {PerfShape} */
        const shape = { total: 'scriptsTotal', parts, lines: NO_PARTS, partData, lineData: [], reduced: false };
        PerfCharts._drawStack(ctx, shape, sums, slots, wide ? null : pick, visibleFrom, bars, barX, barW, top, height, scale, Infinity,
            this._ints('stackBase', bars), this._floats('stackSum', bars));
        PerfCharts._label(ctx, formatMs(scale), width - 3, top + 1, 'right');
        const levels = { top, bottom: top + height, min: 0, max: scale, format: formatMs };
        return { lines: list, format: formatMs, pick, min: 0, max: scale, levels, values: rings, stacked: true, legend };
    }

    /**
     * @returns {PerfLine[]} The lines of the Memory chart, the JavaScript heap where the browser
     * reports it.
     * @private
     */
    _memoryList() {
        const heap = this._capture.supports.heap;
        return MEMORY.map(line => (line.key === 'heap' && !heap ? { ...line, unsupported: 'Only Chromium browsers report the size of the JavaScript heap' } : line));
    }

    /**
     * Draws a chart of lines sharing a scale, beside the list of them, each with a box ticked
     * while its line shows. The scale runs from the smallest to the largest value of the lines
     * shown in view, spread to a least range so a level that barely changes is flat.
     *
     * @param {CanvasRenderingContext2D} ctx - The context.
     * @param {string} section - The section the chart is in, which the hidden lines are kept
     * under.
     * @param {PerfLine[]} lines - Its lines.
     * @param {(value: number) => string} format - Formats their values.
     * @param {(max: number) => number} least - The least range for a largest value.
     * @param {number} top - The top of the chart.
     * @param {number} rowHeight - The height of a line of the list; the chart is as tall as the
     * list.
     * @param {number} width - The width of the canvas.
     * @param {number} plot - The width of the plot.
     * @param {Int32Array} lo - The first frame of each column.
     * @param {Int32Array} hi - One past the last frame of each column.
     * @param {boolean} wide - Whether each bar is a frame of its own.
     * @param {number} visibleFrom - The first frame in view.
     * @param {number} visibleTo - One past the last frame in view.
     * @param {number} bars - How many bars there are.
     * @param {Int32Array} barX - The left edge of each bar.
     * @param {Int32Array} barW - The width of each bar.
     * @returns {PerfLineChart} What it drew, for the pointer.
     * @private
     */
    _drawLineChart(ctx, section, lines, format, least, top, rowHeight, width, plot, lo, hi, wide, visibleFrom, visibleTo, bars, barX, barW) {
        const capture = this._capture;
        const d = capture.data;
        const slots = capture.slots;
        const height = lines.length * rowHeight;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.fillRect(GUTTER, top, plot, height);

        // the list, a box each, ticked while the line shows
        const range = this._floats('lineRange', 2);
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const y = top + i * rowHeight;
            this._rows.push({ top: y, height: rowHeight, lines: section, index: i });
            const on = !line.unsupported && !this.hidden.has(`${section}:${line.key}`);
            PerfCharts._checkbox(ctx, 10.5, y + 2.5, line.unsupported ? '#56656a' : line.color, on);
            ctx.fillStyle = on ? '#b9c4c7' : '#56656a';
            ctx.fillText(line.name, 23, y + 1);
            if (!on) continue;
            PerfCharts._rangeOf(d[line.key], slots, visibleFrom, visibleTo, range);
            if (range[0] < min) min = range[0];
            if (range[1] > max) max = range[1];
        }

        // the last frame of each column, as these are levels rather than costs
        const pick = this._ints(`${section}:pick`, lo.length);
        for (let c = 0; c < lo.length; c++) pick[c] = hi[c] > lo[c] ? hi[c] - 1 : -1;
        /** @type {PerfLineChart} */
        const drawn = { lines, format, pick, min: 0, max: 0, levels: null };
        if (!(max >= min)) return drawn;

        const span = least(max);
        if (max - min < span) {
            const middle = (min + max) / 2;
            min = Math.max(0, middle - span / 2);
            max = min + span;
        }
        drawn.min = min;
        drawn.max = max;
        // the lines are drawn between two pixels in from the top and the bottom
        drawn.levels = { top: top + 2, bottom: top + height - 2, min, max, format };

        ctx.lineWidth = 1.5;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.unsupported || this.hidden.has(`${section}:${line.key}`)) continue;
            ctx.strokeStyle = line.color;
            PerfCharts._drawLine(ctx, d[line.key], slots, wide ? null : pick, visibleFrom, bars, barX, barW, top + height - 2, height - 4, min, max);
        }
        ctx.lineWidth = 1;
        PerfCharts._label(ctx, format(max), width - 3, top + 1, 'right');
        PerfCharts._label(ctx, format(min), width - 3, top + height - 12, 'right');
        return drawn;
    }

    /**
     * Draws the box beside a line or a row of events, ticked while it shows.
     *
     * @param {CanvasRenderingContext2D} ctx - The context.
     * @param {number} x - Its left edge, on a half pixel so its outline is sharp.
     * @param {number} y - Its top edge, likewise.
     * @param {string} color - The color of what it shows.
     * @param {boolean} on - Whether it is ticked.
     * @private
     */
    static _checkbox(ctx, x, y, color, on) {
        ctx.strokeStyle = color;
        ctx.strokeRect(x, y, 7, 7);
        if (on) {
            ctx.fillStyle = color;
            ctx.fillRect(x + 1.5, y + 1.5, 4, 4);
        }
    }

    /**
     * Finds the smallest and largest value of a span of frames.
     *
     * @param {Float64Array} values - The ring of the channel.
     * @param {number} slots - The length of the ring.
     * @param {number} from - The first frame.
     * @param {number} to - One past the last frame.
     * @param {Float64Array} range - Receives the smallest and the largest value, Infinity and
     * -Infinity when there are none.
     * @private
     */
    static _rangeOf(values, slots, from, to, range) {
        let min = Infinity;
        let max = -Infinity;
        for (let seq = from; seq < to; seq++) {
            const v = values[seq % slots];
            if (Number.isNaN(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        range[0] = min;
        range[1] = max;
    }

    /**
     * @returns {{ key: string, name: string, color: string }[]} The resources the device has.
     * @private
     */
    _resourceList() {
        return this._capture.supports.pipelines ? RESOURCES : RESOURCES.filter(resource => resource.key !== 'pipelines');
    }

    /**
     * Draws the title of a section under the charts, which collapses or expands it when clicked.
     *
     * @param {CanvasRenderingContext2D} ctx - The context.
     * @param {string} key - The section.
     * @param {string} title - Its title.
     * @param {number} top - Where it goes down the canvas.
     * @param {boolean} open - Whether the section is expanded.
     * @private
     */
    _sectionTitle(ctx, key, title, top, open) {
        this._rows.push({ top, height: SECTION_TITLE, section: key });
        ctx.font = BOLD;
        ctx.fillStyle = '#dbe2e4';
        ctx.fillText(`${open ? '▾' : '▸'} ${title}`, 4, top + 2);
        ctx.font = FONT;
    }

    /**
     * Draws the marks over the charts: the frames selected together, the frame hovered and the
     * frame shown, where the charts last drew them.
     *
     * @private
     */
    _drawOverlay() {
        const prepared = this._prepare(this._overlay, this._chartsEl, this._contentHeight || undefined);
        if (!prepared) return;
        const { ctx } = prepared;
        const capture = this._capture;
        const { bottom, barWidth } = this._layout;
        if (this.range) {
            const x0 = this._xOf(this.range.from);
            const x1 = this._xOf(this.range.to + 1);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.fillRect(x0, 0, Math.max(1, x1 - x0), bottom);
        }
        // a frame wide enough is covered whole and edged, a narrower one marked by a line through
        // its middle
        const mark = (seq, fill, edge) => {
            const x = this._xOf(seq);
            if (x < GUTTER) return;
            if (barWidth >= 3) {
                ctx.fillStyle = fill;
                ctx.fillRect(x, 0, barWidth, bottom);
                ctx.fillStyle = edge;
                ctx.fillRect(x, 0, 1, bottom);
                ctx.fillRect(x + barWidth - 1, 0, 1, bottom);
            } else {
                ctx.fillStyle = edge;
                ctx.fillRect(Math.round(x + barWidth / 2) - 1, 0, 2, bottom);
            }
        };
        const shown = capture.count ? this.shown : -1;
        if (this._hover >= 0 && capture.has(this._hover) && this._hover !== shown) {
            mark(this._hover, 'rgba(255, 255, 255, 0.1)', 'rgba(255, 255, 255, 0.4)');
        }
        if (shown >= 0) mark(shown, 'rgba(255, 255, 255, 0.22)', '#ffffff');

        // the level under the pointer, across the chart it is over, with its value at the left
        const level = this._level;
        if (level) {
            const { plot } = this._layout;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.fillRect(GUTTER, level.y, plot, 1);
            PerfCharts._label(ctx, level.format(level.value), GUTTER + 4, level.y - 13 < 0 ? level.y + 3 : level.y - 13, 'left');
        }
    }

    /**
     * Draws a label over a dark backing, to read over the bars.
     *
     * @param {CanvasRenderingContext2D} ctx - The context.
     * @param {string} text - The text.
     * @param {number} x - Where it is anchored across.
     * @param {number} y - Its top.
     * @param {'left'|'right'} align - Which side the anchor is on.
     * @private
     */
    static _label(ctx, text, x, y, align) {
        const w = ctx.measureText(text).width;
        const left = align === 'left' ? x : x - w;
        ctx.fillStyle = 'rgba(19, 25, 27, 0.75)';
        ctx.fillRect(left - 2, y - 1, w + 4, 12);
        ctx.fillStyle = '#dbe2e4';
        ctx.fillText(text, left, y);
    }

    /**
     * Draws a line of text centered across the plot, cut short with an ellipsis where the plot is
     * too narrow for it.
     *
     * @param {CanvasRenderingContext2D} ctx - The context.
     * @param {string} text - The text.
     * @param {string} color - Its color.
     * @param {number} plot - The width of the plot.
     * @param {number} y - Its top.
     * @private
     */
    static _message(ctx, text, color, plot, y) {
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.fillText(PerfCharts._fit(ctx, text, '', plot - 8), GUTTER + plot / 2, y);
        ctx.textAlign = 'left';
    }

    /**
     * As much of a label as fits: the name and its time, the name alone, or the start of the name
     * cut short with an ellipsis.
     *
     * @param {CanvasRenderingContext2D} ctx - The context, with the font set.
     * @param {string} name - The name.
     * @param {string} time - Its time, empty for none.
     * @param {number} room - The width there is.
     * @returns {string} What fits, empty when not even a letter does.
     * @private
     */
    static _fit(ctx, name, time, room) {
        if (time) {
            const text = `${name} ${time}`;
            if (ctx.measureText(text).width <= room) return text;
        }
        if (ctx.measureText(name).width <= room) return name;
        // the most letters that fit with the ellipsis after them
        let lo = 0;
        let hi = name.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (ctx.measureText(`${name.slice(0, mid)}…`).width <= room) lo = mid;
            else hi = mid - 1;
        }
        return lo ? `${name.slice(0, lo).trimEnd()}…` : '';
    }

    /**
     * What the timeline shows: the frame shown, or with frames selected together their average
     * frame, each phase at its average start for its average time per frame, and each GPU pass for
     * its average time.
     *
     * @returns {{ title: string, interval: number, frames: number, bars: PerfTimeBar[] }|null} The
     * title, the frame interval, how many frames it covers and the bars, in milliseconds from the
     * start of the frame. Null when there is nothing to show.
     * @private
     */
    _timelineModel() {
        const capture = this._capture;
        if (!capture.count) return null;
        const d = capture.data;
        const range = this.range;
        const from = range ? Math.max(capture.first, range.from) : this.shown;
        const to = range ? Math.min(capture.end - 1, range.to) : this.shown;
        if (to < from) return null;
        const frames = to - from + 1;

        // the mean of a figure over the frames, and of the start of a phase over the frames that
        // timed it
        const mean = (key) => {
            let sum = 0;
            for (let seq = from; seq <= to; seq++) {
                const v = d[key][capture.slot(seq)];
                if (Number.isFinite(v)) sum += v;
            }
            return sum / frames;
        };
        const start = (key) => {
            let sum = 0;
            let n = 0;
            for (let seq = from; seq <= to; seq++) {
                const slot = capture.slot(seq);
                const v = d[key][slot] - d.tick[slot];
                if (Number.isFinite(v)) {
                    sum += v;
                    n++;
                }
            }
            return n ? sum / n : NaN;
        };

        /** @type {PerfTimeBar[]} */
        const bars = [];
        const phase = (lane, startKey, key, color, name) => {
            bars.push({ lane, start: start(startKey), duration: mean(key), color, name, positioned: true });
        };
        // the mean span between two timestamps of a frame, over the frames that have both
        const between = (fromKey, toKey) => {
            let sum = 0;
            let n = 0;
            for (let seq = from; seq <= to; seq++) {
                const slot = capture.slot(seq);
                const v = d[toKey][slot] - d[fromKey][slot];
                if (Number.isFinite(v)) {
                    sum += v;
                    n++;
                }
            }
            return n ? sum / n : NaN;
        };
        const color = key => CPU_PARTS.find(p => p.key === key).color;

        // the frame in the order scripts see it: the update, the post-update, the update event,
        // where the inspector does its work, and the render. The update runs until the post-update
        // starts: the update of the systems, which steps the physics, and the animation
        bars.push({ lane: 'cpu', start: start('updateStart'), duration: between('updateStart', 'postStart'), color: UPDATE_COLOR, name: 'Update', positioned: true });
        phase('cpu', 'postStart', 'post', color('post'), 'Post-update');
        phase('cpu', 'inspectorStart', 'inspector', color('inspector'), 'Inspector');
        phase('cpu', 'renderStart', 'render', color('render'), 'Render');
        // the line below breaks the update and the render down, as a flame chart does, leaving
        // what is not timed apart as a gap: the physics step and the animation where they ran,
        // the rest of the update being the scripts and the other components; and the phases of
        // the render the profiler and debug engines time, back to back from its start, as they do
        // not say when each ran
        phase('detail', 'physicsStart', 'physics', color('physics'), 'Physics');
        phase('detail', 'animStart', 'anim', color('anim'), 'Animation');
        // the scripts while they were timed: their own time in the update and the post-update,
        // each from the start of its first call, the mean over the frames that timed them
        if (Number.isFinite(start('scriptsUpdateStart')) || Number.isFinite(start('scriptsPostStart'))) {
            const timedMean = (key) => {
                let sum = 0;
                let n = 0;
                for (let seq = from; seq <= to; seq++) {
                    const v = d[key][capture.slot(seq)];
                    if (Number.isFinite(v)) {
                        sum += v;
                        n++;
                    }
                }
                return n ? sum / n : NaN;
            };
            const scriptsColor = color('scripts');
            const updateTypes = this._scriptTypes(from, to, 0);
            const postTypes = this._scriptTypes(from, to, 1);
            bars.push({ lane: 'detail', start: start('scriptsUpdateStart'), duration: timedMean('scriptsUpdate'), color: scriptsColor, name: 'Scripts', positioned: true, children: updateTypes });
            bars.push({ lane: 'detail', start: start('scriptsPostStart'), duration: timedMean('scriptsPost'), color: scriptsColor, name: 'Post-update scripts', positioned: true, children: postTypes });
            // the line below them breaks each down by script type. The calls of the types
            // interleave, entity by entity, so each is its time in all, back to back from the start
            // of the scripts in the order the types first ran; what is left at the end is the
            // initializing of scripts created along the way
            for (const [types, startKey, method] of [[updateTypes, 'scriptsUpdateStart', ''], [postTypes, 'scriptsPostStart', ', post-update']]) {
                let at = start(startKey);
                for (const type of [...types].sort((a, b) => a.order - b.order)) {
                    bars.push({ lane: 'types', start: at, duration: type.duration, color: type.color, name: type.name, positioned: false, calls: type.calls, label: `${type.name}${method}`, script: type.id });
                    at += type.duration;
                }
            }
        }
        if (capture.detailed) {
            let at = start('renderStart');
            for (const [key, name, phaseColor] of RENDER_TIMELINE) {
                const time = mean(key);
                bars.push({ lane: 'detail', start: at, duration: time, color: phaseColor, name, positioned: false });
                at += time;
            }
        }

        this._gpuBars(from, to, bars);

        // the events of a single frame; an average frame has none of its own
        if (!range) {
            const tick = d.tick[capture.slot(from)];
            for (const event of capture.events(from)) {
                const kind = EVENT_KINDS.find(k => k.key === (event.kind === 'long' ? 'long' : event.kind === 'asset' ? 'asset' : 'marker'));
                const at = Math.max(0, event.start - tick);
                bars.push({ lane: 'events', start: at, duration: event.duration - (at - (event.start - tick)), color: kind.color, name: event.name, positioned: true, instant: event.duration <= 0 });
            }
        }

        const title = range ? `Frames ${from + 1}–${to + 1}, average` : `Frame ${from + 1}`;
        return { title, interval: mean('interval'), frames, bars };
    }

    /**
     * Adds the GPU passes of the frames to the bars of the timeline. The GPU does not say when each
     * pass ran, only for how long, so they are back to back, each apart, its mean over the frames
     * that timed the GPU, in the order the passes first ran. The passes an effect runs go on a line
     * of their own under a bar of the effect, as in a flame chart; a pass of its own, or every pass
     * where the frame graph did not match, goes on the GPU line.
     *
     * @param {number} from - The first frame.
     * @param {number} to - The last frame, inclusive.
     * @param {PerfTimeBar[]} bars - Receives the bars.
     * @private
     */
    _gpuBars(from, to, bars) {
        const capture = this._capture;
        // each pass by its name and which of the passes with that name it is in its frame
        /** @type {Map<string, { name: string, time: number, owner: string|null, occurrence: number, ownerOccurrence: number }[]>} */
        const byName = new Map();
        const order = [];
        let timed = 0;
        for (let seq = from; seq <= to; seq++) {
            const list = capture.passesInOrder(seq);
            if (!list.length) continue;
            timed++;
            const seen = new Map();
            for (const pass of list) {
                const k = seen.get(pass.name) ?? 0;
                seen.set(pass.name, k + 1);
                let same = byName.get(pass.name);
                if (!same) byName.set(pass.name, same = []);
                let entry = same[k];
                if (!entry) {
                    entry = { name: pass.name, time: 0, owner: null, occurrence: -1, ownerOccurrence: -1 };
                    same[k] = entry;
                    order.push(entry);
                }
                entry.time += pass.time;
                // as the newest frame has it
                entry.owner = pass.owner;
                entry.occurrence = pass.occurrence;
                entry.ownerOccurrence = pass.ownerOccurrence;
            }
        }
        if (!timed) return;

        // a color for each name, of pass or effect, in the order they come
        const colors = new Map();
        const colorOf = (name) => {
            let color = colors.get(name);
            if (!color) colors.set(name, color = PASS_COLORS[colors.size % PASS_COLORS.length]);
            return color;
        };
        const link = (name, occurrence) => (occurrence >= 0 ? { name, occurrence } : undefined);
        const label = entry => (byName.get(entry.name).length > 1 ? `${entry.name} ${byName.get(entry.name).indexOf(entry) + 1}/${byName.get(entry.name).length}` : entry.name);
        let t = 0;
        for (let i = 0; i < order.length;) {
            const entry = order[i];
            if (!entry.owner) {
                const time = entry.time / timed;
                bars.push({ lane: 'gpu', start: t, duration: time, color: colorOf(entry.name), name: entry.name, label: label(entry), positioned: false, pass: link(entry.name, entry.occurrence) });
                t += time;
                i++;
                continue;
            }
            // the passes the effect runs in a row, under a bar of it
            const { owner, ownerOccurrence } = entry;
            const start = t;
            const children = [];
            for (; i < order.length && order[i].owner === owner && order[i].ownerOccurrence === ownerOccurrence; i++) {
                const pass = order[i];
                const time = pass.time / timed;
                const color = colorOf(pass.name);
                bars.push({ lane: 'gpuPasses', start: t, duration: time, color, name: pass.name, label: label(pass), positioned: false, pass: link(pass.name, pass.occurrence) });
                children.push({ name: label(pass), duration: time, color });
                t += time;
            }
            bars.push({ lane: 'gpu', start, duration: t - start, color: colorOf(owner), name: effectName(owner), positioned: false, pass: link(owner, ownerOccurrence), children });
        }

        // passes of one name in a row share a label: the first of them says how many there are
        for (let i = 0; i < bars.length; i++) {
            const bar = bars[i];
            if (bar.lane !== 'gpu' && bar.lane !== 'gpuPasses') continue;
            if (bar.run === 0) continue;
            let n = 1;
            let duration = bar.duration;
            for (let j = i + 1; j < bars.length && bars[j].lane === bar.lane && bars[j].name === bar.name && !bars[j].children && !bar.children; j++) {
                bars[j].run = 0;
                duration += bars[j].duration;
                n++;
            }
            if (n > 1) {
                bar.run = n;
                bar.runDuration = duration;
            }
        }
    }

    /**
     * @param {number} from - The first frame.
     * @param {number} to - The last frame, inclusive.
     * @param {number} column - Which method of the script types: 0 their update, 1 their
     * post-update.
     * @returns {PerfScriptType[]} Each script type with that method, with its time and its calls,
     * the mean over the frames that timed scripts, and where its first call came, the mean over
     * the frames it ran in.
     * @private
     */
    _scriptTypes(from, to, column) {
        const capture = this._capture;
        const names = capture.scriptNames;
        // summed by type in arrays, as an app can have hundreds of them over many frames
        const times = new Float64Array(names.length);
        const calls = new Float64Array(names.length);
        const orders = new Float64Array(names.length);
        const ran = new Float64Array(names.length);
        let timed = 0;
        for (let seq = from; seq <= to; seq++) {
            const figures = capture.scriptFigures(seq);
            if (!figures) continue;
            timed++;
            for (let base = 0, id = 0; base < figures.length; base += SCRIPT_STRIDE, id++) {
                const n = figures[base + SCRIPT_CALLS + column];
                if (!n) continue;
                times[id] += figures[base + column];
                calls[id] += n;
                orders[id] += figures[base + SCRIPT_ORDER + column];
                ran[id]++;
            }
        }
        const colors = this._scriptLegend().colors;
        /** @type {PerfScriptType[]} */
        const types = [];
        for (let id = 0; id < names.length; id++) {
            if (ran[id]) types.push({ id, name: names[id], duration: times[id] / timed, calls: calls[id] / timed, order: orders[id] / ran[id], color: colors.get(id) ?? OTHER_SCRIPTS_COLOR });
        }
        return types;
    }

    /**
     * What the timeline shows, to copy: its title, how many frames it covers, the frame interval
     * and its bars by row. A GPU pass has no start, as the GPU does not say when it ran.
     *
     * @returns {object|null} The timeline, or null when there is nothing to show.
     */
    timelineJson() {
        const model = this._timelineModel();
        if (!model) return null;
        const rows = { cpu: 'CPU', detail: 'Update and render', types: 'Script types', gpu: 'GPU', gpuPasses: 'Passes of the effects', events: 'Events' };
        const bars = model.bars.filter(bar => bar.duration > 0 || bar.instant).map(bar => ({
            row: rows[bar.lane],
            name: bar.name,
            start: bar.positioned && Number.isFinite(bar.start) ? bar.start : null,
            duration: bar.instant ? 0 : bar.duration,
            ...(bar.calls !== undefined ? { calls: bar.calls } : {}),
            ...(bar.children ? { parts: bar.children.map(child => ({ name: child.name, duration: child.duration, ...(child.calls !== undefined ? { calls: child.calls } : {}) })) } : {})
        }));
        return { title: model.title, frames: model.frames, interval: model.interval, bars };
    }

    /**
     * What a right click copies, by where it is: the name of a chart, the title of a section or a
     * line of a list copies that series; the plot copies the frame under the pointer, or the
     * frames selected together when it is among them; the timeline copies what it shows.
     *
     * @param {Node} target - What was right-clicked.
     * @param {MouseEvent} e - The click, for where it was.
     * @returns {{ kind: 'series'|'frame'|'range'|'timeline', key?: string, seq?: number }|null} What
     * to copy, or null for nothing.
     */
    copyAt(target, e) {
        const capture = this._capture;
        if (!capture.count) return null;
        if (this._timelineEl.contains(target)) return { kind: 'timeline' };
        if (target !== this._canvas && target !== this._overlay) return null;
        const { x, row } = this._locate(e);
        if (!row) return null;
        const series = row.section ?? (row.chart !== undefined ? CHARTS[row.chart].key : row.lines ?? (row.kind !== undefined ? 'events' : null));
        if (row.section || x < 0) return series ? { kind: 'series', key: series } : null;
        const seq = this._pickAt(e);
        if (this.range && seq >= this.range.from && seq <= this.range.to) return { kind: 'range' };
        return capture.has(seq) ? { kind: 'frame', seq } : null;
    }

    /**
     * The frames a copy covers: those selected together, or every frame kept.
     *
     * @type {{ from: number, to: number }}
     */
    get copyRange() {
        const capture = this._capture;
        const range = this.range;
        return range ? { from: Math.max(capture.first, range.from), to: Math.min(capture.end - 1, range.to) } : { from: capture.first, to: capture.end - 1 };
    }

    /**
     * Moves a zoomed-in timeline so it starts at a time of the frame.
     *
     * @param {number} from - The first millisecond of the frame to view.
     * @private
     */
    _scrollTimeTo(from) {
        const view = this._timeView;
        if (!view) return;
        view.from = Math.max(0, Math.min(this._timeLayout.length - view.span, from));
        this._drawn.timeline = true;
    }

    /**
     * Draws the frame shown, or the average frame of the frames selected together, along its own
     * time: the update and the render with their parts where the engine timed them, the GPU passes
     * back to back, and what happened meanwhile, each on a row named beside it. Zoomed in, only
     * part of the frame is drawn, across the whole width.
     *
     * @private
     */
    _drawTimeline() {
        const model = this._timelineModel();
        // a line more for the script types, while the frames shown timed them
        const typed = !!model?.bars.some(bar => bar.lane === 'types');
        // and for the passes of the GPU effects, where the frame graph says which effect runs them
        const owned = !!model?.bars.some(bar => bar.lane === 'gpuPasses');
        const timelineHeight = TIMELINE_HEIGHT + (typed ? SCRIPT_TYPES_LINE : 0) + (owned ? GPU_PASSES_LINE : 0);
        if (timelineHeight !== this._timelineHeight) {
            this._timelineHeight = timelineHeight;
            this._timelineEl.style.height = `${timelineHeight}px`;
        }
        const prepared = this._prepare(this._timeline, this._timelineEl, timelineHeight);
        this._bars = [];
        if (!prepared) return;
        const { ctx, width, height } = prepared;
        if (!model) {
            this._timeScrollbar.set(0, 1);
            return;
        }

        const { budget } = captureNorms(this._capture);
        const { interval, bars: frameBars } = model;
        let gpuTotal = 0;
        for (const bar of frameBars) {
            if (bar.lane === 'gpu') gpuTotal += bar.duration;
        }
        const length = Math.max(interval, Number.isFinite(budget) ? budget : 0, gpuTotal);
        const plot = width - GUTTER;

        // the part of the frame in view
        const view = this._timeView;
        if (view) {
            view.span = Math.min(view.span, length);
            view.from = Math.max(0, Math.min(length - view.span, view.from));
        }
        const from = view ? view.from : 0;
        const span = view ? view.span : length;
        const layout = this._timeLayout;
        layout.from = from;
        layout.span = span;
        layout.length = length;
        layout.plot = plot;
        this._timeScrollbar.set(from / length, span / length);
        const toX = t => GUTTER + ((t - from) / span) * plot;

        // the CPU, and below it, unnamed as in a flame chart, what its update and its render are
        // made of, and the script types; then the GPU, and below it the passes of its effects
        const lanes = [
            { key: 'cpu', name: 'CPU', title: 'CPU', y: 16, h: 12 },
            { key: 'detail', name: '', title: 'Update and render', y: 29, h: 10 }
        ];
        let y = 39;
        if (typed) {
            lanes.push({ key: 'types', name: '', title: 'Script types', y: y + 3, h: 10 });
            y += SCRIPT_TYPES_LINE;
        }
        lanes.push({ key: 'gpu', name: 'GPU', title: 'GPU passes', y: y + 4, h: 10 });
        y += 14;
        if (owned) {
            lanes.push({ key: 'gpuPasses', name: '', title: 'Passes of the effects', y: y + 1, h: 10 });
            y += GPU_PASSES_LINE;
        }
        lanes.push({ key: 'events', name: 'Events', title: 'Events', y: y + 4, h: 8 });
        const lane = Object.fromEntries(lanes.map(l => [l.key, l]));
        this._lanes = lanes;
        for (const { name, y, h } of lanes) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
            ctx.fillRect(GUTTER, y, plot, h);
            ctx.fillStyle = '#b9c4c7';
            ctx.fillText(name, 6, y + (h - 10) / 2);
        }

        // the bars, cut to the plot while zoomed in; an instant, or a span too short to see, is
        // drawn a pixel wide
        ctx.save();
        ctx.beginPath();
        ctx.rect(GUTTER, 0, plot, height);
        ctx.clip();
        // the labels once every bar is drawn, as the label of a run spans the bars after its first
        const labels = [];
        for (const bar of frameBars) {
            if (!(bar.duration > 0 || bar.instant) || !Number.isFinite(bar.start)) continue;
            const row = lane[bar.lane];
            const x0 = toX(bar.start);
            const x1 = Math.max(x0 + 1, toX(bar.start + Math.max(0, bar.duration)));
            if (x1 < GUTTER || x0 > width) continue;
            ctx.fillStyle = bar.color;
            // the passes of a run are told apart by a gap, where there is room for one
            const inRun = bar.run !== undefined;
            ctx.fillRect(x0, row.y, x1 - x0 - (inRun && x1 - x0 >= 3 ? 1 : 0), row.h);
            if (bar.run !== 0) {
                // a run is labelled once, across it, with how many passes it has
                const runEnd = bar.run > 1 ? Math.max(x1, toX(bar.start + bar.runDuration)) : x1;
                const left = Math.max(GUTTER, x0);
                const name = bar.run > 1 ? `${bar.name} ×${bar.run}` : bar.name;
                const text = PerfCharts._fit(ctx, name, bar.instant ? '' : formatMs(bar.run > 1 ? bar.runDuration : bar.duration), Math.min(width, runEnd) - left - 6);
                if (text) labels.push(text, left + 3, row.y + (row.h - 10) / 2);
            }
            this._bars.push({ x0, x1, lane: bar.lane, name: bar.name, color: bar.color, duration: bar.instant ? 0 : bar.duration, start: bar.positioned ? bar.start : NaN, calls: bar.calls, label: bar.label, script: bar.script, pass: bar.pass, children: bar.children });
        }
        ctx.fillStyle = '#0b0f10';
        for (let i = 0; i < labels.length; i += 3) ctx.fillText(labels[i], labels[i + 1], labels[i + 2]);

        // the end of the frame, and the display interval
        const lineTop = lane.cpu.y - 2;
        const lineHeight = lane.events.y + lane.events.h + 2 - lineTop;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.fillRect(Math.min(width - 1, toX(interval)), lineTop, 1, lineHeight);
        if (Number.isFinite(budget)) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.fillRect(toX(budget), lineTop, 1, lineHeight);
        }
        ctx.restore();

        // a scale of milliseconds along the bottom, over the part in view
        const step = niceCeil(span / 8);
        ctx.fillStyle = '#7f8f93';
        let labelled = false;
        for (let i = Math.ceil(from / step); i * step <= from + span; i++) {
            // rounded, as adding up fractional steps drifts off the decimals
            const ms = +(i * step).toFixed(4);
            const x = toX(ms);
            ctx.fillRect(x, height - 16, 1, 3);
            if (x < width - 30) {
                ctx.fillText(`${ms}${labelled ? '' : ' ms'}`, x + 1, height - 12);
                labelled = true;
            }
        }

        ctx.font = BOLD;
        ctx.fillStyle = '#dbe2e4';
        ctx.fillText(model.title, 6, 2);
        const titleWidth = ctx.measureText(model.title).width;
        ctx.font = FONT;
        PerfCharts._label(ctx, formatMs(interval), Math.max(GUTTER, 14 + titleWidth), 2, 'left');
    }

    /**
     * Zooms the timeline around the pointer, or pans it with Shift or a sideways scroll.
     *
     * @param {WheelEvent} e - The event.
     * @private
     */
    _onTimelineWheel = (e) => {
        const layout = this._timeLayout;
        const x = e.clientX - this._timeline.getBoundingClientRect().left - GUTTER;
        if (x < 0) return;
        e.preventDefault();
        const { from, span, length, plot } = layout;
        const pan = e.shiftKey ? e.deltaY : e.deltaX;
        if (Math.abs(pan) > Math.abs(e.shiftKey ? 0 : e.deltaY)) {
            if (this._timeView) this._scrollTimeTo(from + (pan / plot) * span);
        } else {
            const anchor = from + (x / plot) * span;
            const next = Math.max(MIN_TIME_SPAN, span * Math.exp(e.deltaY * 0.002));
            this._timeView = next >= length ? null : { from: anchor - (x / plot) * next, span: next };
        }
        this._renderHover(this._timelineHoverEl, this._timelineEl, [], null, true);
        this._drawn.timeline = true;
    };

    /** @private */
    _onTimelineDoubleClick = () => {
        this._timeView = null;
        this._drawn.timeline = true;
    };

    /**
     * @param {PointerEvent|MouseEvent} e - A pointer event on the charts.
     * @returns {{ x: number, y: number, row: PerfRow|null, column: number }} Where it is: across
     * the charts right of the names, down the canvas, the chart or row of events, and the column.
     * @private
     */
    _locate(e) {
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left - GUTTER;
        const y = e.clientY - rect.top;
        const row = this._rows.find(r => y >= r.top && y < r.top + r.height) ?? null;
        return { x, y, row, column: Math.floor(x) };
    }

    /**
     * @param {PointerEvent|MouseEvent} e - A pointer event on the charts.
     * @returns {number} The frame under it: the one its column shows in the chart it is over, or
     * the first of its frames with an event of the kind of the row it is over.
     * @private
     */
    _pickAt(e) {
        const { x, row, column } = this._locate(e);
        if (row?.chart !== undefined) {
            const picked = this._columns[row.chart]?.[column] ?? -1;
            if (picked >= 0) return picked;
        } else if (row?.lines) {
            const picked = this._lineCharts[row.lines]?.pick[column] ?? -1;
            if (picked >= 0) return picked;
        } else if (row?.kind !== undefined) {
            const seq = this._eventFrames(column, row.kind)[0];
            if (seq !== undefined) return seq;
        }
        return this._seqAt(x);
    }

    /**
     * @param {number} column - A column.
     * @param {number} kind - The index of a kind of event.
     * @returns {number[]} The frames of the column with an event of that kind.
     * @private
     */
    _eventFrames(column, kind) {
        const { lo, hi } = this._spans;
        const frames = [];
        if (column < 0 || column >= lo.length) return frames;
        const bit = 1 << kind;
        for (let seq = lo[column]; seq < hi[column]; seq++) {
            if (eventMask(this._capture, seq) & bit) frames.push(seq);
        }
        return frames;
    }

    /**
     * @param {PointerEvent} e - A pointer event on the charts.
     * @returns {PerfHoverLine[]} What is under it: the figures of the frame a chart shows there,
     * each part with the color it is drawn in, the events of a row, or what a name beside the
     * charts stands for. Empty for nothing.
     * @private
     */
    _hoverLines(e) {
        const capture = this._capture;
        const { x, row, column } = this._locate(e);
        if (!row) return [];
        if (row.section) return [{ text: this.collapsed.has(row.section) ? 'Click to expand' : 'Click to collapse' }];
        const chart = row.chart !== undefined ? CHARTS[row.chart] : null;
        const kind = row.kind !== undefined ? EVENT_KINDS[row.kind] : null;
        if (row.lines) return this._lineChartLines(row.lines, row.index, x, column, row.control);
        if (x < 0) {
            const tip = chart?.tip ?? kind?.tip;
            const lines = tip ? [{ text: tip, wrap: true }] : [];
            if (chart) lines.push({ text: 'Click the name to collapse the chart' });
            if (kind && !eventUnsupported(capture, kind.key)) {
                lines.push({ text: `Click to ${this.hidden.has(`events:${kind.key}`) ? 'show' : 'hide'} its marks` });
            }
            return lines;
        }

        if (kind) {
            const unsupported = eventUnsupported(capture, kind.key);
            if (unsupported) return [{ text: unsupported, wrap: true }];
            if (this.hidden.has(`events:${kind.key}`)) return [];
            const frames = this._eventFrames(column, row.kind);
            /** @type {PerfHoverLine[]} */
            const lines = [];
            for (const seq of frames.slice(0, HOVER_FRAMES)) {
                lines.push({ text: `Frame ${seq + 1}` });
                for (const text of eventLines(capture, seq, kind.key)) lines.push({ text, color: kind.color, indent: true });
            }
            if (frames.length > HOVER_FRAMES) lines.push({ text: `… and ${frames.length - HOVER_FRAMES} more frames` });
            return lines;
        }

        const seq = this._columns[row.chart]?.[column] ?? -1;
        if (!capture.has(seq)) return [];
        const { lo, hi } = this._spans;
        const many = hi[column] - lo[column];
        const d = capture.data;
        const s = capture.slot(seq);
        const shape = this._shape(chart);
        const total = d[shape.total][s];
        const fps = chart.key === 'frame' && total > 0 ? ` · ${(1000 / total).toFixed(1)} fps` : '';
        const without = shape.reduced ? `, without the inspector's ${chart.format(d.inspector[s])}` : '';
        /** @type {PerfHoverLine[]} */
        const lines = [
            { text: `Frame ${seq + 1}${many > 1 ? `, the largest of ${many} frames here` : ''}` },
            // a chart of one part has its color on the total, the others on each part
            { text: `${chart.title} ${chart.format(total)}${fps}${without}`, color: shape.parts.length === 1 ? shape.parts[0].color : undefined }
        ];
        if (shape.parts.length > 1) {
            // largest first, the chips telling them apart in the stack
            const parts = shape.parts.map(part => ({ part, v: d[part.channel][s] })).filter(({ v }) => v > 0);
            parts.sort((a, b) => b.v - a.v);
            for (const { part, v } of parts) lines.push({ text: `${part.name} ${chart.format(v)}`, color: part.color, indent: true });
        }
        for (const line of shape.lines) {
            const v = d[line.channel][s];
            if (v > 0) lines.push({ text: `${line.name} ${chart.format(v)}, among those above`, color: line.color, indent: true });
        }
        return lines;
    }

    /**
     * Shows one line of a line chart alone, hiding the others, or shows them all again when it
     * already is.
     *
     * @param {string} section - The section of the chart.
     * @param {number} index - The line.
     * @private
     */
    _solo(section, index) {
        const keys = this._lineCharts[section].lines.filter(line => !line.unsupported).map(line => `${section}:${line.key}`);
        const key = this._lineToggle(section, index);
        const alone = !this.hidden.has(key) && keys.every(other => other === key || this.hidden.has(other));
        for (const other of keys) {
            if (alone || other === key) this.hidden.delete(other);
            else this.hidden.add(other);
        }
    }

    /**
     * @param {string} section - The section of a line chart.
     * @param {number} index - One of its lines.
     * @returns {string|null} The key the line is hidden under, or null for one that cannot show.
     * @private
     */
    _lineToggle(section, index) {
        const line = this._lineCharts[section]?.lines[index];
        return line && !line.unsupported ? `${section}:${line.key}` : null;
    }

    /**
     * @param {string} section - The section of the line chart under the pointer.
     * @param {number} index - The line the pointer is beside.
     * @param {number} x - Where the pointer is across the plot, negative over the list.
     * @param {number} column - The column under it.
     * @param {'more'|'fewer'} [control] - The row of the Scripts list showing more types or fewer
     * the pointer is beside.
     * @returns {PerfHoverLine[]} Over the list, what clicking does; over the chart, every line of
     * the frame there, largest first, with its change since the frame before, and for the other
     * scripts the types among them.
     * @private
     */
    _lineChartLines(section, index, x, column, control) {
        const capture = this._capture;
        const drawn = this._lineCharts[section];
        if (!drawn) return [];
        const line = drawn.lines[index];
        if (x < 0) {
            if (control === 'more') {
                const others = drawn.legend?.others ?? 0;
                return [{ text: `Give the next ${Math.min(SCRIPT_ROWS, others)} of the ${formatCount(others)} other script types a band of their own`, wrap: true }];
            }
            if (control === 'fewer') return [{ text: `Show only the ${SCRIPT_ROWS} longest script types, and those pinned`, wrap: true }];
            if (!line) return [];
            if (line.unsupported) return [{ text: line.unsupported, wrap: true }];
            // the name of a script is its own, as written
            const name = drawn.stacked && line.key !== '#other' ? line.name : line.name.toLowerCase();
            const hint = [`Click to ${this.hidden.has(`${section}:${line.key}`) ? 'show' : 'hide'} ${name} in the chart, Alt+click to show it alone`];
            if (drawn.stacked && line.id >= 0) hint.push(line.pinned ? 'Pinned, so it keeps a band of its own. Shift+click to unpin it' : 'Shift+click to pin it, so it keeps a band of its own');
            return hint.map(text => ({ text, wrap: true }));
        }
        const seq = drawn.pick[column] ?? -1;
        if (!capture.has(seq)) return [];
        const d = capture.data;
        const s = capture.slot(seq);
        if (drawn.stacked) {
            /** @type {PerfHoverLine[]} */
            const lines = [{ text: `Frame ${seq + 1}` }];
            if (!(d.scriptsTotal[s] >= 0)) return [...lines, { text: 'Scripts were not timed in this frame', indent: true }];
            lines.push({ text: `Scripts ${formatMs(d.scriptsTotal[s])} · ${callCount(d.scriptCalls[s])}` });
            // the calls of each type, the other scripts' being what the listed ones leave
            const figures = capture.scriptFigures(seq);
            let listed = 0;
            const callsOf = (l) => {
                if (l.id < 0) return d.scriptCalls[s] - listed;
                const base = l.id * SCRIPT_STRIDE;
                const n = figures && base < figures.length ? figures[base + SCRIPT_CALLS] + figures[base + SCRIPT_CALLS + 1] + figures[base + SCRIPT_CALLS + 2] : 0;
                listed += n;
                return n;
            };
            const entries = drawn.lines.map((l, i) => ({ l, v: drawn.values[i][s], n: callsOf(l) })).filter(({ v }) => v > 0);
            entries.sort((a, b) => b.v - a.v);
            for (const { l, v, n } of entries) {
                const hidden = this.hidden.has(`${section}:${l.key}`) ? ', hidden' : '';
                lines.push({ text: `${l.name} ${formatMs(v)} · ${callCount(n)}${hidden}`, color: l.color, indent: true });
                if (l.id === -1 && drawn.legend) lines.push(...this._otherScriptLines(seq, drawn.legend));
            }
            return lines;
        }
        const p = capture.has(seq - 1) ? capture.slot(seq - 1) : -1;
        const entries = drawn.lines.map(l => ({ l, v: d[l.key][s] })).filter(({ v }) => Number.isFinite(v));
        entries.sort((a, b) => b.v - a.v);
        /** @type {PerfHoverLine[]} */
        const lines = [{ text: `Frame ${seq + 1}` }];
        for (const { l, v } of entries) {
            const delta = p >= 0 ? v - d[l.key][p] : 0;
            const change = Number.isFinite(delta) && delta !== 0 ? ` (${delta > 0 ? '+' : '−'}${drawn.format(Math.abs(delta))})` : '';
            const hidden = this.hidden.has(`${section}:${l.key}`) ? ', hidden' : '';
            lines.push({ text: `${l.name} ${drawn.format(v)}${change}${hidden}`, color: l.color, indent: true });
        }
        return lines;
    }

    /**
     * @param {number} seq - A kept frame.
     * @param {PerfScriptLegend} legend - The script types with a band of their own.
     * @returns {PerfHoverLine[]} The longest of the other script types in the frame, then how many
     * more there were.
     * @private
     */
    _otherScriptLines(seq, legend) {
        const capture = this._capture;
        const times = capture.scriptFigures(seq);
        if (!times) return [];
        const others = [];
        for (let base = 0, id = 0; base < times.length; base += SCRIPT_STRIDE, id++) {
            const v = times[base] + times[base + 1] + times[base + 2];
            const n = times[base + SCRIPT_CALLS] + times[base + SCRIPT_CALLS + 1] + times[base + SCRIPT_CALLS + 2];
            if (v > 0 && !legend.colors.has(id)) others.push({ id, v, n });
        }
        others.sort((a, b) => b.v - a.v);
        /** @type {PerfHoverLine[]} */
        const lines = others.slice(0, HOVER_SCRIPT_TYPES).map(({ id, v, n }) => ({ text: `${capture.scriptNames[id]} ${formatMs(v)} · ${callCount(n)}`, indent: true, nested: true }));
        if (others.length > HOVER_SCRIPT_TYPES) lines.push({ text: `… and ${others.length - HOVER_SCRIPT_TYPES} more`, indent: true, nested: true });
        return lines;
    }

    /**
     * Shows what is under the pointer in a box beside it, or hides the box. The lines are rebuilt
     * only when they change, as the pointer moves within a column.
     *
     * @param {PointerEvent|null} e - A pointer event on the charts, or null to hide the box.
     * @private
     */
    _showHover(e) {
        this._renderHover(this._hoverEl, this._panelEl, e ? this._hoverLines(e) : [], e, false);
    }

    /**
     * Fills a hover box with lines and places it beside the pointer, or hides it when there are
     * none. The lines are rebuilt only when they change.
     *
     * @param {HTMLElement} box - The hover box.
     * @param {HTMLElement} container - The element it is placed in.
     * @param {PerfHoverLine[]} lines - What it says.
     * @param {PointerEvent|null} e - The pointer event it follows.
     * @param {boolean} above - Whether it goes above the pointer rather than below. It goes above
     * anyway when there is no room below.
     * @private
     */
    _renderHover(box, container, lines, e, above) {
        if (!lines.length || !e) {
            box.style.display = 'none';
            return;
        }
        const signature = lines.map(line => `${line.color ?? ''}|${line.indent ? 1 : 0}|${line.nested ? 1 : 0}|${line.strong ? 1 : 0}|${line.text}`).join('\n');
        if (signature !== this._hoverSignatures.get(box)) {
            this._hoverSignatures.set(box, signature);
            const doc = box.ownerDocument;
            box.textContent = '';
            for (const line of lines) {
                const lineEl = doc.createElement('div');
                lineEl.className = `pci-perf-hover-line${line.indent ? ' pci-indent' : ''}${line.nested ? ' pci-nested' : ''}${line.wrap ? ' pci-wrap' : ''}${line.strong ? ' pci-strong' : ''}`;
                if (line.color) {
                    const swatch = doc.createElement('span');
                    swatch.className = 'pci-perf-swatch';
                    swatch.style.background = line.color;
                    lineEl.appendChild(swatch);
                }
                lineEl.appendChild(doc.createTextNode(line.text));
                box.appendChild(lineEl);
            }
        }
        box.style.display = 'block';
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const w = box.offsetWidth;
        const h = box.offsetHeight;
        const room = (container.ownerDocument.defaultView?.innerHeight ?? Infinity) - e.clientY - 4;
        box.style.left = `${x + 14 + w > rect.width ? Math.max(0, x - 14 - w) : x + 14}px`;
        box.style.top = `${above || h + 14 > room ? y - 10 - h : y + 14}px`;
    }

    /**
     * @param {PointerEvent} e - A pointer event on the frame timeline.
     * @returns {PerfHoverLine[]} Everything on the row under it, largest first, with the bar under
     * it marked: the small bars of a row are hard to point at one by one.
     * @private
     */
    _timelineLines(e) {
        const hit = this._timelineHit(e);
        if (!hit) return [];
        const { lane, bars, hovered } = hit;
        const average = this.range ? ', average per frame' : '';
        // the scripts list their types rather than the row
        if (hovered?.children?.length) {
            const at = Number.isFinite(hovered.start) ? ` at +${formatMs(hovered.start)}` : '';
            /** @type {PerfHoverLine[]} */
            const lines = [{ text: `${hovered.name} ${formatMs(hovered.duration)}${at}${average}` }];
            const children = [...hovered.children].sort((a, b) => b.duration - a.duration);
            for (const child of children.slice(0, HOVER_SCRIPT_TYPES)) {
                const calls = child.calls !== undefined ? ` · ${callCount(child.calls)}` : '';
                lines.push({ text: `${child.name} ${formatMs(child.duration)}${calls}`, color: child.color, indent: true });
            }
            if (hovered.pass) lines.push({ text: `Click to show ${hovered.name} on the Frame graph tab` });
            if (children.length > HOVER_SCRIPT_TYPES) lines.push({ text: `… and ${children.length - HOVER_SCRIPT_TYPES} more`, indent: true });
            return lines;
        }
        // a total only where the bars add up to one: the breakdown is of two
        const timed = lane.key === 'cpu' || lane.key === 'gpu';
        const total = bars.reduce((sum, b) => sum + b.duration, 0);
        /** @type {PerfHoverLine[]} */
        const lines = [{ text: `${lane.title}${timed ? ` ${formatMs(total)}` : ''}${average}` }];
        const sorted = lane.key === 'events' ? bars : [...bars].sort((a, b) => b.duration - a.duration);
        const long = lane.key === 'types' || lane.key === 'gpu' || lane.key === 'gpuPasses';
        const shown = sorted.slice(0, long ? HOVER_SCRIPT_TYPES : TIMELINE_HOVER_BARS);
        // the hovered bar is listed even when the list is cut short
        if (hovered && !shown.includes(hovered)) shown[shown.length - 1] = hovered;
        for (const b of shown) {
            const time = b.duration > 0 ? ` ${formatMs(b.duration)}` : '';
            const at = Number.isFinite(b.start) ? ` at +${formatMs(b.start)}` : '';
            const calls = b.calls !== undefined ? ` · ${callCount(b.calls)}` : '';
            lines.push({ text: `${b.label ?? b.name}${time}${at}${calls}`, color: b.color, indent: true, strong: b === hovered });
        }
        if (sorted.length > shown.length) lines.push({ text: `… and ${sorted.length - shown.length} more`, indent: true });
        if (hovered?.script !== undefined) lines.push({ text: `Click to show ${hovered.name} on the Scripts tab` });
        if (hovered?.pass) lines.push({ text: `Click to show ${hovered.label ?? hovered.name} on the Frame graph tab` });
        if (lane.key === 'detail') {
            const scripted = bars.some(b => b.children);
            lines.push({
                text: scripted ? 'The rest of the update is the other components, and the cost of timing the scripts' :
                    'The rest of the update is the scripts and the other components. Turn on Script timing to time the scripts',
                wrap: true
            });
            if (!this._capture.detailed) lines.push({ text: 'The phases of the render are timed by the profiler and debug engines', wrap: true });
        }
        return lines;
    }

    /**
     * @param {PointerEvent} e - The event.
     * @private
     */
    _onPointerDown = (e) => {
        // a Ctrl+click is the context click of macOS, whose release can go missing once the menu
        // it opens shows: a press started on it would keep the pointer, so the menu got none
        if (e.button !== 0 || e.ctrlKey) return;
        const { x, row } = this._locate(e);
        // a section's title, or the name beside an open chart, collapses or expands it
        const section = row?.section ?? (x < 0 && row?.chart !== undefined ? CHARTS[row.chart].key : null);
        if (section) {
            if (this.collapsed.has(section)) this.collapsed.delete(section);
            else this.collapsed.add(section);
            // the rows move, so what the box says no longer matches what is under the pointer
            this._showHover(null);
            this.invalidate();
            this.onCollapse();
            return;
        }
        // the rows of the Scripts list that show more script types, or fewer
        if (x < 0 && row?.control) {
            this.scriptRows = row.control === 'more' ? this.scriptRows + SCRIPT_ROWS : SCRIPT_ROWS;
            this._showHover(null);
            this.invalidate();
            this.onCollapse();
            return;
        }
        // a line of a line chart, or a row of events, from its box: Alt shows it alone, and Shift
        // pins a script type
        const toggle = x >= 0 ? null : row?.lines ? this._lineToggle(row.lines, row.index) :
            row?.kind !== undefined && !eventUnsupported(this._capture, EVENT_KINDS[row.kind].key) ? `events:${EVENT_KINDS[row.kind].key}` : null;
        if (toggle) {
            const line = row.lines ? this._lineCharts[row.lines].lines[row.index] : null;
            if (e.shiftKey && row.lines === 'scripts' && line.id >= 0) {
                this._hoverSignatures.delete(this._hoverEl);
                this.togglePin(line.name);
                this._showHover(null);
                return;
            }
            if (e.altKey && row.lines) this._solo(row.lines, row.index);
            else if (this.hidden.has(toggle)) this.hidden.delete(toggle);
            else this.hidden.add(toggle);
            this._hoverSignatures.delete(this._hoverEl);
            this._showHover(e);
            this.invalidate();
            this.onCollapse();
            return;
        }
        if (x < 0) return;
        this._canvas.setPointerCapture?.(e.pointerId);
        this._press = { x, seq: this._seqAt(x), ranging: false, pointerId: e.pointerId };
        this._showHover(null);
    };

    /**
     * @param {PointerEvent} e - The event.
     * @private
     */
    _onPointerMove = (e) => {
        const { x } = this._locate(e);
        const press = this._press;
        if (press && (press.ranging || Math.abs(x - press.x) > 4)) {
            press.ranging = true;
            const capture = this._capture;
            const a = Math.max(capture.first, Math.min(press.seq, this._seqAt(x)));
            const b = Math.min(capture.end - 1, Math.max(press.seq, this._seqAt(x)));
            this.range = b >= a ? { from: a, to: b } : null;
            this._drawn.overlay = true;
            this._drawn.timeline = true;
            this._checkScriptLegend();
            this.onChange();
        } else if (!press) {
            this._showHover(e);
        }
        // only the marks move with the pointer: the charts keep to their own pace
        const hover = x >= 0 ? this._pickAt(e) : -1;
        if (hover !== this._hover) {
            this._hover = hover;
            this._drawn.overlay = true;
        }
        const level = x >= 0 ? this._levelAt(e) : null;
        if (level?.y !== this._level?.y || level?.value !== this._level?.value) {
            this._level = level;
            this._drawn.overlay = true;
        }
    };

    /**
     * @param {PointerEvent} e - A pointer event on the charts.
     * @returns {{ y: number, value: number, format: (value: number) => string }|null} The level
     * under it in the chart it is over, a whole pixel down the canvas, or null outside one.
     * @private
     */
    _levelAt(e) {
        const { y, row } = this._locate(e);
        const levels = row?.levels ?? (row?.lines ? this._lineCharts[row.lines]?.levels : null);
        if (!levels) return null;
        const { top, bottom, min, max, format } = levels;
        const at = Math.max(top, Math.min(bottom, Math.round(y)));
        return { y: at, value: min + ((bottom - at) / (bottom - top)) * (max - min), format };
    }

    /**
     * @param {PointerEvent} e - The event.
     * @private
     */
    _onPointerUp = (e) => {
        const press = this._press;
        this._press = null;
        if (!press || e.type === 'pointercancel') return;
        if (!press.ranging) {
            this.range = null;
            this.pick(this._pickAt(e));
        }
    };

    /**
     * A menu opens over the charts: ends any press, letting go of the pointer, so the menu gets it,
     * and hides the hover box, which the menu takes the place of.
     *
     * @private
     */
    _onContextMenu = () => {
        const press = this._press;
        this._press = null;
        if (press && this._canvas.hasPointerCapture?.(press.pointerId)) this._canvas.releasePointerCapture(press.pointerId);
        this._showHover(null);
    };

    /** @private */
    _onPointerLeave = () => {
        this._hover = -1;
        this._level = null;
        this._showHover(null);
        this._drawn.overlay = true;
    };

    /**
     * Zooms around the pointer, or pans with Shift or a sideways scroll.
     *
     * @param {WheelEvent} e - The event.
     * @private
     */
    _onWheel = (e) => {
        // over the names the wheel scrolls the charts, when they do not fit their box
        if (this._locate(e).x < 0) {
            this._showHover(null);
            return;
        }
        e.preventDefault();
        const capture = this._capture;
        if (capture.count === 0) return;
        // the frames as drawn, so the zoom keeps the frame under the pointer in place
        const { from, span, plot } = this._layout;
        const pan = e.shiftKey ? e.deltaY : e.deltaX;
        if (Math.abs(pan) > Math.abs(e.shiftKey ? 0 : e.deltaY)) {
            const next = from + (pan / plot) * span;
            this._view = { from: next, span, follow: next + span >= capture.end };
        } else {
            const x = Math.max(0, this._locate(e).x);
            const anchor = from + (x / plot) * span;
            const next = Math.max(MIN_ZOOM, Math.round(span * Math.exp(e.deltaY * 0.002)));
            // zoomed back out to the whole capture: a short one is spread over the fewest frames
            // the charts show, so it can be zoomed into before it fills them
            if (next >= Math.max(MIN_SPAN, capture.count)) {
                this._view = null;
            } else {
                const start = anchor - (x / plot) * next;
                this._view = { from: start, span: next, follow: start + next >= capture.end };
            }
        }
        this._showHover(null);
        this.invalidate();
    };

    /** @private */
    _onDoubleClick = () => {
        this._view = null;
        this.clearRange();
        this.invalidate();
    };

    /**
     * @param {PointerEvent} e - The event.
     * @private
     */
    _onTimelineMove = (e) => {
        this._renderHover(this._timelineHoverEl, this._timelineEl, this._timelineLines(e), e, true);
        const hovered = this._timelineHit(e)?.hovered;
        this._timeline.style.cursor = hovered?.script !== undefined || hovered?.pass ? 'pointer' : '';
    };

    /**
     * A script type clicked on the timeline shows on the Scripts tab.
     *
     * @param {MouseEvent} e - The event.
     * @private
     */
    _onTimelineClick = (e) => {
        const hovered = this._timelineHit(e)?.hovered;
        if (hovered?.script !== undefined) this.onSelectScript(hovered.script);
        else if (hovered?.pass) this.onSelectPass(hovered.pass);
    };

    /**
     * @param {MouseEvent} e - A pointer event on the frame timeline.
     * @returns {{ lane: { key: string, title: string }, bars: PerfBar[], hovered: PerfBar|null }|null}
     * The row under it, its bars and the bar under it, or null where there is no row with bars.
     * @private
     */
    _timelineHit(e) {
        const rect = this._timeline.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const lane = this._lanes.find(l => y >= l.y - 1 && y < l.y + l.h + 1);
        if (!lane) return null;
        const bars = this._bars.filter(b => b.lane === lane.key);
        if (!bars.length) return null;
        return { lane, bars, hovered: bars.find(b => x >= b.x0 && x < b.x1) ?? null };
    }

    /** @private */
    _onTimelineLeave = () => {
        this._renderHover(this._timelineHoverEl, this._timelineEl, [], null, true);
    };
}

export { CHARTS, PerfCharts };
