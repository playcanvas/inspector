// Drives the inspector's MCP tools through Chrome's own WebMCP, the way an agent in the browser
// would: launches system Chrome with WebMCP enabled, opens a page running an app with the
// inspector, presses the MCP switch in the status bar, then lists the tools the page registered
// with document.modelContext and calls them.
//
// node e2e/webmcp.mjs [--url <page>] [--headless] [--calls '<json>'] [--dump <dir>] [--perf <frames> [dir]]
//                      [--perf-dump [dir]] [--wait] [--connect <browser-url>]
//
// --url      A page whose app has an Inspector. Defaults to the inspector example of the engine's
//            examples browser on port 5620, opened without the browser around it.
// --calls    A JSON array of [toolName, arguments] pairs to call in order. A string argument value
//            of the form "$N.path.to.value" is replaced by that value of the result of call N
//            (0-based), so ids found by one call can be passed to the next. Without it (and without
//            --dump), a walk from a rendered entity to its shader and back runs.
// --dump     Writes everything the app holds to files in the directory, for an agent to search
//            rather than read: index.json, then a file per kind (entities.json, materials.json,
//            shaders.json with their sources, ...) holding each object as playcanvas_get returns
//            it, keyed by its $id. The links between objects are $id references across the files.
// --perf     Records that many frames on the Performance tab through the perf tools, with GPU and
//            script timing where the app has them, prints the summary, then writes the capture to
//            files: capture.json (the header and every frame, as playcanvas_perf_frame returns
//            them) and a CSV per series (series-cpu.csv, series-gpu.csv, ...). Into the directory
//            given after the frames, else the --dump directory; with neither, it only prints the
//            summary.
// --perf-dump
//            Writes the capture the Performance tab already holds to the same files as --perf,
//            without recording: one recorded with its Record button. Into the directory given after
//            it, else the --dump directory, else perf-dump. Use it with --wait or --connect, as a
//            page this script opens has recorded nothing yet.
// --wait     Opens a window and waits for Enter in the terminal before calling anything, so a
//            capture can be recorded by hand in it first. Implies a window, not --headless.
// --connect  Uses a Chrome already running rather than launching one, such as the one a capture
//            was recorded in, given by its remote debugging URL (http://127.0.0.1:9222 for a
//            Chrome started with --remote-debugging-port=9222 --enable-features=WebMCP). Uses its
//            tab whose URL contains --url's value when given, else the first tab with an inspector,
//            and leaves Chrome running.
// --images   The directory screenshots are written to, as PNG files. Defaults to screenshots.
// --headless Run Chrome without a window.
//
// Needs Chrome 150+ (WebMCP behind --enable-features=WebMCP). Set CHROME_PATH to use another build.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { connect, launch } from 'puppeteer-core';

import { toCsv } from '../src/perf-copy.js';

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};

const url = option('--url') ?? 'http://localhost:5620/iframe/debug_inspector.html';
const headless = args.includes('--headless');
const dumpDir = option('--dump');
const perfFrames = option('--perf') ? Number(option('--perf')) : 0;
const perfNext = args[args.indexOf('--perf') + 2];
const perfDir = perfFrames ? (perfNext && !perfNext.startsWith('--') ? perfNext : dumpDir) : undefined;
if (option('--perf') && !(Number.isInteger(perfFrames) && perfFrames >= 1 && perfFrames <= 1000)) {
    console.error('--perf takes a number of frames from 1 to 1000');
    process.exit(1);
}
const perfDumpIndex = args.indexOf('--perf-dump');
const perfDumpNext = perfDumpIndex >= 0 ? args[perfDumpIndex + 1] : undefined;
const perfDumpDir = perfDumpIndex < 0 ? undefined : perfDumpNext && !perfDumpNext.startsWith('--') ? perfDumpNext : dumpDir ?? 'perf-dump';
const wait = args.includes('--wait');
const imagesDir = option('--images') ?? 'screenshots';
const connectUrl = option('--connect');
const executablePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const DEFAULT_CALLS = [
    ['playcanvas_app_summary', {}],
    ['playcanvas_find_entities', { component: 'render', limit: 3 }],
    ['playcanvas_get', { id: '$1.entities.0.$id' }],
    ['playcanvas_get', { id: '$2.render.meshInstances.0.$id' }],
    ['playcanvas_get', { id: '$3.material.$id' }],
    ['playcanvas_list', { kind: 'shaders', limit: 3 }],
    ['playcanvas_list', { kind: 'passes', limit: 5 }],
    ['playcanvas_list', { kind: 'memory', limit: 4 }]
];
const calls = option('--calls') ? JSON.parse(option('--calls')) : dumpDir || perfFrames || perfDumpDir ? [] : DEFAULT_CALLS;

