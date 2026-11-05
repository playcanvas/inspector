// Drives the inspector's MCP tools through Chrome's own WebMCP, the way an agent in the browser
// would: launches system Chrome with WebMCP enabled, opens a page running an app with the
// inspector, presses the MCP switch in the status bar, then lists the tools the page registered
// with document.modelContext and calls them.
//
// node e2e/webmcp.mjs [--url <page>] [--headless] [--calls '<json>']
//
// --url      A page whose app has an Inspector. Defaults to the inspector example of the engine's
//            examples browser on port 5620, opened without the browser around it.
// --calls    A JSON array of [toolName, arguments] pairs to call in order. A string argument value
//            of the form "$N.path.to.value" is replaced by that value of the result of call N
//            (0-based), so ids found by one call can be passed to the next. Without it, a walk from
//            a rendered entity to its shader and back runs.
// --headless Run Chrome without a window.
//
// Needs Chrome 150+ (WebMCP behind --enable-features=WebMCP). Set CHROME_PATH to use another build.

import { launch } from 'puppeteer-core';

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};

const url = option('--url') ?? 'http://localhost:5620/iframe/debug_inspector.html';
const headless = args.includes('--headless');
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
const calls = option('--calls') ? JSON.parse(option('--calls')) : DEFAULT_CALLS;

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

    const results = [];
    /**
     * Calls a tool through WebMCP and prints what it returned.
     *
     * @param {[string, object]} call - The tool name and its arguments.
     * @param {number} index - Which call it is.
     */
    const run = async ([name, rawInput], index) => {
        const input = resolve(rawInput ?? {}, results);
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

        if (reply.error) {
            failed = true;
            console.log(`\n#${index} ${name} ${JSON.stringify(input)} FAILED in ${ms} ms: ${reply.error}`);
            results.push(undefined);
            return;
        }
        // WebMCP hands back what execute returned: an MCP result with the JSON as text
        const raw = typeof reply.ok === 'string' ? JSON.parse(reply.ok) : reply.ok;
        const text = raw?.content?.[0]?.text;
        if (raw?.isError) {
            failed = true;
            console.log(`\n#${index} ${name} ${JSON.stringify(input)} returned an error in ${ms} ms: ${text}`);
            results.push(undefined);
            return;
        }
        const result = typeof text === 'string' ? JSON.parse(text) : raw;
        results.push(result);
        console.log(`\n#${index} ${name} ${JSON.stringify(input)} (${ms} ms, ${(text ?? '').length} chars)\n${print(result)}`);
    };
    // one after another, as a call can use the results of the calls before it
    await calls.reduce((previous, call, index) => previous.then(() => run(call, index)), Promise.resolve());
} catch (e) {
    failed = true;
    console.error(`\nFAILED: ${e?.message ?? e}`);
} finally {
    await browser.close();
}
process.exit(failed ? 1 : 0);
