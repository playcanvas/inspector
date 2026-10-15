import {
    BoundingBox, Color, Curve, CurveSet, GraphNode, Mat3, Mat4, OrientedBox, Quat, Tags, Vec2, Vec3, Vec4
} from 'playcanvas';

import { collectProperties, describeValue } from './describe.js';

/** @import { Described } from './describe.js' */
/** @import { ListRow } from './list-view.js' */
/** @import { PropertyRow, PropertySection } from './model.js' */

/**
 * How far a copy follows the links of what it copies.
 *
 * @typedef {object} CopyOptions
 * @ignore
 * @property {number} depth - How many links to follow from the object copied: 0 copies it alone,
 * and Infinity follows every link there is.
 * @property {(object: object) => PropertySection[]|PropertyRow[]|null} [modelFor] - The model of
 * an object reached through a link, as the panel shows it, or null for one it has no model for,
 * which is copied from its public properties instead.
 * @property {(object: object) => boolean} [opaque] - Whether an object is never followed, such as
 * the app and its device, through which everything else could be reached.
 * @property {number} [maxObjects] - How many objects are copied in full before the rest are only
 * referenced, so that copying a huge scene cannot stall the page for long.
 * @property {(object: object) => boolean} [exclude] - Whether a child node belongs to the panel
 * rather than the app, such as the entity of its gizmo, and is left out with everything below it.
 */

/**
 * @typedef {object} CopyResult
 * @ignore
 * @property {*} json - The copy, ready to be stringified.
 * @property {number} objects - The number of objects copied in full.
 * @property {boolean} truncated - Whether the copy stopped at `maxObjects`.
 */

// how many objects a copy holds in full by default
const MAX_OBJECTS = 50000;

// how many entries of a list a copy holds, and how many numbers of a typed array: a long one
// holds data such as vertices, which only its length and first values say anything about here
const MAX_ENTRIES = 10000;
const MAX_NUMBERS = 64;

// the properties of an object without a model that are left out, as every tab leaves them out:
// the device, and the objects of the graphics backend behind a resource
const SKIP_REFLECTED = ['device', 'impl'];

// the properties that tell an object apart, for a reference to one that is not copied in full
const IDENTITY = ['guid', 'id', 'name', 'scriptName', 'path'];

/**
 * @param {*} value - Any object or function.
 * @returns {string} The name of its class.
 */
function typeName(value) {
    if (typeof value === 'function') return 'Function';
    return value?.constructor?.name || 'Object';
}

/**
 * @param {*} n - A number, or a bigint from a typed array.
 * @returns {number|string} The number, or its text where JSON has no number for it, such as NaN.
 */
function num(n) {
    return typeof n === 'number' && Number.isFinite(n) ? n : String(n);
}

/**
 * @param {*} e - A thrown value.
 * @returns {string} Its message, the way the panel shows a getter that throws.
 */
function errorText(e) {
    return `<${e?.message ?? e}>`;
}

/**
 * @param {object} out - The object being filled.
 * @param {string} key - The key wanted.
 * @returns {string} The key, numbered when it is taken, as two sections can share a title.
 */
function uniqueKey(out, key) {
    if (!Object.hasOwn(out, key)) return key;
    let i = 2;
    while (Object.hasOwn(out, `${key} (${i})`)) i++;
    return `${key} (${i})`;
}

/**
 * @param {*} value - A value.
 * @returns {boolean} Whether it is a plain object, such as a JSON attribute of a script.
 */