// the series of the Performance tab written to a CSV each
const PERF_SERIES = ['frame', 'cpu', 'gpu', 'draws', 'scripts', 'memory', 'resources', 'counters', 'loading', 'events'];

// the kinds of the index dumped to a file each, and the arguments each object is got with
const DUMP_KINDS = {
    entities: {},
    cameras: {},
    materials: {},
    textures: {},
    shaders: { sources: true },
    meshes: {},
    renderTargets: {},
    scripts: { sources: true },
    assets: {},
    passes: {}
};

// the kinds of id whose objects the dump follows links to, and the file each goes in
const FOLLOWED = {
    node: 'entities',
    component: 'components',
    meshInstance: 'meshInstances',
    material: 'materials',
    texture: 'textures',
    shader: 'shaders',
    mesh: 'meshes',
    renderTarget: 'renderTargets',
    pass: 'passes',
    step: 'passes',
    asset: 'assets',
    script: 'scripts'
};

// the most objects the dump gets for what the lists' objects link to
const MAX_LINKED = 5000;

const DUMP_README = `# PlayCanvas app dump

Written by the PlayCanvas inspector's MCP tools (e2e/webmcp.mjs --dump), from the page at
${url}.

- index.json: playcanvas_index, the summary of the app and every object with its id and figures.
- <kind>.json: every object of a kind, as playcanvas_get returns it, keyed by its $id: entities,
  cameras, materials, textures, shaders (with their sources), meshes, renderTargets, scripts (with
  their sources), assets and passes (the frame graph of one frame).
- memory.json: playcanvas_list of memory, the GPU memory by kind and by buffer.
- meshInstances.json and components.json: what those objects link to that no list holds.

Every link to an entity, component, mesh instance, material, texture, shader, mesh, render target,
pass, asset or script is in one of the files. A link to another object, one of the engine's own
such as a blend state, is a reference only, with its $type and a summary.

A link from one object to another is a reference with its $id, which is the key of that object in
the file of its kind. An entity names its children; each child is in entities.json too. A dump is
one moment of the app: get live figures, such as frame stats, from the running page.
`;

/**
 * @param {*} value - An argument value.
 * @param {any[]} results - The results so far.
 * @returns {*} The value, with "$N.path" strings replaced by values of earlier results.
 */
function resolve(value, results) {
    if (typeof value === 'string' && /^\$\d+(?:\.|$)/.test(value)) {
        const [index, ...path] = value.slice(1).split('.');
        let out = results[Number(index)];
        for (const key of path) out = out?.[key];
        if (out === undefined) throw new Error(`${value} is not in the results`);
        return out;
    }
    if (Array.isArray(value)) return value.map(v => resolve(v, results));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, results)]));
    }
    return value;
}

/**
 * @param {*} json - A result.
 * @returns {string} It printed, with long strings such as shader sources cut short.
 */
function print(json) {
    return JSON.stringify(json, (key, value) => (typeof value === 'string' && value.length > 160 ? `${value.slice(0, 160)}… (${value.length} chars)` : value), 2);
}

/**
 * Runs a function on each item, one after another.
 *
 * @param {any[]} items - The items.
 * @param {(item: any, index: number) => Promise<void>} fn - The function.
 * @returns {Promise<void>} Resolves once the last one is done.
 */
function sequence(items, fn) {
    return items.reduce((previous, item, index) => previous.then(() => fn(item, index)), Promise.resolve());
}

/**
 * Calls a tool through WebMCP, as an agent in the browser does.
 *
 * @param {import('puppeteer-core').Page} page - The page.
 * @param {string} name - The tool name.
 * @param {object} input - The arguments.
 * @returns {Promise<{ result?: any, error?: string, text?: string, ms: number }>} The result, or
 * the error; text is the result as the agent reads it.
 */
