/**
 * A message logged by the page.
 *
 * @typedef {object} LogEntry
 * @ignore
 * @property {number} seq - Its number: later messages have higher numbers.
 * @property {number} time - When it was logged, in milliseconds since the capture started; for a
 * repeated message, when it was last logged.
 * @property {number} frame - The app frame it was logged in, or last logged in.
 * @property {string} level - 'error', 'warn', 'info', 'log' or 'debug'.
 * @property {string} text - The message.
 * @property {number} count - How many times in a row it was logged.
 * @property {string} [stack] - Where an uncaught error was thrown.
 */

// the console methods captured, most severe first
const LEVELS = ['error', 'warn', 'info', 'log', 'debug'];

// how many messages are kept, and how much of each
const CAPACITY = 1000;
const MAX_TEXT = 2000;
const MAX_STACK_LINES = 8;

/**
 * @param {*} value - A value logged.
 * @returns {string} It as text, the way the console would show it, roughly.
 */
function format(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value === null || typeof value !== 'object') return String(value);
    try {
        const json = JSON.stringify(value);
        if (json !== undefined) return json.length > 300 ? `${json.slice(0, 300)}…` : json;
    } catch {
        // a cycle, or a getter that throws: named by its class below
    }
    return Object.prototype.toString.call(value);
}

/**
 * @param {any[]} args - The arguments of a console call.
 * @returns {string} The message, as the console prints it: a first string's substitutions, such as
 * %s and %d, filled in from the arguments after it, %c styles left out, and the arguments left over
 * joined by spaces.
 */
function messageOf(args) {
    let rest = args;
    let head = '';
    if (typeof args[0] === 'string') {
        let next = 1;
        head = args[0].replace(/%([sdifoOc%])/g, (match, code) => {
            if (code === '%') return '%';
            if (next >= args.length) return match;
            const value = args[next++];
            if (code === 'c') return '';
            if (code === 'd' || code === 'i') return String(parseInt(value, 10));
            if (code === 'f') return String(parseFloat(value));
            return format(value);
        });
        rest = args.slice(next);
    }
    const text = [...(typeof args[0] === 'string' ? [head] : []), ...rest.map(format)].join(' ');
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * @param {*} error - An error thrown.
 * @returns {string|undefined} The first lines of its stack.
 */
function stackOf(error) {
    const stack = error?.stack;
    return typeof stack === 'string' ? stack.split('\n').slice(0, MAX_STACK_LINES).join('\n') : undefined;
}

/**
 * Keeps the messages the page logs to the console, and the errors nothing caught, while started:
 * the engine's warnings and errors in a debug build, shader compile errors, and the app's own
 * messages. The console methods are wrapped while it runs, and still log as before; the console
 * then names the wrapper as where a message came from, which is why it only runs while asked.
 *
 * @ignore
 */
class LogCapture {
    /**
     * The messages kept, oldest first.
     *
     * @type {LogEntry[]}
     */
    entries = [];

    /**
     * The number of the last message.
     *
     * @type {number}
     */
    seq = 0;

    /**
     * @type {() => number}
     * @private
     */
    _frame;

    /**
     * The console methods replaced, by level, while started.
     *
     * @type {Map<string, Function>|null}
     * @private
     */
    _originals = null;

    /**
     * @type {Map<string, Function>}
     * @private
     */
    _wrappers = new Map();

    /**
     * @type {number}
     * @private
     */
    _start = 0;

    /**
     * @param {() => number} frame - The app frame now.
     */
    constructor(frame) {
        this._frame = frame;
    }

    /**
     * Whether messages are being kept.
     *
     * @type {boolean}
     */
    get capturing() {
        return !!this._originals;
    }

    /**
     * Starts keeping messages.
     */
    start() {
        if (this._originals) return;
        this._start = performance.now();
        this._originals = new Map();
        for (const level of LEVELS) {
            const original = console[level];
            this._originals.set(level, original);
            const wrapper = (...args) => {
                this.add(level, messageOf(args));
                return original.apply(console, args);
            };
            this._wrappers.set(level, wrapper);
            console[level] = wrapper;
        }
        window.addEventListener('error', this._onError);
        window.addEventListener('unhandledrejection', this._onRejection);
    }

    /**
     * Stops keeping messages, and puts the console back. A console method something else replaced
     * after the capture started is left as it is.
     */
    stop() {
        if (!this._originals) return;
        for (const [level, original] of this._originals) {
            if (console[level] === this._wrappers.get(level)) console[level] = original;
        }
        this._originals = null;
        this._wrappers.clear();
        window.removeEventListener('error', this._onError);
        window.removeEventListener('unhandledrejection', this._onRejection);
    }

    /**
     * Keeps a message. A message logged again right after itself counts up rather than repeating.
     *
     * @param {string} level - Its level.
     * @param {string} text - The message.
     * @param {string} [stack] - Where it was thrown.
     */
    add(level, text, stack) {
        const time = Math.round(performance.now() - this._start);
        const frame = this._frame();
        const last = this.entries[this.entries.length - 1];
        if (last && last.level === level && last.text === text) {
            last.count++;
            last.time = time;
            last.frame = frame;
            return;
        }
        /** @type {LogEntry} */
        const entry = { seq: ++this.seq, time, frame, level, text, count: 1 };
        if (stack) entry.stack = stack;
        this.entries.push(entry);
        if (this.entries.length > CAPACITY) this.entries.splice(0, this.entries.length - CAPACITY);
    }

    /**
     * Forgets every message kept.
     */
    clear() {
        this.entries.length = 0;
    }

    /**
     * @param {ErrorEvent} e - An error nothing caught.
     * @private
     */
    _onError = (e) => {
        this.add('error', `Uncaught ${e.error instanceof Error ? `${e.error.name}: ${e.error.message}` : e.message}`, stackOf(e.error));
    };

    /**
     * @param {PromiseRejectionEvent} e - A rejection nothing handled.
     * @private
     */
    _onRejection = (e) => {
        this.add('error', `Unhandled rejection: ${format(e.reason)}`, stackOf(e.reason));
    };
}

export { LEVELS, LogCapture };
