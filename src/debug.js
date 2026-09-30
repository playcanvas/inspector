/**
 * Stand-ins for the engine's `Debug` and `DebugGraphics`, which it does not export, used by the
 * helpers copied from the engine (see COPIED_FROM.md) so those stay close to their originals.
 * Assertions and GPU markers are dropped, as a release engine build drops them; warnings print
 * once each.
 */

/** @type {Set<string>} */
const warned = new Set();

/**
 * @param {string} message - The message.
 */
const warnOnce = (message) => {
    if (warned.has(message)) return;
    warned.add(message);
    console.warn(message);
};

const Debug = {
    assert() {},
    warnOnce,
    errorOnce: warnOnce
};

const DebugGraphics = {
    pushGpuMarker() {},
    popGpuMarker() {}
};

export { Debug, DebugGraphics };
