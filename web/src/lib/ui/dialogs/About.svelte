<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's about.py
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";

    import { tooltip } from "$web/app/dialogs";
    import { loadedPlugins } from "$web/plugins/loader";
    import type { WindowHandle } from "$web/app/windows";

    let { win }: { win: WindowHandle } = $props();

    const website = "https://apps.ankiweb.net/";

    function supportText(): string {
        const plugins = loadedPlugins().map((p) => `${p.name} (${p.url})`);
        return [
            `Anki ${__ANKI_VERSION__} (web)`,
            navigator.userAgent,
            `Cross-origin isolated: ${crossOriginIsolated}`,
            plugins.length ? `Plugins:\n${plugins.join("\n")}` : "Plugins: none",
        ].join("\n");
    }

    async function copyDebugInfo(): Promise<void> {
        await navigator.clipboard.writeText(supportText());
        tooltip(trq.aboutCopiedToClipboard());
    }
</script>

<div class="about">
    <img src="/_anki/imgs/anki-logo-thin.png" alt="Anki" />
    <p>{trq.aboutAnkiIsAFriendlyIntelligentSpaced().replace("Anki", "Anki®")}</p>
    <p>{trq.aboutAnkiIsLicensedUnderTheAgpl3()}</p>
    <p>{trq.aboutVersion({ val: __ANKI_VERSION__ })}</p>
    <p><a href={website} target="_blank" rel="noopener">{website}</a></p>
    <footer>
        <button type="button" class="btn btn-secondary" onclick={() => void copyDebugInfo()}>
            {trq.aboutCopyDebugInfo()}
        </button>
        <button type="button" class="btn btn-primary" onclick={() => win.close()}>{tr.helpOk()}</button>
    </footer>
</div>

<style>
    .about {
        padding: 1rem 1.5rem;
        text-align: center;
        overflow: auto;
    }
    img {
        max-width: 60%;
    }
    footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        margin-top: 1rem;
    }
</style>