async function callTool(page, name, input) {
    const started = Date.now();
    const reply = await page.evaluate(async (toolName, toolInput) => {
        // Chrome takes the RegisteredTool getTools() returns, not its name
        const tool = (await document.modelContext.getTools()).find(t => t.name === toolName);
        if (!tool) return { error: `No WebMCP tool ${toolName}` };
        try {
            return { ok: await document.modelContext.executeTool(tool, toolInput) };
        } catch (e) {
            return { error: `${e?.name}: ${e?.message ?? e}` };
        }
    }, name, input);
    const ms = Date.now() - started;
    if (reply.error) return { error: reply.error, ms };

    // WebMCP hands back what execute returned: an MCP result with the JSON as text, and for a
    // screenshot an image before it
    const raw = typeof reply.ok === 'string' ? JSON.parse(reply.ok) : reply.ok;
    const content = raw?.content ?? [];
    const text = content.find(item => item.type === 'text')?.text;
    if (raw?.isError) return { error: text, ms };
    const result = typeof text === 'string' ? JSON.parse(text) : raw;
    const image = content.find(item => item.type === 'image');
    if (image) result.$image = { mimeType: image.mimeType, data: image.data };
    return { result, text: text ?? '', ms };
}

/**
 * Writes everything the app holds to files, see --dump.
 *
 * @param {import('puppeteer-core').Page} page - The page.
 * @param {string} dir - The directory.
 * @returns {Promise<boolean>} Whether every call succeeded.
 */
async function dump(page, dir) {
    mkdirSync(dir, { recursive: true });
    const started = Date.now();
    let ok = true;
    const written = [];
    const write = (file, json) => {
        const text = JSON.stringify(json, null, 1);
        writeFileSync(join(dir, file), text);
        written.push(`${file} ${(text.length / 1024).toFixed(1)} KB`);
    };

    const index = await callTool(page, 'playcanvas_index', {});
    if (index.error) throw new Error(`playcanvas_index failed: ${index.error}`);
    write('index.json', index.result);

    /** @type {Record<string, Record<string, any>>} */
    const files = {};
    /**
     * Gets objects by id, one after another.
     *
     * @param {string[]} ids - The ids.
     * @param {object} extra - More arguments to get them with.
     * @returns {Promise<[string, any][]>} Each id with its object, or with the error getting it.
     */
    const getAll = async (ids, extra) => {
        const objects = [];
        await sequence(ids, async (id) => {
            const reply = await callTool(page, 'playcanvas_get', { id, ...extra });
            if (reply.error) ok = false;
            objects.push([id, reply.error ? { $error: reply.error } : reply.result]);
        });
        return objects;
    };

    await sequence(Object.entries(DUMP_KINDS), async ([kind, extra]) => {
        // a pass and the light row under it share an id; get each once
        const ids = [...new Set((index.result[kind]?.entries ?? []).map(entry => entry.$id).filter(Boolean))];
        files[kind] = Object.fromEntries(await getAll(ids, extra));
    });

    // what the objects link to but no list holds, such as mesh instances and components, goes in a
    // file per kind of id too, round after round until nothing new is linked, so every link to an
    // object of the app is in one of the files. Other objects, the engine's own, stay references
    const dumped = new Set(Object.values(files).flatMap(objects => Object.keys(objects)));
    let added = 0;
    /**
     * Gets what the objects link to that is not dumped yet, then what that links to.
     *
     * @param {Record<string, any>[]} objects - The objects got last.
     * @returns {Promise<void>} Resolves once nothing new is linked.
     */
    const follow = async (objects) => {
        const linked = new Set();
        JSON.stringify(objects, (key, value) => {
            if (key === '$id' && typeof value === 'string' && FOLLOWED[value.split(':')[0]] && !dumped.has(value)) linked.add(value);
            return value;
        });
        const ids = [...linked].slice(0, MAX_LINKED - added);
        if (!ids.length) return;
        added += ids.length;
        ids.forEach(id => dumped.add(id));
        const got = await getAll(ids, {});
        for (const [id, object] of got) (files[FOLLOWED[id.split(':')[0]]] ??= {})[id] = object;
        await follow(got.map(([, object]) => object));
    };
    await follow(Object.values(files));
    for (const [kind, objects] of Object.entries(files)) write(`${kind}.json`, objects);
    if (added >= MAX_LINKED) console.log(`Stopped following links at ${MAX_LINKED} objects`);

    const memory = await callTool(page, 'playcanvas_list', { kind: 'memory', limit: 500 });
    if (memory.error) ok = false;
    write('memory.json', memory.result ?? { $error: memory.error });
    writeFileSync(join(dir, 'README.md'), DUMP_README);

    console.log(`\nDumped to ${dir} in ${((Date.now() - started) / 1000).toFixed(1)} s:\n  ${written.join('\n  ')}`);
    return ok;
}

/**
 * Records frames through the perf tools, prints their summary and writes the capture to files,
 * see --perf.
 *
 * @param {import('puppeteer-core').Page} page - The page.
 * @param {number} frames - How many frames to record.
 * @param {string|undefined} dir - The directory, or none to only print the summary.
 * @returns {Promise<boolean>} Whether every call succeeded.
 */
