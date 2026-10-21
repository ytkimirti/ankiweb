<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import "$ts/routes/base.scss";
    import "$web/ui/app.scss";

    import { setContext } from "svelte";

    import { modalsKey, touchDeviceKey } from "$lib/components/context-keys";
    import App from "$web/ui/App.svelte";

    setContext(modalsKey, new Map());
    setContext(touchDeviceKey, "ontouchstart" in document.documentElement);
</script>

<App />
