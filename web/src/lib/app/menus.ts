// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Popup menus (desktop's QMenu), rendered by MenuHost.svelte. */

import { writable } from "svelte/store";

export interface MenuItem {
    label: string;
    shortcut?: string;
    action?: () => void;
    checked?: boolean;
    disabled?: boolean;
    submenu?: MenuEntry[];
}

/** null draws a separator. */
export type MenuEntry = MenuItem | null;

export interface OpenMenu {
    id: number;
    items: MenuEntry[];
    x: number;
    y: number;
}

export const openMenus = writable<OpenMenu[]>([]);

let nextId = 1;

/**
 * Shows a menu at a point, or below an element. Plugins can add items to
 * menus through the hooks in $web/plugins before they are shown.
 */
export function popupMenu(items: MenuEntry[], at: { x: number; y: number } | Element): void {
    let x: number;
    let y: number;
    if (at instanceof Element) {
        const rect = at.getBoundingClientRect();
        x = rect.left;
        y = rect.bottom;
    } else {
        ({ x, y } = at);
    }
    openMenus.set([{ id: nextId++, items, x, y }]);
}

export function closeMenus(): void {
    openMenus.set([]);
}
