<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import * as tr from "@generated/ftl";

    import { shortcutLabel } from "$web/app/shortcuts";
    import type { BarLink } from "$web/plugins/hooks";

    let { links, onCommand }: { links: BarLink[]; onCommand: (cmd: string) => void } = $props();
</script>

<!-- desktop's BottomBar of the deck browser and overview -->
<footer class="bottom-bar">
    {#each links as [key, cmd, label] (cmd)}
        <button
            type="button"
            title={key ? tr.actionsShortcutKey({ val: shortcutLabel(key) }) : undefined}
            onclick={() => onCommand(cmd)}
        >
            {label}
        </button>
    {/each}
</footer>

<style lang="scss">
    .bottom-bar {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 0.4rem;
        padding: 0.5rem;
        padding-bottom: max(0.5rem, env(safe-area-inset-bottom));
        border-top: 1px solid var(--border-subtle);
        background: var(--canvas-elevated);
    }
</style>
