<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's main window (AnkiQt)
    import { onMount } from "svelte";

    import { addCardsHasInput, importFile } from "$web/app/actions";
    import { engineBusy, engineCrash } from "$web/app/backend";
    import { boot, unloadProfile } from "$web/app/boot";
    import { dialogs, errorMessage, showInfo } from "$web/app/dialogs";
    import { loadingStage } from "$web/app/loading";
    import { mainState } from "$web/app/main";
    import { warmCardOrigin } from "$web/app/cardframe";
    import { applyPendingUpdate, reloadApp, startServiceWorker } from "$web/app/pwa";
    import { fullScreen, hideTopBar, topBarHideMode } from "$web/app/settings";
    import { progressState } from "$web/app/progress";
    import { currentProfile } from "$web/app/profiles";
    import { mainWindowBlocked } from "$web/app/shortcuts";
    import { syncState } from "$web/app/sync";

    import DeckBrowser from "./DeckBrowser.svelte";
    import DialogHost from "./DialogHost.svelte";
    import MenuHost from "./MenuHost.svelte";
    import Overview from "./Overview.svelte";
    import ProfileManager from "./ProfileManager.svelte";
    import ProgressHost from "./ProgressHost.svelte";
    import Reviewer from "./Reviewer.svelte";
    import SyncStatus from "./SyncStatus.svelte";
    import Toolbar from "./Toolbar.svelte";
    import WindowHost from "./WindowHost.svelte";

    let bootError = $state<string | null>(null);
    let otherTab = $state(false);
    let dragging = $state(false);

    const loadingFraction = $derived(
        $loadingStage.total ? Math.min(1, ($loadingStage.loaded ?? 0) / $loadingStage.total) : null,
    );
    /**
     * No news from startup for a while: offer a reload rather than spin on.
     * Downloads report often; other stages (opening a large collection on a
     * phone) can rightly take minutes.
     */
    let loadingStalled = $state(false);
    $effect(() => {
        const patience = $loadingStage.total ? 30_000 : 180_000;
        loadingStalled = false;
        const timer = setTimeout(() => (loadingStalled = true), patience);
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

    const UPDATE_CHECK_PATIENCE = 4000;

    /** A new version found while the app is open, waiting for applyUpdateIfIdle. */
    let pendingUpdate: (() => void) | null = null;
    let applyingUpdate = false;

    /**
     * Moves to a new version found while the app is open, without asking, once
     * that interrupts nothing: on the profiles screen, or when the tab is in the
     * background on the deck list or a deck's overview with nothing open or
     * running. Otherwise the next start applies it.
     */
    async function applyUpdateIfIdle(): Promise<void> {
        const apply = pendingUpdate;
        if (!apply || applyingUpdate) {
            return;
        }
        const idle = $mainState === "profiles"
            || (document.visibilityState === "hidden"
                && ($mainState === "deckBrowser" || $mainState === "overview")
                && !mainWindowBlocked()
                && !$syncState.syncing
                && !$progressState
                && !engineBusy());
        if (!idle) {
            return;
        }
        applyingUpdate = true;
        try {
            // closed as on quitting: synced and backed up
            if (await unloadProfile()) {
                pendingUpdate = null;
                apply();
            }
        } finally {
            applyingUpdate = false;
        }
    }

    $effect(() => {
        // looked at again on every move between screens
        void $mainState;
        void applyUpdateIfIdle();
    });

    onMount(async () => {
        try {
            const ready = await startServiceWorker((apply) => {
                pendingUpdate = apply;
                void applyUpdateIfIdle();
            });
            if (!ready) {
                return;
            }
            if (!(await acquireAppLock())) {
                otherTab = true;
                return;
            }
            // a page is a web page: it starts on the newest version without asking
            if (await applyPendingUpdate(true, UPDATE_CHECK_PATIENCE).catch(() => false)) {
                return;
            }
            await boot();
            handleLaunchedFiles();
            warmCardOrigin();
        } catch (err) {
            console.error(err);
            // a version that did not cache the engine's workers fails to start
            // once the server has a newer one, which then has to take over
            if (await applyPendingUpdate(true).catch(() => false)) {
                return;
            }
            bootError = errorMessage(err);
        }
    });

    /** Files are imported into the open profile. */
    function canImport(): boolean {
        return !!$currentProfile && $mainState !== "startup" && $mainState !== "profiles" && !$engineCrash;
    }

    const NO_PROFILE = "Open a profile first, then import the file into it.";

    /** Files opened with the installed app (the manifest's file_handlers). */
    function handleLaunchedFiles(): void {
        const queue = (window as { launchQueue?: { setConsumer(fn: (params: { files: FileSystemFileHandle[] }) => void): void } })
            .launchQueue;
        queue?.setConsumer(async (params) => {
            if (!params.files?.length) {
                return;
            }
            if (!canImport()) {
                await showInfo(NO_PROFILE);
                return;
            }
            for (const handle of params.files) {
                void importFile(await handle.getFile());
            }
        });
    }

    function hasFiles(event: DragEvent): boolean {
        return !!event.dataTransfer?.types.includes("Files");
    }

    function onDragOver(event: DragEvent): void {
        if (!hasFiles(event)) {
            return;
        }
        // always, or the browser would open the file in place of the app
        event.preventDefault();
        const ok = canImport() && !mainWindowBlocked();
        dragging = ok;
        event.dataTransfer!.dropEffect = ok ? "copy" : "none";
    }

    function onDrop(event: DragEvent): void {
        dragging = false;
        if (!hasFiles(event)) {
            return;
        }
        event.preventDefault();
        if ($mainState === "profiles") {
            void showInfo(NO_PROFILE);
        }
        if (!canImport() || mainWindowBlocked()) {
            return;
        }
        for (const file of event.dataTransfer!.files) {
            void importFile(file);
        }
    }

    /** Leaving now would lose work or cut short a sync, import or export. */
    function onBeforeUnload(event: BeforeUnloadEvent): void {
        if ($syncState.syncing || $progressState || engineBusy() || addCardsHasInput()) {
            event.preventDefault();
            event.returnValue = "";
        }
    }
</script>

<svelte:document onvisibilitychange={() => void applyUpdateIfIdle()} />

<svelte:window
    ondragover={onDragOver}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
    onbeforeunload={onBeforeUnload}
/>

<!-- an open dialog is modal: what is behind it takes no focus or clicks
     (window-level key handlers check mainWindowBlocked themselves) -->
<div class="app" class:dragging inert={$dialogs.length > 0 || !!$engineCrash}>
    {#if otherTab}
        <div class="splash">
            <p>Anki is already open in another tab. Close it, then reload this page.</p>
            <!-- not reloadApp: a new version taking over would also take over the other tab -->
            <button type="button" onclick={() => location.reload()}>Reload</button>
        </div>
    {:else if bootError}
        <div class="splash">
            <p class="error">{bootError}</p>
            <button type="button" onclick={() => void reloadApp()}>Reload</button>
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
                <button type="button" onclick={() => void reloadApp()}>Reload</button>
            {/if}
        </div>
    {:else if $mainState === "profiles"}
        <ProfileManager />
    {:else}
        {#if !toolbarHidden}
            <Toolbar />
        {/if}
        <SyncStatus />
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

<div class="hosts" inert={$dialogs.length > 0 || !!$engineCrash}>
    <WindowHost />
    <MenuHost />
</div>
<div class="hosts" inert={!!$engineCrash}>
    <DialogHost />
    <ProgressHost />
</div>
{#if $engineCrash}
    <div class="crashed" role="alertdialog" aria-labelledby="crashed-title">
        <div class="crashed-box">
            <h2 id="crashed-title">Anki stopped working</h2>
            <p>
                An error stopped Anki's engine, so nothing more can be done until the page is reloaded. Changes made
                before the error are kept.
            </p>
            <p class="detail">{$engineCrash}</p>
            <button type="button" class="btn btn-primary" onclick={() => void reloadApp()}>Reload</button>
        </div>
    </div>
{/if}

<style lang="scss">
    .hosts {
        display: contents;
    }

    .crashed {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        background: rgba(0, 0, 0, 0.5);
    }

    .crashed-box {
        max-width: 28rem;
        padding: 1.25rem;
        border-radius: var(--border-radius-large, 8px);
        background: var(--canvas-elevated);
        color: var(--fg);
        box-shadow: 0 4px 16px var(--shadow);
        h2 {
            margin: 0 0 0.75rem;
            font-size: 1.15rem;
        }
        .detail {
            word-break: break-word;
        }
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
