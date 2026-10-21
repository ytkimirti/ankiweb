<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import "../../../../qt/aqt/data/web/css/webview.scss";
    import "$ts/reviewer/reviewer.scss";

    import { onMount } from "svelte";

    /** Links in cards open outside the app, as they do on desktop. */
    function onClick(event: MouseEvent): void {
        const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!link || event.defaultPrevented) {
            return;
        }
        const href = link.getAttribute("href") ?? "";
        if (href.startsWith("#") || href.startsWith("javascript:")) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        window.open(link.href, "_blank", "noopener");
    }

    onMount(() => {
        window.bridgeCommand("reviewerReady");
    });
</script>

<svelte:document onclickcapture={onClick} />

<div id="_mark" hidden>&#x2605;</div>
<div id="_flag" hidden>&#x2691;</div>
<div id="qa" dir="auto"></div>
