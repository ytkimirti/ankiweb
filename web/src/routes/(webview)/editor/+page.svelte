<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import { page } from "$app/state";
    import Page from "$ts/routes/editor/+page.svelte";

    // desktop's Add and Edit windows (addcards.ui, editcurrent.ui) keep the editor off
    // their edges; the browser's editor sits in a splitter with none
    const MARGINS: Record<string, string> = { add: "6px 12px 12px", current: "12px" };
    const margin = MARGINS[page.url.searchParams.get("mode") ?? "add"];
    if (margin) {
        document.body.style.padding = margin;
    }
</script>

<Page />
