// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Button Colours (Good, Again), AnkiWeb 2494384865: colours the labels of the
 * reviewer's answer buttons, with separate colours in night mode. Its defaults
 * are the four-button ones of the original's config.
 */

import type { Plugin } from "$web/plugins/loader";

const EASES = ["Again", "Hard", "Good", "Easy"];

interface Config {
    colours: string[];
    coloursDark: string[];
}

const DEFAULTS: Config = {
    // red, darkorange, green and blue, as hex for the colour pickers
    colours: ["#ff0000", "#ff8c00", "#008000", "#0000ff"],
    coloursDark: ["#eb212e", "#ffc600", "#30b700", "#00aeef"],
};

function css(config: Config): string {
    return EASES.map((_, i) => `
.reviewer-bar button.ease${i + 1} { color: ${config.colours[i]}; }
.night-mode .reviewer-bar button.ease${i + 1} { color: ${config.coloursDark[i]}; }`).join("");
}

export default {
    name: "Button Colours",
    setup(api) {
        const load = () => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        const style = api.addStyle(css(load()));
        api.setConfigAction(async () => {
            const config = load();
            const values = await api.dialogs.openForm(
                [
                    ...EASES.map((ease, i) => ({
                        key: `l${i}`,
                        label: ease,
                        type: "color" as const,
                        value: config.colours[i],
                    })),
                    ...EASES.map((ease, i) => ({
                        key: `d${i}`,
                        label: `${ease} (night mode)`,
                        type: "color" as const,
                        value: config.coloursDark[i],
                    })),
                ],
                { title: "Button Colours" },
            );
            if (values) {
                const next: Config = {
                    colours: EASES.map((_, i) => String(values[`l${i}`])),
                    coloursDark: EASES.map((_, i) => String(values[`d${i}`])),
                };
                api.setConfig(next);
                style.textContent = css(next);
            }
        });
    },
} satisfies Plugin;
