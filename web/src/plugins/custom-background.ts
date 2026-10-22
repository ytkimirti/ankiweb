// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Custom Background Image and Gear Icon, AnkiWeb 1210908941: shows a picture
 * of your choice behind the deck list and overview, optionally behind the
 * toolbars and the reviewer, and replaces the deck list's gear icon. The
 * original's pictures are files in its folder; here you pick them in Config
 * and they are kept on this device only. The CSS options are the original's.
 */

import type { FormField } from "$web/app/dialogs";
import type { Plugin, PluginApi } from "$web/plugins/loader";

interface Config {
    reviewerImage: boolean;
    toolbarImage: boolean;
    attachment: string;
    opacityMain: number;
    opacityReview: number;
    position: string;
    scale: number;
    size: string;
}

const DEFAULTS: Config = {
    reviewerImage: true,
    toolbarImage: true,
    attachment: "fixed",
    opacityMain: 1,
    opacityReview: 1,
    position: "center",
    scale: 1,
    size: "cover",
};

/** Larger pictures are scaled down, since the reviewer sends one with every card. */
const MAX_SIDE = 1920;

function cssString(value: string): string {
    return value.replace(/[^\w\s.%#-]/g, "");
}

function imageRule(url: string, config: Config, opacity: number, position: "fixed" | "absolute"): string {
    return `content: ""; position: ${position}; inset: 0; z-index: -1; pointer-events: none;
        background-image: url("${url}"); background-size: ${cssString(config.size)};
        background-position: ${cssString(config.position)}; background-repeat: no-repeat;
        background-attachment: ${cssString(config.attachment)};
        opacity: ${Number(opacity) || 0}; transform: scale(${Number(config.scale) || 1});`;
}

function appCss(config: Config, background: string | null, gear: string | null): string {
    let css = "";
    if (background) {
        css += `.app { position: relative; isolation: isolate; }
.app::before { ${imageRule(background, config, config.opacityMain, "absolute")} }
.deck-browser, .overview, .main { background: transparent; }`;
        if (config.toolbarImage) {
            css += `.toolbar, .bottom-bar, .reviewer-bar { background: transparent !important; }`;
        }
        if (!config.reviewerImage) {
            css += `.app:has(.reviewer)::before { display: none; }`;
        }
    }
    if (gear) {
        css += `.deck-browser img.gears { content: url("${gear}"); }
.night-mode .deck-browser img.gears { filter: none; }`;
    }
    return css;
}

function cardCss(config: Config, dataUrl: string): string {
    return `<style>body::before { ${imageRule(dataUrl, config, config.opacityReview, "fixed")} }</style>`;
}

async function shrink(file: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap || Math.max(bitmap.width, bitmap.height) <= MAX_SIDE) {
        bitmap?.close();
        return file;
    }
    const scale = MAX_SIDE / Math.max(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

function dataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

export default {
    name: "Custom Background Image and Gear Icon",
    async setup(api) {
        const style = api.addStyle("");
        const urls: string[] = [];
        let cardImage: string | null = null;
        const config = () => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });

        async function apply(): Promise<void> {
            urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
            const [background, gear] = await Promise.all([api.files.get("background"), api.files.get("gear")]);
            const backgroundUrl = background ? URL.createObjectURL(background) : null;
            const gearUrl = gear ? URL.createObjectURL(gear) : null;
            urls.push(...[backgroundUrl, gearUrl].filter((u): u is string => !!u));
            style.textContent = appCss(config(), backgroundUrl, gearUrl);
            // card frames are on another origin, so they get the picture itself
            cardImage = background && config().reviewerImage ? await dataUrl(background) : null;
        }

        api.hooks.cardWillShow.append((html, _card, kind) =>
            cardImage && kind.startsWith("review") ? cardCss(config(), cardImage) + html : html
        );
        api.onUnload(() => urls.forEach((url) => URL.revokeObjectURL(url)));
        api.setConfigAction(() => configure(api, apply));
        await apply();
    },
} satisfies Plugin;

async function configure(api: PluginApi, apply: () => Promise<void>): Promise<void> {
    const config = { ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) };
    const [background, gear] = await Promise.all([api.files.get("background"), api.files.get("gear")]);
    const pickers = (name: "background" | "gear", label: string, has: boolean): FormField[] => [
        {
            key: `${name}File`,
            label: has ? `Replace the ${label}` : `Choose a ${label}`,
            type: "file",
            value: null,
            accept: "image/*",
        },
        ...(has
            ? [{ key: `${name}Remove`, label: `Remove the ${label}`, type: "checkbox" as const, value: false }]
            : []),
    ];
    const values = await api.dialogs.openForm(
        [
            ...pickers("background", "background picture", !!background),
            ...pickers("gear", "gear icon", !!gear),
            {
                key: "reviewerImage",
                label: "Show the picture in the reviewer",
                type: "checkbox",
                value: config.reviewerImage,
            },
            {
                key: "toolbarImage",
                label: "Show the picture behind the toolbars",
                type: "checkbox",
                value: config.toolbarImage,
            },
            {
                key: "opacityMain",
                label: "Opacity (main screens)",
                type: "number",
                value: config.opacityMain,
                min: 0,
                max: 1,
                step: 0.05,
            },
            {
                key: "opacityReview",
                label: "Opacity (reviewer)",
                type: "number",
                value: config.opacityReview,
                min: 0,
                max: 1,
                step: 0.05,
            },
            {
                key: "size",
                label: "background-size",
                type: "select",
                value: config.size,
                options: ["cover", "contain", "auto"].map((v) => ({ value: v, label: v })),
            },
            { key: "position", label: "background-position", type: "text", value: config.position },
            {
                key: "attachment",
                label: "background-attachment",
                type: "select",
                value: config.attachment,
                options: ["fixed", "scroll", "local"].map((v) => ({ value: v, label: v })),
            },
            { key: "scale", label: "Scale", type: "number", value: config.scale, min: 0.1, max: 5, step: 0.1 },
        ],
        {
            title: "Custom Background Image and Gear Icon",
            text: "Pictures are kept on this device and are not synced.",
        },
    );
    if (!values) {
        return;
    }
    for (const name of ["background", "gear"] as const) {
        const file = values[`${name}File`];
        if (file instanceof File) {
            await api.files.put(name, name === "background" ? await shrink(file) : file);
        } else if (values[`${name}Remove`]) {
            await api.files.remove(name);
        }
    }
    api.setConfig(
        {
            reviewerImage: !!values.reviewerImage,
            toolbarImage: !!values.toolbarImage,
            opacityMain: Number(values.opacityMain),
            opacityReview: Number(values.opacityReview),
            size: String(values.size),
            position: String(values.position),
            attachment: String(values.attachment),
            scale: Number(values.scale),
        } satisfies Config,
    );
    await apply();
}