async function perf(page, frames, dir) {
    const started = Date.now();
    const status = await callTool(page, 'playcanvas_perf_status', {});
    if (status.error) throw new Error(`playcanvas_perf_status failed: ${status.error}`);
    const { gpuTimingsSupported, scriptTimingSupported } = status.result.options;
    const input = {
        frames,
        clear: true,
        timeout: Math.min(300, Math.max(30, Math.ceil(frames / 10))),
        ...(gpuTimingsSupported ? { gpuTimings: true } : {}),
        ...(scriptTimingSupported ? { scriptTiming: true } : {})
    };
    const record = await callTool(page, 'playcanvas_perf_record', input);
    if (record.error) throw new Error(`playcanvas_perf_record failed: ${record.error}`);
    console.log(`\nplaycanvas_perf_record ${JSON.stringify(input)} (${record.ms} ms, ${record.text.length} chars)\n${print(record.result)}`);
    const summary = record.result.summary;
    if (!dir || !summary) return !!summary;
    return writeCapture(page, summary, dir, started);
}

/**
 * Writes the capture the Performance tab holds to files, without recording, see --perf-dump.
 *
 * @param {import('puppeteer-core').Page} page - The page.
 * @param {string} dir - The directory.
 * @returns {Promise<boolean>} Whether every call succeeded.
 */
async function perfDump(page, dir) {
    const started = Date.now();
    const status = await callTool(page, 'playcanvas_perf_status', {});
    if (status.error) throw new Error(`playcanvas_perf_status failed: ${status.error}`);
    console.log(`\nplaycanvas_perf_status\n${print(status.result)}`);
    // a capture still recording is written up to the frame summarized, and keeps recording
    const summary = await callTool(page, 'playcanvas_perf_summary', {});
    if (summary.error) throw new Error(`No capture to write: ${summary.error}`);
    return writeCapture(page, summary.result, dir, started);
}

/**
 * Writes a capture to files: capture.json, summary.json and a CSV per series.
 *
 * @param {import('puppeteer-core').Page} page - The page.
 * @param {any} summary - The summary of the frames to write, which says their range.
 * @param {string} dir - The directory.
 * @param {number} started - When the work began, for the time it took.
 * @returns {Promise<boolean>} Whether every call succeeded.
 */
async function writeCapture(page, summary, dir, started) {
    mkdirSync(dir, { recursive: true });
    let ok = true;
    const written = [];
    const write = (file, text) => {
        writeFileSync(join(dir, file), text);
        written.push(`${file} ${(text.length / 1024).toFixed(1)} KB`);
    };

    // the capture as the panel copies it: the header the summary starts with, then every frame
    const { range, medianFrame, displayInterval, engineBuild, gpuTimingsExact, clockStep, device } = summary;
    const capture = { range, medianFrame, displayInterval, engineBuild, gpuTimingsExact, ...(clockStep ? { clockStep } : {}), device, frames: [] };
    const numbers = Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i);
    await sequence(numbers, async (frame) => {
        const reply = await callTool(page, 'playcanvas_perf_frame', { frame });
        if (reply.error) ok = false;
        capture.frames.push(reply.error ? { frame, $error: reply.error } : reply.result);
    });
    write('capture.json', JSON.stringify(capture, null, 1));

    // each series a page of rows at a time, written as one CSV with the columns of every page
    await sequence(PERF_SERIES, async (key) => {
        const rows = [];
        const readFrom = async (from) => {
            const reply = await callTool(page, 'playcanvas_perf_series', { key, from, to: range.to });
            if (reply.error) {
                ok = false;
                console.log(`playcanvas_perf_series ${key} failed: ${reply.error}`);
                return;
            }
            rows.push(...reply.result.rows);
            if (reply.result.next !== undefined) await readFrom(reply.result.next);
        };
        await readFrom(range.from);
        if (rows.length) write(`series-${key}.csv`, toCsv(rows));
    });
    write('summary.json', JSON.stringify(summary, null, 1));

    console.log(`\nWrote the capture to ${dir} in ${((Date.now() - started) / 1000).toFixed(1)} s:\n  ${written.join('\n  ')}`);
    return ok;
}

/**
 * @param {import('puppeteer-core').Browser} running - A Chrome connected to.
 * @returns {Promise<import('puppeteer-core').Page>} Its tab whose URL contains --url's value when
 * given, else its first tab with an inspector.
 */
