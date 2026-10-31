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

<!-- desktop's BottomBar of the deck browser and overview; the spaces between
     the buttons are desktop's too -->
<footer class="bottom-bar">
    {#each links as [key, cmd, label] (cmd)}
        {" "}<button
            type="button"
            title={key ? tr.actionsShortcutKey({ val: shortcutLabel(key) }) : undefined}
            onclick={() => onCommand(cmd)}>{label}</button
        >
    {/each}
</footer>

<style lang="scss">
    /* toolbar-bottom.scss: #header's 9px padding, the table's 2px spacing and
       1px cell padding, and toolbar.scss's 5px margin below. #header is 100%
       wide plus its padding, so desktop's buttons sit 9px past the middle. */
    .bottom-bar {
        padding: 12px 0 17px 18px;
        padding-bottom: max(17px, env(safe-area-inset-bottom));
        text-align: center;
        background: var(--canvas);
        user-select: none;
    }
</style>
