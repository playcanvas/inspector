/**
 * One muted tone per nesting level, cycling, for the indent guides of the property view, so a
 * nested row can be read back to its parent.
 *
 * @type {string[]}
 */
const INDENT_COLORS = ['#3f4a5f', '#4a4459', '#3f5450', '#55503f'];

/**
 * The same tones brighter, for the brackets of the lists. A bracket is the only thing telling which
 * rows belong together there, so it has to read without indentation to back it up.
 *
 * @type {string[]}
 */
const BRACKET_COLORS = ['#6a7fa8', '#8a76a8', '#62968a', '#a39564'];

/**
 * The line icons of the toolbar, as the contents of a 24x24 SVG drawn with a 2px round stroke, in
 * the style of the icons of the examples browser.
 *
 * @type {Record<string, string>}
 */
const ICONS = {
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    step: '<path d="M5 4.5v15l10-7.5z"/><path d="M19 5v14"/>',
    pick: '<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z"/>',
    orbit: '<circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><path d="M10.4 21.9a10 10 0 0 0 9.94-15.42"/><path d="M13.5 2.1a10 10 0 0 0-9.84 15.42"/>',
    fly: '<path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.87a.5.5 0 0 0-.75-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    popout: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    dock: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>'
};

/**
 * A rule per icon, setting the mask the icon buttons draw in their text color.
 *
 * @type {string}
 */
const ICON_RULES = Object.entries(ICONS).map(([name, body]) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    return `    .pci-i-${name} { --pci-icon: url("data:image/svg+xml,${encodeURIComponent(svg)}"); }`;
}).join('\n');

/**
 * Stylesheet for the entity inspector panel. Injected into the panel's shadow root, so nothing
 * here leaks into the page and nothing in the page leaks in. Its palette matches the examples
 * browser.
 *
 * @type {string}
 */