function isPlain(value) {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Whether a value is an object of the browser rather than of the app, such as an element, a
 * rendering context or a promise. These name their kind through `Symbol.toStringTag`, which the
 * classes of the engine and of apps do not, and are summarized rather than followed, as reading
 * their properties says little and some of them reach the whole page.
 *
 * @param {object} value - An object.
 * @returns {boolean} Whether it is a browser object.
 */
function isHostObject(value) {
    try {
        return typeof /** @type {any} */ (value)[Symbol.toStringTag] === 'string';
    } catch {
        return true;
    }
}

/**
 * @param {PropertySection[]|PropertyRow[]} model - A model.
 * @returns {boolean} Whether it is a list of sections rather than of rows.
 */
function isSections(model) {
    return model.length > 0 && Array.isArray(/** @type {any} */ (model[0]).rows);
}

/**
 * The object a value stands for: the value it was made from, or else the object it links to.
 * Plain data, such as a vector or a list, is not an object of its own but part of its holder.
 *
 * @param {Described} described - A value of the panel.
 * @returns {object|null} The object, or null when the value is plain data.
 */
function objectOf(described) {
    const value = 'raw' in described ? described.raw : described.target;
    if (value === null || value === undefined) return null;
    if (typeof value === 'function') return value;
    if (typeof value !== 'object' || isPlain(value) || Array.isArray(value) || ArrayBuffer.isView(value)) return null;
    if (value instanceof Set || value instanceof Map || value instanceof Tags) return null;
    if (value instanceof Vec2 || value instanceof Vec3 || value instanceof Vec4 || value instanceof Quat || value instanceof Color) return null;
    if (value instanceof Mat3 || value instanceof Mat4 || value instanceof BoundingBox || value instanceof OrientedBox) return null;
    if (value instanceof Curve || value instanceof CurveSet || isHostObject(value)) return null;
    return value;
}

/**
 * Turns what the panel shows into JSON. Values are copied from what they were made from, so
 * numbers keep their precision and lists their length. Objects reached through links are copied
 * the way their own tab shows them, up to a number of links away; beyond that, and wherever an
 * object comes up again, a reference names it instead.
 *
 * Links never lead back up: a node's parent and the lists of what uses an object are left out,
 * and the scene is followed down through the children of nodes only, so a link to another node
 * is a reference. The app's own objects, such as its device and scene, are references too, as
 * everything else can be reached through them.
 *
 * @ignore
 */
class JsonCopy {
    /**
     * @type {number}
     * @private
     */
    _depth;

    /**
     * @type {(object: object) => PropertySection[]|PropertyRow[]|null}
     * @private
     */
    _modelFor;

    /**
     * @type {(object: object) => boolean}
     * @private
     */
    _opaque;

    /**
     * @type {number}
     * @private
     */
    _maxObjects;

    /**
     * @type {(object: object) => boolean}
     * @private
     */
    _exclude;

    /**
     * The objects copied in full so far, so that the next mention of one is a reference.
     *
     * @type {Set<object>}
     * @private
     */
    _copied = new Set();

    /**
     * The plain objects and lists being copied, so that a cycle through them is cut.
     *
     * @type {Set<object>}
     * @private
     */
    _open = new Set();

    /**
     * The number of objects copied in full.
     *
     * @type {number}
     */
    objects = 0;

    /**
     * Whether the copy stopped at its object limit.
     *
     * @type {boolean}
     */
    truncated = false;

    /**
     * @param {CopyOptions} options - How far to follow links.
     */
    constructor(options) {
        this._depth = options.depth;
        this._modelFor = options.modelFor ?? (() => null);
        this._opaque = options.opaque ?? (() => false);
        this._maxObjects = options.maxObjects ?? MAX_OBJECTS;
        this._exclude = options.exclude ?? (() => false);
    }

    /**
     * @param {*} json - The copy.
     * @returns {CopyResult} The copy, with how much of it there is.
     */
    result(json) {
        return { json, objects: this.objects, truncated: this.truncated };
    }

    /**
     * Copies an object found as a value.
     *
     * @param {object} obj - The object.
     * @param {number} level - The number of links followed to reach it.
     * @param {PropertyRow[]} [rows] - The rows the panel opens it into in place, if it does.
     * @returns {*} The copy.
     */
    link(obj, level, rows) {
        if (level > 0 && (obj instanceof GraphNode || this._opaque(obj))) return this.reference(obj, '$stub');
        return this.object(obj, level, rows);
    }

    /**
     * Copies an object in full, or as a reference when it is out of reach or already copied.
     *
     * @param {object} obj - The object.
     * @param {number} level - The number of links followed to reach it.
     * @param {PropertySection[]|PropertyRow[]} [model] - What the panel shows for it, when that is
     * known. Defaults to the model of its own tab.
     * @returns {*} The copy.
     */
    object(obj, level, model) {
        if (this._copied.has(obj)) return this.reference(obj, '$ref');
        if (level > this._depth) return this.reference(obj, '$stub');
        if (this.objects >= this._maxObjects) {
            this.truncated = true;
            return { ...this.reference(obj, '$stub'), $truncated: true };
        }

        const content = model ?? this._modelFor(obj);
        // a function only has the properties every function has, so its name says it all
        if (!content && typeof obj === 'function') return `ƒ ${obj.name || 'anonymous'}`;

        this._copied.add(obj);
        this.objects++;

        const out = { $type: typeName(obj) };
        if (!content) {
            Object.assign(out, this.reflect(obj, level));
        } else if (isSections(content)) {
            Object.assign(out, this.sections(/** @type {PropertySection[]} */ (content), level));
        } else {
            Object.assign(out, this.rows(/** @type {PropertyRow[]} */ (content), level));
        }
        if (obj instanceof GraphNode) {
            out.children = obj.children.filter(child => !this._exclude(child)).map(child => this.object(child, level + 1));
        }
        return out;
    }

    /**
     * @param {object} obj - An object not copied in full.
     * @param {'$ref'|'$stub'} flag - `$ref` for one copied in full elsewhere in the copy, `$stub`
     * for one out of reach.
     * @returns {object} What tells the object apart.
     */
    reference(obj, flag) {
        const out = { $type: typeName(obj) };
        for (const name of IDENTITY) {
            let value;
            try {
                value = /** @type {any} */ (obj)[name];
            } catch {
                continue;
            }
            if (typeof value === 'string' || typeof value === 'number') out[name] = value;
        }
        // an object without a name of its own is told apart by its summary in the panel
        if (Object.keys(out).length === 1) {
            const summary = describeValue(obj, 1).text;
            if (summary !== out.$type) out.$summary = summary;
        }
        out[flag] = true;
        return out;
    }

    /**
     * @param {PropertySection[]} sections - The sections of an object.
     * @param {number} level - The number of links followed to reach the object.
     * @returns {object} The sections by title, without those listing what uses the object.
     */
    sections(sections, level) {
        const out = {};
        for (const section of sections) {
            if (section.backlink) continue;
            out[uniqueKey(out, section.title)] = this.rows(section.rows, level);
        }
        return out;
    }

    /**
     * @param {PropertyRow[]} rows - The rows of an object, or of a section of one.
     * @param {number} level - The number of links followed to reach the object.
     * @returns {object} The values by label.
     */
    rows(rows, level) {
        const out = {};
        for (const row of rows) {
            // the entries of a collection follow its row, which copies them from its value
            if (row.depth || row.value.backlink) continue;
            out[uniqueKey(out, row.label || row.key)] = this.described(row.value, level);
        }
        return out;
    }

    /**
     * @param {Described} described - A value of the panel.
     * @param {number} level - The number of links followed to reach the object holding it.
     * @returns {*} The copy.
     */
    described(described, level) {
        const obj = objectOf(described);
        if (described.expand) {
            let rows;
            try {
                rows = described.expand();
            } catch (e) {
                return errorText(e);
            }
            // an object opened in place is a link like any other; anything else is a detail of its holder
            return obj ? this.link(obj, level + 1, rows) : this.rows(rows, level);
        }
        if ('raw' in described) return this.value(described.raw, level);
        if (described.items) return this.items(described.items, level);
        if (obj) return this.link(obj, level + 1);
        // source code only for the object copied, as the sources of everything it reaches would bury it
        if (typeof described.code === 'string' && level <= 0) return described.code;
        return described.text;
    }

    /**
     * @param {Described[]} items - The entries of a collection the panel built, each with a label.
     * @param {number} level - The number of links followed to reach the object holding it.
     * @returns {*} The entries: a list when they are only numbered, or else by label, as the
     * versions of a shader's source are.
     */
    items(items, level) {
        if (items.every(item => !item.label || /^\[\d+\]$/.test(item.label))) {
            return items.map(item => this.described(item, level));
        }
        const out = {};
        for (const item of items) {
            out[uniqueKey(out, item.label ?? '')] = this.described(item, level);
        }
        return out;
    }

    /**
     * @param {*} value - A value read from an object.
     * @param {number} level - The number of links followed to reach the object holding it.
     * @returns {*} The copy.
     */
    value(value, level) {
        if (value === null || value === undefined) return null;
        switch (typeof value) {
            case 'boolean':
            case 'string':
                return value;
            case 'number':
            case 'bigint':
                return num(value);
            case 'symbol':
                return value.toString();
            case 'function':
                return this.link(value, level + 1);
        }

        if (value instanceof Vec2) return [num(value.x), num(value.y)];
        if (value instanceof Vec3) return [num(value.x), num(value.y), num(value.z)];
        if (value instanceof Vec4 || value instanceof Quat) return [num(value.x), num(value.y), num(value.z), num(value.w)];
        if (value instanceof Color) return [num(value.r), num(value.g), num(value.b), num(value.a)];
        if (value instanceof Mat3 || value instanceof Mat4) return Array.from(value.data, num);
        if (value instanceof OrientedBox) {
            return { halfExtents: this.value(value.halfExtents, level), worldTransform: this.value(value.worldTransform, level) };
        }
        if (value instanceof BoundingBox) {
            return { center: this.value(value.center, level), halfExtents: this.value(value.halfExtents, level) };
        }
        if (value instanceof Curve) return { type: value.type, keys: value.keys.map(key => Array.from(key, num)) };
        if (value instanceof CurveSet) return { type: value.type, curves: value.curves.map(curve => this.value(curve, level)) };
        if (value instanceof Tags) return value.list();

        if (value instanceof DataView || value instanceof ArrayBuffer) return { $type: typeName(value), byteLength: value.byteLength };
        if (ArrayBuffer.isView(value)) {
            const numbers = /** @type {any} */ (value);
            if (numbers.length <= MAX_NUMBERS) return Array.from(numbers, num);
            return { $type: typeName(value), length: numbers.length, values: Array.from(numbers.subarray(0, MAX_NUMBERS), num), $truncated: true };
        }
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
        if (value instanceof RegExp) return String(value);

        if (Array.isArray(value) || value instanceof Set) return this.list(value, level);
        if (value instanceof Map) return this.map(value, level);
        if (isPlain(value)) return this.plain(value, level);
        if (isHostObject(value)) return describeValue(value, 1).text;

        return this.link(value, level + 1);
    }

    /**
     * @param {any[]|Set<*>} values - A list.
     * @param {number} level - The number of links followed to reach the object holding it.
     * @returns {*} The entries, or the first of them when there are too many to hold.
     */
    list(values, level) {
        if (this._open.has(values)) return '<circular>';
        this._open.add(values);
        const out = [];
        for (const entry of values) {
            if (out.length >= MAX_ENTRIES) break;
            out.push(this.value(entry, level));
        }
        this._open.delete(values);

        const size = Array.isArray(values) ? values.length : values.size;
        return size > MAX_ENTRIES ? { $type: typeName(values), length: size, values: out, $truncated: true } : out;
    }

    /**
     * @param {Map<*, *>} map - A map.
     * @param {number} level - The number of links followed to reach the object holding it.
     * @returns {object} The entries by key, the way the panel names the keys.
     */
    map(map, level) {
        if (this._open.has(map)) return '<circular>';
        this._open.add(map);
        const out = {};
        let count = 0;
        for (const [key, entry] of map) {
            if (count++ >= MAX_ENTRIES) {
                out.$truncated = true;
                break;
            }
            const name = typeof key === 'object' && key !== null ? describeValue(key, 1).text : String(key);
            out[uniqueKey(out, name)] = this.value(entry, level);
        }
        this._open.delete(map);
        return out;
    }

    /**
     * @param {object} obj - A plain object, part of the object holding it.
     * @param {number} level - The number of links followed to reach the object holding it.
     * @returns {object} Its fields.
     */
    plain(obj, level) {
        if (this._open.has(obj)) return '<circular>';
        this._open.add(obj);
        const out = {};
        for (const key of Object.keys(obj)) {
            let value;
            try {
                value = obj[key];
            } catch (e) {
                out[key] = errorText(e);
                continue;
            }
            if (typeof value !== 'function') out[key] = this.value(value, level);
        }
        this._open.delete(obj);
        return out;
    }

    /**
     * @param {ListRow[]} rows - The rows of a list.
     * @returns {*} The entries, see {@link JsonCopy#listEntry}, or for a list in groups, the
     * groups by title, see {@link JsonCopy#group}.
     */
    listRows(rows) {
        const first = rows.findIndex(row => row.header);
        if (first < 0) return rows.map(row => this.listEntry(row));

        const out = {};
        // rows ahead of the first group belong to none
        if (first > 0) out.entries = rows.slice(0, first).map(row => this.listEntry(row));
        rows.forEach((row, index) => {
            if (row.header) out[uniqueKey(out, row.name)] = this.group(rows, index);
        });
        return out;
    }

    /**
     * @param {ListRow[]} rows - The rows of a list in groups.
     * @param {number} index - The index of the header of the group.
     * @returns {object} The figures of the header, such as its count and size, and the entries of
     * the group: its rows, followed by what the header says the group holds without listing it.
     */
    group(rows, index) {
        const header = rows[index];
        const out = this.figures(header, false);
        const entries = [];
        for (let i = index + 1; i < rows.length && !rows[i].header; i++) {
            entries.push(this.listEntry(rows[i]));
        }
        for (const obj of header.contents?.() ?? []) {
            entries.push(this.object(obj, 0));
        }
        out.entries = entries;
        return out;
    }

    /**
     * @param {ListRow} row - A row of a list.
     * @returns {*} The object the row selects, copied as if it was selected and copied on its own,
     * or the figures of a row that selects nothing.
     */
    listEntry(row) {
        const item = row.item;
        if ((typeof item === 'object' && item !== null) || typeof item === 'function') return this.object(item, 0);
        return this.figures(row, true);
    }

    /**
     * @param {ListRow} row - A row of a list.
     * @param {boolean} named - Whether to include the cell naming the row, which a group is
     * already keyed by.
     * @returns {object} The text of its cells, keyed by the kind of each: its name, info, count,
     * size and so on.
     */
    figures(row, named) {
        const out = {};
        row.cells.forEach((cell, index) => {
            const value = cell.toggle ? !!cell.checked : cell.text;
            if (value === '') return;
            const key = cell.cls?.match(/\bpci-cell-([a-z]+)/)?.[1] ?? String(index);
            if (key === 'name' && !named) return;
            out[uniqueKey(out, key)] = value;
        });
        return out;
    }

    /**
     * Copies an object the panel has no model for from its public properties, see
     * {@link collectProperties}, other than its device and the objects of the graphics backend.
     *
     * @param {object} obj - The object.
     * @param {number} level - The number of links followed to reach it.
     * @returns {object} Its properties.
     */
    reflect(obj, level) {
        const out = {};
        for (const name of collectProperties(obj, [], SKIP_REFLECTED)) {
            let value;
            try {
                value = /** @type {any} */ (obj)[name];
            } catch (e) {
                out[name] = errorText(e);
                continue;
            }
            out[name] = this.value(value, level);
        }
        return out;
    }
}

/**
 * Copies the subject of the panel, which is where the links followed are counted from.
 *
 * @param {object} subject - The subject.
 * @param {PropertySection[]} sections - What the panel shows for it.
 * @param {CopyOptions} options - How far to follow links.
 * @returns {CopyResult} The copy.
 */
function copySubject(subject, sections, options) {
    const copy = new JsonCopy(options);
    return copy.result(copy.object(subject, 0, sections));
}

/**
 * Copies a section of the subject, under its title.
 *
 * @param {PropertySection} section - The section.
 * @param {CopyOptions} options - How far to follow links.
 * @returns {CopyResult} The copy.
 */
function copySection(section, options) {
    const copy = new JsonCopy(options);
    return copy.result({ [section.title]: copy.rows(section.rows, 0) });
}

/**
 * Copies a list, such as everything a tab lists, under its name. See {@link JsonCopy#listRows}.
 *
 * @param {string} title - The name of the list.
 * @param {ListRow[]} rows - Its rows, all of them, whatever its filter shows.
 * @param {CopyOptions} options - How far to follow links from each entry.
 * @returns {CopyResult} The copy.
 */
function copyList(title, rows, options) {
    const copy = new JsonCopy(options);
    return copy.result({ [title]: copy.listRows(rows) });
}

/**
 * Copies a group of a list, under its title. See {@link JsonCopy#group}.
 *
 * @param {ListRow[]} rows - The rows of the list.
 * @param {string} key - The key of the group's header.
 * @param {CopyOptions} options - How far to follow links from each entry.
 * @returns {CopyResult} The copy, empty when the group is gone.
 */
function copyGroup(rows, key, options) {
    const copy = new JsonCopy(options);
    const index = rows.findIndex(row => row.header && row.key === key);
    return copy.result(index < 0 ? {} : { [rows[index].name]: copy.group(rows, index) });
}

/**
 * Copies the figures of a row of a list that selects nothing, such as the size of a pool.
 *
 * @param {ListRow} row - The row.
 * @returns {CopyResult} The copy.
 */
function copyListRow(row) {
    const copy = new JsonCopy({ depth: 0 });
    return copy.result(copy.figures(row, true));
}

/**
 * Copies a row. A row standing for an object copies the object, counting the links followed from
 * it; a list copies its entries the same way, each as if it was copied on its own. Anything else
 * is copied under its label.
 *
 * @param {PropertyRow} row - The row.
 * @param {CopyOptions} options - How far to follow links.
 * @returns {CopyResult} The copy.
 */
function copyRow(row, options) {
    const copy = new JsonCopy(options);
    const json = copy.described(row.value, -1);
    const isObject = !!objectOf(row.value) && typeof json === 'object' && json !== null && Object.hasOwn(json, '$type');
    return copy.result(isObject ? json : { [row.label || row.key]: json });
}

/**
 * Prints a copy as indented JSON, the way `JSON.stringify` does, except that a list of plain
 * values stays on one line, so a vector reads as `[0, 1, 0]` rather than taking five lines.
 *
 * @param {*} json - The copy.
 * @param {string} [indent] - The indentation of the line the value starts on.
 * @returns {string} The text.
 */
function stringifyCopy(json, indent = '') {
    if (json === null || typeof json !== 'object') return JSON.stringify(json) ?? 'null';
    const inner = `${indent}  `;
    if (Array.isArray(json)) {
        if (json.every(value => value === null || typeof value !== 'object')) {
            return `[${json.map(value => JSON.stringify(value) ?? 'null').join(', ')}]`;
        }
        return `[\n${json.map(value => inner + stringifyCopy(value, inner)).join(',\n')}\n${indent}]`;
    }
    const keys = Object.keys(json);
    if (keys.length === 0) return '{}';
    return `{\n${keys.map(key => `${inner}${JSON.stringify(key)}: ${stringifyCopy(json[key], inner)}`).join(',\n')}\n${indent}}`;
}

export { copyGroup, copyList, copyListRow, copyRow, copySection, copySubject, stringifyCopy };
