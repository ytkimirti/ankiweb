<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's main window (AnkiQt)
    import { onMount } from "svelte";

    import { importFile } from "$web/app/actions";
    import { boot } from "$web/app/boot";
    import { askUser, dialogs, errorMessage } from "$web/app/dialogs";
    import { loadingStage } from "$web/app/loading";
    import { mainState } from "$web/app/main";
    import { warmCardOrigin } from "$web/app/cardframe";
    import { startServiceWorker } from "$web/app/pwa";
    import { fullScreen, hideTopBar, topBarHideMode } from "$web/app/settings";
    import { mainWindowBlocked } from "$web/app/shortcuts";

    import DeckBrowser from "./DeckBrowser.svelte";
    import DialogHost from "./DialogHost.svelte";
    import MenuHost from "./MenuHost.svelte";
    import Overview from "./Overview.svelte";
    import ProfileManager from "./ProfileManager.svelte";
    import ProgressHost from "./ProgressHost.svelte";
    import Reviewer from "./Reviewer.svelte";
    import Toolbar from "./Toolbar.svelte";
    import WindowHost from "./WindowHost.svelte";

    let bootError = $state<string | null>(null);
    let otherTab = $state(false);
    let dragging = $state(false);

    const loadingFraction = $derived(
        $loadingStage.total ? Math.min(1, ($loadingStage.loaded ?? 0) / $loadingStage.total) : null,
    );
    /** No news from startup for a while: offer a reload rather than spin on. */
    let loadingStalled = $state(false);
    $effect(() => {
        void $loadingStage;
        loadingStalled = false;
        const timer = setTimeout(() => (loadingStalled = true), 30_000);
        return () => clearTimeout(timer);
    });

    const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

    const toolbarHidden = $derived(
        $mainState === "review" && $hideTopBar && ($topBarHideMode === 1 || $fullScreen),
    );

    /** One tab at a time: the collection files can only be opened once. */
    function acquireAppLock(): Promise<boolean> {
        if (!navigator.locks) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            void navigator.locks.request("ankiweb-app", { ifAvailable: true }, (lock) => {
                resolve(!!lock);
                // held until the tab closes
                return lock ? new Promise<void>(() => {}) : undefined;
            });
        });
    }

    onMount(async () => {
        document.getElementById("ankiweb-loading")?.remove();
        try {
            const ready = await startServiceWorker((apply) => {
                void askUser("A new version of Anki is available. Reload now?").then((yes) => {
                    if (yes) {
                        apply();
                    }
                });
            });
            if (!ready) {
                return;
            }
            if (!(await acquireAppLock())) {
                otherTab = true;
                return;
            }
            await boot();
            handleLaunchedFiles();
            warmCardOrigin();
        } catch (err) {
            console.error(err);
            bootError = errorMessage(err);
        }
    });

    /** Files opened with the installed app (the manifest's file_handlers). */
    function handleLaunchedFiles(): void {
        const queue = (window as { launchQueue?: { setConsumer(fn: (params: { files: FileSystemFileHandle[] }) => void): void } })
            .launchQueue;
        queue?.setConsumer(async (params) => {
            for (const handle of params.files ?? []) {
                void importFile(await handle.getFile());
            }
        });
    }

    function hasFiles(event: DragEvent): boolean {
        return !!event.dataTransfer?.types.includes("Files");
    }

    function onDragOver(event: DragEvent): void {
        if (hasFiles(event) && $mainState !== "startup" && !mainWindowBlocked()) {
            event.preventDefault();
            dragging = true;
        }
    }

    function onDrop(event: DragEvent): void {
        dragging = false;
        if (!hasFiles(event) || $mainState === "startup" || mainWindowBlocked()) {
            return;
        }
        event.preventDefault();
        for (const file of event.dataTransfer!.files) {
            void importFile(file);
        }
    }
</script>

<svelte:window ondragover={onDragOver} ondragleave={() => (dragging = false)} ondrop={onDrop} />

<!-- an open dialog is modal: what is behind it takes no focus or clicks
     (window-level key handlers check mainWindowBlocked themselves) -->
<div class="app" class:dragging inert={$dialogs.length > 0}>
    {#if otherTab}
        <div class="splash">
            <p>Anki is already open in another tab. Close it, then reload this page.</p>
            <button type="button" onclick={() => location.reload()}>Reload</button>
        </div>
    {:else if bootError}
        <div class="splash">
            <p class="error">{bootError}</p>
            <button type="button" onclick={() => location.reload()}>Reload</button>
        </div>
    {:else if $mainState === "startup"}
        <div class="splash" role="status">
            <p>{$loadingStage.label}</p>
            {#if loadingFraction !== null}
                <div class="bar"><div class="fill" style:width="{loadingFraction * 100}%"></div></div>
                <p class="detail">
                    {megabytes($loadingStage.loaded ?? 0)} of {megabytes($loadingStage.total ?? 0)}
                </p>
            {:else}
                <div class="spinner" aria-hidden="true"></div>
            {/if}
            {#if loadingStalled}
                <p class="detail">This is taking longer than it should.</p>
                <button type="button" onclick={() => location.reload()}>Reload</button>
            {/if}
        </div>
    {:else if $mainState === "profiles"}
        <ProfileManager />
    {:else}
        {#if !toolbarHidden}
            <Toolbar />
        {/if}
        <main class="main">
            {#if $mainState === "deckBrowser"}
                <DeckBrowser />
            {:else if $mainState === "overview"}
                <Overview />
            {:else if $mainState === "review"}
                <Reviewer />
            {/if}
        </main>
    {/if}
</div>

<div class="hosts" inert={$dialogs.length > 0}>
    <WindowHost />
    <MenuHost />
</div>
<DialogHost />
<ProgressHost />

<style lang="scss">
    .hosts {
        display: contents;
    }

    .app {
        display: flex;
        flex-direction: column;
        height: 100dvh;
        overflow: hidden;
        &.dragging {
            outline: 3px dashed var(--border-focus);
            outline-offset: -3px;
        }
    }

    .main {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        > :global(*) {
            flex: 1;
            min-height: 0;
        }
    }

    .splash {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1rem;
        padding: 2rem;
        text-align: center;
    }

    .error {
        color: var(--accent-danger);
        white-space: pre-wrap;
    }

    .bar {
        width: min(20rem, 80vw);
        height: 0.5rem;
        border-radius: 0.25rem;
        background: var(--border);
        overflow: hidden;
    }

    .fill {
        height: 100%;
        background: var(--fg);
        transition: width 0.2s;
    }

    .detail {
        color: var(--fg-subtle);
        font-size: 0.9em;
    }

    .spinner {
        width: 2.5rem;
        height: 2.5rem;
        border: 3px solid var(--border);
        border-top-color: var(--fg);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