const styles = /* css */ `
    :host {
        all: initial;
        display: block;
        /* native controls (selects, checkboxes) in their dark form */
        color-scheme: dark;

        --pci-font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        --pci-mono: ui-monospace, Menlo, Consolas, "Liberation Mono", monospace;
        --pci-bg: #182022;
        --pci-bar: #13191b;
        --pci-raised: #1f282a;
        --pci-input: #121819;
        --pci-hover: rgba(255, 255, 255, 0.06);
        --pci-pressed: rgba(255, 255, 255, 0.1);
        --pci-border: rgba(255, 255, 255, 0.07);
        --pci-border-strong: rgba(255, 255, 255, 0.12);
        --pci-text: #eef2f3;
        --pci-text-body: #dbe2e4;
        --pci-text-secondary: #b9c4c7;
        --pci-text-label: #93a2a6;
        --pci-text-muted: #7f8f93;
        --pci-text-faint: #56656a;
        --pci-accent: #ff6600;
        --pci-accent-text: #ff8a3c;
        --pci-accent-soft: rgba(255, 102, 0, 0.14);
        --pci-accent-strong: rgba(255, 102, 0, 0.24);
        --pci-selected: rgba(255, 102, 0, 0.16);
        --pci-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }

    ::-webkit-scrollbar {
        width: 10px;
        height: 10px;
    }

    ::-webkit-scrollbar-track,
    ::-webkit-scrollbar-corner {
        background: transparent;
    }

    ::-webkit-scrollbar-thumb {
        border: 3px solid transparent;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.14) padding-box;
    }

    ::-webkit-scrollbar-thumb:hover {
        background-color: rgba(255, 255, 255, 0.26);
    }

    @supports not selector(::-webkit-scrollbar) {
        * {
            scrollbar-width: thin;
            scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
        }
    }

    * {
        box-sizing: border-box;
    }

    .pci-panel {
        position: fixed;
        top: 0;
        bottom: 0;
        right: 0;
        width: 420px;
        z-index: 100000;
        display: flex;
        flex-direction: column;
        background: var(--pci-bg);
        color: var(--pci-text-body);
        font: 12px/1.45 var(--pci-font);
        border-left: 1px solid var(--pci-border-strong);
        box-shadow: -6px 0 18px rgba(0, 0, 0, 0.35);
        user-select: none;
        -webkit-user-select: none;
    }

    .pci-panel.pci-dock-left {
        right: auto;
        left: 0;
        border-left: none;
        border-right: 1px solid var(--pci-border-strong);
        box-shadow: 6px 0 18px rgba(0, 0, 0, 0.35);
    }

    .pci-panel.pci-popout {
        left: 0;
        right: 0;
        width: auto !important;
        border: none;
        box-shadow: none;
    }

    .pci-edge {
        position: absolute;
        top: 0;
        bottom: 0;
        left: -3px;
        width: 6px;
        cursor: ew-resize;
    }

    .pci-dock-left .pci-edge {
        left: auto;
        right: -3px;
    }

    .pci-popout .pci-edge {
        display: none;
    }

    .pci-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 2px;
        padding: 6px 6px 6px 12px;
        background: var(--pci-bar);
        border-bottom: 1px solid var(--pci-border);
        flex: 0 0 auto;
    }

    .pci-toolbar .pci-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--pci-text);
        margin-right: 10px;
        white-space: nowrap;
    }

    .pci-toolbar .pci-spacer {
        flex: 1 1 auto;
    }

    .pci-toolbar .pci-sep {
        flex: 0 0 1px;
        align-self: stretch;
        margin: 6px 5px;
        background: var(--pci-border-strong);
    }

    .pci-btn {
        font: inherit;
        font-weight: 500;
        color: var(--pci-text-secondary);
        background: rgba(255, 255, 255, 0.07);
        border: none;
        border-radius: 6px;
        padding: 3px 10px;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 100ms, color 100ms;
    }

    .pci-btn:not(:disabled):hover {
        background: var(--pci-pressed);
        color: var(--pci-text);
    }

    .pci-btn:focus-visible {
        outline: 2px solid var(--pci-accent);
        outline-offset: -2px;
    }

    .pci-btn:disabled {
        opacity: 0.35;
        cursor: default;
    }

    .pci-btn.pci-active,
    .pci-btn.pci-active:not(:disabled):hover {
        background: var(--pci-accent-soft);
        color: var(--pci-accent-text);
    }

    .pci-btn.pci-active:not(:disabled):hover {
        background: var(--pci-accent-strong);
    }

    .pci-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border-radius: 8px;
        background: transparent;
    }

    .pci-icon-btn::before {
        content: "";
        width: 17px;
        height: 17px;
        background-color: currentColor;
        -webkit-mask: var(--pci-icon) center / contain no-repeat;
        mask: var(--pci-icon) center / contain no-repeat;
    }

    .pci-icon-btn.pci-warn,
    .pci-icon-btn.pci-warn:not(:disabled):hover {
        background: rgba(241, 76, 76, 0.16);
        color: #ff8f8f;
    }

${ICON_RULES}

    .pci-body {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        min-height: 0;
    }

    .pci-hierarchy {
        flex: 0 0 45%;
        display: flex;
        flex-direction: column;
        min-height: 60px;
    }

    .pci-filter {
        flex: 0 0 auto;
        display: flex;
        gap: 6px;
        padding: 8px;
        border-bottom: 1px solid var(--pci-border);
    }

    .pci-filter input {
        flex: 1 1 auto;
        min-width: 0;
        font: inherit;
        color: var(--pci-text);
        background: var(--pci-input);
        border: 1px solid var(--pci-border-strong);
        border-radius: 999px;
        padding: 4px 12px;
        outline: none;
        user-select: text;
        -webkit-user-select: text;
        transition: border-color 100ms, box-shadow 100ms;
    }

    .pci-filter input::placeholder {
        color: var(--pci-text-muted);
    }

    .pci-filter input:focus {
        border-color: var(--pci-accent);
        box-shadow: 0 0 0 3px var(--pci-accent-soft);
    }

    .pci-tabs {
        flex: 0 0 auto;
        display: flex;
        flex-wrap: wrap;
        gap: 2px;
        margin: 8px;
        padding: 3px;
        background: var(--pci-input);
        border: 1px solid var(--pci-border);
        border-radius: 9px;
    }

    .pci-tab {
        font: inherit;
        font-weight: 500;
        color: var(--pci-text-muted);
        background: transparent;
        border: none;
        border-radius: 6px;
        padding: 3px 9px;
        white-space: nowrap;
        cursor: pointer;
        transition: background-color 100ms, color 100ms;
    }

    .pci-tab:hover {
        color: var(--pci-text);
        background: var(--pci-hover);
    }

    .pci-tab.pci-active,
    .pci-tab.pci-active:hover {
        color: var(--pci-text);
        background: var(--pci-pressed);
    }

    .pci-listpanel {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        min-height: 0;
    }

    .pci-subbar {
        flex: 0 0 auto;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 14px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--pci-border);
        color: var(--pci-text-secondary);
        font-size: 11px;
    }

    .pci-subbar.pci-wrap {
        flex-wrap: wrap;
        row-gap: 4px;
    }

    .pci-tip {
        display: none;
        position: fixed;
        z-index: 2;
        max-width: 320px;
        padding: 5px 8px;
        background: var(--pci-raised);
        color: var(--pci-text);
        border: 1px solid var(--pci-border-strong);
        border-radius: 6px;
        box-shadow: var(--pci-shadow);
        white-space: pre-line;
        overflow-wrap: anywhere;
        pointer-events: none;
    }

    .pci-check {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        cursor: pointer;
        white-space: nowrap;
    }

    .pci-check input.pci-number {
        width: 54px;
        height: auto;
        font: inherit;
        color: var(--pci-text);
        background: var(--pci-input);
        border: 1px solid var(--pci-border-strong);
        border-radius: 5px;
        padding: 1px 4px;
        outline: none;
        user-select: text;
        -webkit-user-select: text;
    }

    .pci-number:focus {
        border-color: var(--pci-accent);
    }

    .pci-note {
        flex: 0 0 auto;
        padding: 6px 8px;
        border-bottom: 1px solid var(--pci-border);
        color: #ffb4b4;
        font-size: 11px;
    }

    .pci-note.pci-note-info {
        color: var(--pci-text-label);
    }

    .pci-select {
        font: inherit;
        color: var(--pci-text);
        background: var(--pci-input);
        border: 1px solid var(--pci-border-strong);
        border-radius: 5px;
        padding: 2px 6px;
        outline: none;
    }

    .pci-select:focus {
        border-color: var(--pci-accent);
    }

    .pci-check input {
        width: 12px;
        height: 12px;
        margin: 0;
        accent-color: var(--pci-accent);
    }

    .pci-check.pci-strong {
        color: var(--pci-text);
        font-weight: 600;
    }

    .pci-subbar.pci-master {
        gap: 10px;
    }

    .pci-subbar .pci-hint {
        color: var(--pci-text-muted);
    }

    .pci-subbar.pci-options {
        margin-left: 12px;
        border-left: 2px solid var(--pci-border-strong);
    }

    .pci-subbar.pci-inactive {
        opacity: 0.45;
    }

    .pci-cell-toggle {
        flex: 0 0 auto;
        width: 12px;
        height: 12px;
        margin: 0;
        accent-color: var(--pci-accent);
        cursor: pointer;
    }

    .pci-cell-toggle:disabled {
        cursor: default;
    }

    .pci-cell-spacer {
        flex: 0 0 12px;
    }

    .pci-list {
        flex: 1 1 auto;
        overflow: auto;
        padding: 4px 0;
    }

    .pci-lrow {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 20px;
        padding-right: 8px;
        white-space: nowrap;
        cursor: pointer;
    }

    .pci-lrow:hover {
        background-color: var(--pci-hover);
    }

    .pci-lrow.pci-selected {
        background-color: var(--pci-selected);
        color: #ffffff;
    }

    .pci-lrow.pci-dim .pci-cell-name,
    .pci-lrow.pci-dim .pci-cell-info {
        opacity: 0.45;
    }

    /* the head of a group of rows, which opens and closes it */
    .pci-lrow.pci-lrow-header {
        background-color: var(--pci-raised);
        color: var(--pci-text);
        font-weight: 600;
    }

    .pci-lrow.pci-lrow-header ~ .pci-lrow.pci-lrow-header {
        border-top: 1px solid var(--pci-border);
    }

    .pci-lrow.pci-lrow-header::before {
        content: "▸";
        flex: 0 0 10px;
        color: var(--pci-text-label);
        font-size: 12px;
    }

    .pci-lrow.pci-lrow-header.pci-open::before {
        content: "▾";
    }

    .pci-lrow.pci-lrow-header.pci-leaf::before {
        content: "";
    }

    .pci-lrow.pci-lrow-header:hover {
        background-color: #263133;
    }

    /* rows that only show figures, and headers with nothing to open */
    .pci-lrow.pci-inert,
    .pci-lrow.pci-lrow-header.pci-leaf {
        cursor: default;
    }

    .pci-lrow.pci-inert:hover {
        background-color: transparent;
    }

    .pci-lrow.pci-lrow-header.pci-leaf:hover {
        background-color: var(--pci-raised);
    }

    /* a count and a size in columns of their own, lining up from row to row */
    .pci-cell-count {
        flex-shrink: 0;
        margin-left: auto;
        min-width: 5ch;
        text-align: right;
        color: var(--pci-text-label);
        font-family: var(--pci-mono);
        font-size: 10.5px;
        font-weight: normal;
    }

    .pci-cell-size {
        flex-shrink: 0;
        min-width: 11ch;
        text-align: right;
        font-family: var(--pci-mono);
        font-size: 10.5px;
    }

    .pci-cell {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .pci-cell-index {
        flex: 0 0 22px;
        text-align: right;
        color: var(--pci-text-muted);
        font-family: var(--pci-mono);
        font-size: 10.5px;
    }

    .pci-cell-name {
        flex-shrink: 0;
        /* long generated names (shaders) truncate rather than push the other cells out of view */
        max-width: 60%;
    }

    .pci-cell-info {
        color: var(--pci-text-label);
        font-family: var(--pci-mono);
        font-size: 10.5px;
    }

    .pci-lrow.pci-selected .pci-cell-info {
        color: var(--pci-text-secondary);
    }

    .pci-cell-right {
        margin-left: auto;
        flex-shrink: 0;
    }

    .pci-cell-time {
        flex-shrink: 0;
        margin-left: auto;
        color: #b5cea8;
        font-family: var(--pci-mono);
        font-size: 10.5px;
    }

    .pci-cell-tag {
        flex-shrink: 0;
        font-size: 9.5px;
        line-height: 13px;
        padding: 0 4px;
        border-radius: 4px;
        background: #5a2a2a;
        color: #ffb4b4;
    }

    .pci-cell-tag-info {
        background: rgba(255, 255, 255, 0.07);
        color: var(--pci-text-secondary);
    }

    .pci-cell.pci-link {
        text-decoration: underline dotted;
    }

    .pci-cell.pci-link:hover {
        color: #9ad7ff;
    }

    .pci-tree {
        flex: 1 1 auto;
        overflow: auto;
        padding: 4px 0;
    }

    .pci-row {
        display: flex;
        align-items: center;
        gap: 4px;
        height: 20px;
        padding-right: 8px;
        white-space: nowrap;
        cursor: pointer;
    }

    .pci-row:hover {
        background: var(--pci-hover);
    }

    .pci-row.pci-selected {
        background: var(--pci-selected);
        color: #ffffff;
    }

    .pci-row.pci-disabled .pci-name {
        opacity: 0.45;
    }

    .pci-row.pci-graphnode .pci-name {
        font-style: italic;
        color: var(--pci-text-secondary);
    }

    .pci-row.pci-match .pci-name {
        color: #ffd28a;
    }

    .pci-arrow {
        flex: 0 0 12px;
        width: 12px;
        text-align: center;
        color: var(--pci-text-muted);
        font-size: 11px;
    }

    .pci-toggle {
        flex: 0 0 auto;
        width: 12px;
        height: 12px;
        margin: 0 3px 0 0;
        accent-color: var(--pci-accent);
        cursor: pointer;
    }

    .pci-name {
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .pci-badges {
        display: inline-flex;
        gap: 3px;
        margin-left: 4px;
    }

    .pci-badge {
        font-size: 9.5px;
        line-height: 13px;
        padding: 0 4px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.07);
        color: var(--pci-text-secondary);
    }

    .pci-selected .pci-badge {
        background: var(--pci-accent-strong);
        color: var(--pci-text);
    }

    .pci-count {
        margin-left: auto;
        min-width: 4ch;
        text-align: right;
        color: var(--pci-text-muted);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
    }

    /* the whole subtree, in its own column after the children, dimmer */
    .pci-count.pci-count-total {
        margin-left: 6px;
        min-width: 6ch;
        color: var(--pci-text-faint);
    }

    .pci-splitter {
        flex: 0 0 5px;
        background: var(--pci-raised);
        border-top: 1px solid var(--pci-border-strong);
        border-bottom: 1px solid var(--pci-border-strong);
        cursor: ns-resize;
    }

    .pci-properties {
        flex: 1 1 auto;
        overflow: auto;
        padding-bottom: 8px;
        font-family: var(--pci-mono);
        font-size: 11px;
    }

    .pci-empty {
        padding: 12px 10px;
        color: var(--pci-text-muted);
        font-family: var(--pci-font);
        font-size: 12px;
    }

    .pci-section-title {
        position: sticky;
        top: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        margin-top: 4px;
        background: var(--pci-raised);
        color: var(--pci-text);
        font-family: var(--pci-font);
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        z-index: 1;
    }

    .pci-section-title::before {
        content: "▾";
        color: var(--pci-text-muted);
        font-size: 10px;
    }

    .pci-collapsed .pci-section-title::before {
        content: "▸";
    }

    .pci-collapsed .pci-rows {
        display: none;
    }

    .pci-prop {
        display: flex;
        gap: 8px;
        padding: 1px 8px;
        line-height: 17px;
    }

    .pci-prop:hover {
        background-color: var(--pci-hover);
    }

    /* an entry of an expanded collection, and everything it opens, reads as one block */
    .pci-prop.pci-group {
        border-top: 1px solid var(--pci-border-strong);
        margin-top: 2px;
        padding-top: 2px;
    }

    /* the last row a collection's final entry opened, closing the block */
    .pci-prop.pci-group-end {
        border-bottom: 1px solid var(--pci-border-strong);
        margin-bottom: 2px;
        padding-bottom: 2px;
    }


    .pci-label {
        flex: 0 0 38%;
        color: var(--pci-text-label);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pci-indent .pci-label {
        flex-basis: calc(38% - 14px);
    }

    .pci-value {
        flex: 1 1 auto;
        min-width: 0;
        color: var(--pci-text-body);
        white-space: pre-wrap;
        word-break: break-word;
        user-select: text;
        -webkit-user-select: text;
    }

    .pci-v-num  { color: #b5cea8; }
    .pci-v-bool { color: #569cd6; }
    .pci-v-str  { color: #ce9178; }
    .pci-v-null { color: var(--pci-text-muted); }
    .pci-v-obj  { color: #dcdcaa; }
    .pci-v-ref  { color: #4fc1ff; }
    .pci-v-err  { color: #f14c4c; }

    .pci-link {
        cursor: pointer;
        text-decoration: underline dotted;
    }

    .pci-link:hover {
        color: #9ad7ff;
    }

    .pci-expandable .pci-value, .pci-prop.pci-selectable {
        cursor: pointer;
    }

    .pci-selectable .pci-caret:hover {
        color: #ffffff;
    }

    .pci-prop.pci-active {
        background-color: var(--pci-selected);
    }

    .pci-prop.pci-active .pci-value {
        color: #ffffff;
    }

    .pci-expandable .pci-value:hover {
        color: #ffffff;
    }

    .pci-actions {
        display: inline-flex;
        gap: 4px;
        flex: 0 0 auto;
    }

    .pci-action:disabled {
        opacity: 0.35;
        cursor: default;
    }

    .pci-copy, .pci-action {
        flex: 0 0 auto;
        font: inherit;
        font-size: 10px;
        line-height: 14px;
        padding: 0 6px;
        color: var(--pci-text-secondary);
        background: rgba(255, 255, 255, 0.07);
        border: none;
        border-radius: 4px;
        cursor: pointer;
    }

    .pci-copy:hover, .pci-action:not(:disabled):hover {
        color: #ffffff;
        background: var(--pci-selected);
    }

    .pci-code {
        margin: 2px 8px 6px 8px;
        /* the left margin is set per row, to line the block up with the row that opened it */
        padding: 6px 0;
        max-height: 360px;
        overflow: auto;
        background: var(--pci-input);
        border: 1px solid var(--pci-border);
        border-radius: 6px;
        font-family: var(--pci-mono);
        font-size: 10.5px;
        line-height: 15px;
        color: #d4d4d4;
        tab-size: 4;
        counter-reset: line;
        user-select: text;
        -webkit-user-select: text;
    }

    .pci-code-line {
        display: block;
        white-space: pre;
        padding-right: 8px;
        counter-increment: line;
    }

    .pci-code-line::before {
        content: counter(line);
        display: inline-block;
        width: 3.5em;
        margin-right: 10px;
        padding-right: 6px;
        text-align: right;
        color: var(--pci-text-faint);
        border-right: 1px solid var(--pci-border);
        user-select: none;
        -webkit-user-select: none;
    }

    .pci-swatch {
        display: inline-block;
        width: 10px;
        height: 10px;
        margin-right: 5px;
        vertical-align: -1px;
        border: 1px solid #55595f;
        border-radius: 2px;
    }

    .pci-status {
        flex: 0 0 auto;
        display: flex;
        gap: 10px;
        padding: 4px 8px;
        background: var(--pci-raised);
        border-top: 1px solid var(--pci-border-strong);
        color: var(--pci-text-muted);
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
    }

    .pci-status .pci-paused {
        color: var(--pci-accent);
        font-weight: 600;
    }

    .pci-status .pci-path {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: right;
    }
`;

export { BRACKET_COLORS, INDENT_COLORS, styles };
