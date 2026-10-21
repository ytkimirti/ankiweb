// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { writable } from "svelte/store";

export type ThemeSetting = "follow" | "light" | "dark";

const KEY = "ankiweb:theme";
const media = matchMedia("(prefers-color-scheme: dark)");

export const themeSetting = writable<ThemeSetting>((localStorage.getItem(KEY) as ThemeSetting) || "follow");
export const nightMode = writable(false);

function apply(setting: ThemeSetting): void {
    const night = setting === "dark" || (setting === "follow" && media.matches);
    const root = document.documentElement;
    root.classList.toggle("night-mode", night);
    root.dataset.bsTheme = night ? "dark" : "light";
    document.body?.classList.toggle("nightMode", night);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", night ? "#2c2c2c" : "#f5f5f5");
    nightMode.set(night);
}

let current: ThemeSetting = "follow";
themeSetting.subscribe((setting) => {
    current = setting;
    localStorage.setItem(KEY, setting);
    apply(setting);
});
media.addEventListener("change", () => apply(current));
