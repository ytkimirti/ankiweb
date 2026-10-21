<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import "$ts/routes/base.scss";
    import "$web/ui/app.scss";

    import { onMount, setContext } from "svelte";

    import { modalsKey, touchDeviceKey } from "$lib/components/context-keys";
    import { isCardOrigin } from "$web/config";
    import App from "$web/ui/App.svelte";

    setContext(modalsKey, new Map());
    setContext(touchDeviceKey, "ontouchstart" in document.documentElement);

    // app.html's placeholder, until this code loaded
    onMount(() => document.getElementById("ankiweb-loading")?.remove());
</script>

<!-- the card origin only serves card frames; the app and its data live on the app's origin -->
{#if isCardOrigin()}
    <p class="card-origin">This address only serves cards for Anki.</p>
{:else}
    <App />
{/if}

<style>
    .card-origin {
        margin: 2rem;
        text-align: center;
    }
</style>