async function findPage(running) {
    const pages = await running.pages();
    const wanted = option('--url');
    if (wanted) {
        const page = pages.find(p => p.url().includes(wanted));
        if (!page) throw new Error(`No tab's URL contains ${wanted}: ${pages.map(p => p.url()).join(', ')}`);
        return page;
    }
    const found = await Promise.all(pages.map(p => p.evaluate(() => !!document.querySelector('.pc-inspector')).catch(() => false)));
    const page = pages[found.indexOf(true)];
    if (!page) throw new Error(`No tab has an inspector: ${pages.map(p => p.url()).join(', ')}`);
    return page;
}

/**
 * @returns {Promise<void>} Resolves once Enter is pressed in the terminal.
 */
function enterPressed() {
    return new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', () => {
            process.stdin.pause();
            resolve();
        });
    });
}

const browser = connectUrl ? await connect({ browserURL: connectUrl, defaultViewport: null }) : await launch({
    executablePath,
    headless: headless && !wait,
    args: ['--enable-features=WebMCP', '--window-size=1400,900']
});

let failed = false;
try {
    let page;
    if (connectUrl) {
        page = await findPage(browser);
        console.log(`Using the tab at ${page.url()}`);
    } else {
        page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        await page.goto(url, { waitUntil: 'load' });
    }
    page.on('pageerror', e => console.error(`[page error] ${e.message}`));

    if (!await page.evaluate(() => typeof document.modelContext?.getTools === 'function')) {
        throw new Error('This Chrome has no WebMCP (document.modelContext)');
    }

    // the inspector's panel, then its MCP switch, pressed the way a user presses it
    await page.waitForFunction(() => document.querySelector('.pc-inspector')?.shadowRoot?.querySelector('.pci-mcp'), { timeout: 60000 });
    const wasOn = await page.evaluate(() => {
        const button = document.querySelector('.pc-inspector').shadowRoot.querySelector('.pci-mcp');
        const on = button.classList.contains('pci-active');
        if (!on) button.click();
        return on;
    });
    console.log(`MCP switch: ${wasOn ? 'already on' : 'pressed'}`);

    if (wait) {
        console.log('\nRecord on the Performance tab in the window (Record, then Record again to stop), then press Enter here.');
        await enterPressed();
    }

    await page.waitForFunction(async () => (await document.modelContext.getTools()).some(t => t.name.startsWith('playcanvas_')), { timeout: 10000 });
    const tools = await page.evaluate(async () => (await document.modelContext.getTools()).map(t => ({
        name: t.name,
        readOnly: t.annotations?.readOnlyHint,
        params: Object.keys((typeof t.inputSchema === 'string' ? JSON.parse(t.inputSchema) : t.inputSchema)?.properties ?? {})
    })));
    console.log(`\nWebMCP tools registered by the page:\n${print(tools)}`);

    if (dumpDir && !await dump(page, dumpDir)) failed = true;
    if (perfFrames && !await perf(page, perfFrames, perfDir)) failed = true;
    if (perfDumpDir && !await perfDump(page, perfDumpDir)) failed = true;

    const results = [];
    await sequence(calls, async ([name, rawInput], index) => {
        const input = resolve(rawInput ?? {}, results);
        const reply = await callTool(page, name, input);
        results.push(reply.result);
        if (reply.error) {
            failed = true;
            console.log(`\n#${index} ${name} ${JSON.stringify(input)} failed in ${reply.ms} ms: ${reply.error}`);
            return;
        }
        // an image is written to a file, and named rather than printed
        const image = reply.result.$image;
        if (image) {
            mkdirSync(imagesDir, { recursive: true });
            const label = (reply.result.source?.name ?? reply.result.source?.kind ?? 'image').replace(/[^\w.-]+/g, '_');
            const file = join(imagesDir, `${String(index).padStart(2, '0')}-${label}${reply.result.source?.attachment ? `-${reply.result.source.attachment}` : ''}.png`);
            writeFileSync(file, Buffer.from(image.data, 'base64'));
            reply.result.$image = `${file} (${(image.data.length * 0.75 / 1024).toFixed(1)} KB)`;
        }
        console.log(`\n#${index} ${name} ${JSON.stringify(input)} (${reply.ms} ms, ${reply.text.length} chars)\n${print(reply.result)}`);
    });
} catch (e) {
    failed = true;
    console.error(`\nFAILED: ${e?.message ?? e}`);
} finally {
    // a Chrome connected to is the user's, and keeps running
    if (connectUrl) await browser.disconnect();
    else await browser.close();
}
process.exit(failed ? 1 : 0);
