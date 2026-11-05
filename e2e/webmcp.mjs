// Drives the inspector's MCP tools through Chrome's own WebMCP, the way an agent in the browser
// would: launches system Chrome with WebMCP enabled, opens a page running an app with the
// inspector, presses the MCP switch in the status bar, then lists the tools the page registered
// with document.modelContext and calls them.
//
// node e2e/webmcp.mjs [--url <page>] [--headless] [--calls '<json>'] [--dump <dir>]
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
// --headless Run Chrome without a window.
//
// Needs Chrome 150+ (WebMCP behind --enable-features=WebMCP). Set CHROME_PATH to use another build.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch } from 'puppeteer-core';

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};

const url = option('--url') ?? 'http://localhost:5620/iframe/debug_inspector.html';
const headless = args.includes('--headless');
const dumpDir = option('--dump');
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
const calls = option('--calls') ? JSON.parse(option('--calls')) : dumpDir ? [] : DEFAULT_CALLS;

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

    // WebMCP hands back what execute returned: an MCP result with the JSON as text
    const raw = typeof reply.ok === 'string' ? JSON.parse(reply.ok) : reply.ok;
    const text = raw?.content?.[0]?.text;
    if (raw?.isError) return { error: text, ms };
    return { result: typeof text === 'string' ? JSON.parse(text) : raw, text: text ?? '', ms };
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

const browser = await launch({
    executablePath,
    headless,
    args: ['--enable-features=WebMCP', '--window-size=1400,900']
});

let failed = false;
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => console.error(`[page error] ${e.message}`));
    await page.goto(url, { waitUntil: 'load' });

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

    await page.waitForFunction(async () => (await document.modelContext.getTools()).some(t => t.name.startsWith('playcanvas_')), { timeout: 10000 });
    const tools = await page.evaluate(async () => (await document.modelContext.getTools()).map(t => ({
        name: t.name,
        readOnly: t.annotations?.readOnlyHint,
        params: Object.keys((typeof t.inputSchema === 'string' ? JSON.parse(t.inputSchema) : t.inputSchema)?.properties ?? {})
    })));
    console.log(`\nWebMCP tools registered by the page:\n${print(tools)}`);

    if (dumpDir && !await dump(page, dumpDir)) failed = true;

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
        console.log(`\n#${index} ${name} ${JSON.stringify(input)} (${reply.ms} ms, ${reply.text.length} chars)\n${print(reply.result)}`);
    });
} catch (e) {
    failed = true;
    console.error(`\nFAILED: ${e?.message ?? e}`);
} finally {
    await browser.close();
}
process.exit(failed ? 1 : 0);
