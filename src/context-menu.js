import { setTip } from './tooltip.js';

/**
 * An entry of a context menu.
 *
 * @typedef {object} MenuItem
 * @ignore
 * @property {() => string} text - The text, read again whenever the entry redraws.
 * @property {() => void} run - Called when the entry is chosen, once the menu has closed.
 * @property {string} [title] - The tooltip.
 * @property {MenuButton[]} [buttons] - Small buttons at the end of the entry, which change the
 * entry without choosing it or closing the menu.
 */

/**
 * @typedef {object} MenuButton
 * @ignore
 * @property {string} text - The text.
 * @property {string} title - The tooltip.
 * @property {() => boolean} disabled - Whether it is disabled, read again whenever it redraws.
 * @property {() => void} run - Called when it is clicked.
 */

// milliseconds a note stays up
const NOTE_TIME = 2500;

/**
 * @param {string} tag - The element tag.
 * @param {string} className - The class name.
 * @param {string} [text] - The text content.
 * @returns {HTMLElement} The element.
 */
function el(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

/**
 * A menu opened where the pointer is, and a note shown briefly at the bottom of the panel, such as
 * for what was copied. Both live in the panel, so they move with it into a popped-out window. The
 * menu closes on a choice, a press anywhere outside it, Escape, scrolling and leaving the window.
 *
 * @ignore
 */
class ContextMenu {
    /**
     * @type {HTMLElement}
     * @private
     */
    _panel;

    /**
     * @type {HTMLElement}
     * @private
     */
    _menu;

    /**
     * @type {HTMLElement}
     * @private
     */
    _note;

    /**
     * @type {number}
     * @private
     */
    _noteTimer = 0;

    /**
     * The document the closing listeners are on while the menu is open.
     *
     * @type {Document|null}
     * @private
     */
    _doc = null;

    /**
     * @param {HTMLElement} panel - The panel to show the menu and notes in.
     */
    constructor(panel) {
        this._panel = panel;
        this._menu = el('div', 'pci-menu');
        this._menu.setAttribute('role', 'menu');
        this._note = el('div', 'pci-toast');
        panel.append(this._menu, this._note);
    }

    /**
     * Whether the menu is open.
     *
     * @type {boolean}
     */
    get open() {
        return this._doc !== null;
    }

    /**
     * Opens the menu at a point, in place of any menu already open.
     *
     * @param {number} x - The point, in client pixels.
     * @param {number} y - The point, in client pixels.
     * @param {string} title - What the menu acts on.
     * @param {MenuItem[]} items - The entries.
     */
    show(x, y, title, items) {
        this.hide();
        const menu = this._menu;
        menu.textContent = '';
        const titleEl = el('div', 'pci-menu-title', title);
        setTip(titleEl, title);
        menu.appendChild(titleEl);
        for (const item of items) menu.appendChild(this._entry(item));
        menu.style.display = 'block';

        const view = this._panel.ownerDocument.defaultView ?? window;
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        menu.style.left = `${Math.max(4, Math.min(x, view.innerWidth - width - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(y, view.innerHeight - height - 4))}px`;

        const doc = this._panel.ownerDocument;
        doc.addEventListener('pointerdown', this._onPointerDown, true);
        doc.addEventListener('keydown', this._onKeyDown, true);
        doc.addEventListener('wheel', this.hide, { capture: true, passive: true });
        view.addEventListener('blur', this.hide);
        this._doc = doc;
    }

    /**
     * Closes the menu, if it is open.
     */
    hide = () => {
        const doc = this._doc;
        if (!doc) return;
        this._doc = null;
        this._menu.style.display = 'none';
        doc.removeEventListener('pointerdown', this._onPointerDown, true);
        doc.removeEventListener('keydown', this._onKeyDown, true);
        doc.removeEventListener('wheel', this.hide, { capture: true });
        doc.defaultView?.removeEventListener('blur', this.hide);
    };

    /**
     * Shows a note at the bottom of the panel for a moment.
     *
     * @param {string} text - The note.
     */
    note(text) {
        clearTimeout(this._noteTimer);
        this._note.textContent = text;
        this._note.style.display = 'block';
        this._noteTimer = setTimeout(() => {
            this._note.style.display = 'none';
        }, NOTE_TIME);
    }

    /**
     * Closes the menu and removes its elements.
     */
    destroy() {
        this.hide();
        clearTimeout(this._noteTimer);
        this._menu.remove();
        this._note.remove();
    }

    /**
     * @param {MenuItem} item - An entry.
     * @returns {HTMLElement} Its element.
     * @private
     */
    _entry(item) {
        const entry = el('div', 'pci-menu-item');
        entry.setAttribute('role', 'menuitem');
        const label = el('span', 'pci-menu-label', item.text());
        entry.appendChild(label);
        if (item.title) setTip(entry, item.title);

        /** @type {HTMLButtonElement[]} */
        const buttons = [];
        const redraw = () => {
            label.textContent = item.text();
            item.buttons?.forEach((button, i) => {
                buttons[i].disabled = button.disabled();
            });
        };
        if (item.buttons?.length) {
            const wrap = el('span', 'pci-menu-buttons');
            for (const button of item.buttons) {
                const buttonEl = /** @type {HTMLButtonElement} */ (el('button', 'pci-menu-button', button.text));
                setTip(buttonEl, button.title);
                buttonEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    button.run();
                    redraw();
                });
                buttons.push(buttonEl);
                wrap.appendChild(buttonEl);
            }
            entry.appendChild(wrap);
            redraw();
        }

        entry.addEventListener('click', () => {
            this.hide();
            item.run();
        });
        return entry;
    }

    /**
     * @param {PointerEvent} e - The event.
     * @private
     */
    _onPointerDown = (e) => {
        if (!e.composedPath().includes(this._menu)) this.hide();
    };

    /**
     * @param {KeyboardEvent} e - The event.
     * @private
     */
    _onKeyDown = (e) => {
        if (e.key === 'Escape') this.hide();
    };
}

export { ContextMenu };
