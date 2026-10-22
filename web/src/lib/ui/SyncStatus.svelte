<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // what media sync is doing, under the toolbar: a line along its edge
    // while it runs, a status bar outside the reviewer, and the sync panel
    // with the log (desktop's media sync tooltip and log dialog)
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";

    import { dialogs } from "$web/app/dialogs";
    import { mainState } from "$web/app/main";
    import { mediaSyncFraction, mediaSyncTotals } from "$web/app/mediasync";
    import {
        abortMediaSyncNow,
        dismissMediaSyncStatus,
        mediaSyncStatus,
        mediaSyncText,
        startMediaSync,
        syncLog,
        syncPanelOpen,
    } from "$web/app/sync";

    const status = $derived($mediaSyncStatus);
    const active = $derived(!!status?.active);
    const finishedAt = $derived(status?.finishedAt ?? null);
    const fraction = $derived(status ? mediaSyncFraction(status) : null);
    const line = $derived(status ? mediaSyncText(status) : "");

    /** Running long enough to be worth a status bar: quick checks show none. */
    let settled = $state(false);
    /** A finished sync's result has been up long enough. */
    let expired = $state(false);
    let wasShown = false;

    $effect(() => {
        if (!active) {
            return;
        }
        settled = false;
        expired = false;
        wasShown = false;
        const timer = setTimeout(() => (settled = true), 1500);
        return () => clearTimeout(timer);
    });

    const barVisible = $derived.by(() => {
        if (!status) {
            return false;
        }
        if (status.stage === "failed") {
            return true;
        }
        if ($mainState === "review") {
            return false;
        }
        if (status.active) {
            return settled || status.stage === "downloading" || status.stage === "uploading";
        }
        // the result of one that was showing, or that moved files
        return !expired && (wasShown || !!mediaSyncTotals(status));
    });

    $effect(() => {
        if (barVisible && active) {
            wasShown = true;
        }
    });

    // errors stay until dismissed
    const failed = $derived(status?.stage === "failed");
    $effect(() => {
        if (finishedAt === null || failed) {
            return;
        }
        const timer = setTimeout(() => (expired = true), 5000);
        return () => clearTimeout(timer);
    });

    // the panel shows it until closed
    $effect(() => {
        if (expired && !$syncPanelOpen && finishedAt !== null && !failed) {
            dismissMediaSyncStatus();
        }
    });

    let panel = $state<HTMLElement | null>(null);
    let logList = $state<HTMLElement | null>(null);

    $effect(() => {
        // the newest entry is last
        if ($syncLog.length && logList) {
            logList.scrollTop = logList.scrollHeight;
        }
    });

    function closePanel(): void {
        syncPanelOpen.set(false);
    }

    function onPointerDown(event: PointerEvent): void {
        const target = event.target as Element | null;
        // the sync button toggles it itself
        if (!$syncPanelOpen || panel?.contains(target) || target?.closest("[data-sync-button]")) {
            return;
        }
        closePanel();
    }

    function onKeyDown(event: KeyboardEvent): void {
        // a dialog over it takes Escape itself
        if ($syncPanelOpen && event.key === "Escape" && !$dialogs.length) {
            event.preventDefault();
            event.stopPropagation();
            closePanel();
        }
    }

    function time(ms: number): string {
        return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
</script>

<svelte:window onpointerdown={onPointerDown} onkeydowncapture={onKeyDown} />

<div class="sync-status">
    {#if active}
        <div class="edge" aria-hidden="true">
            {#if fraction !== null}
                <div class="edge-fill" style:width="{fraction * 100}%"></div>
            {:else}
                <div class="edge-sweep"></div>
            {/if}
        </div>
    {/if}

    {#if barVisible && status}
        <div class="bar" class:failed={status.stage === "failed"} role="status" aria-live="polite">
            {#if status.active}
                <span class="spinner" aria-hidden="true"></span>
            {/if}
            <span class="text" title={line}>{line}</span>
            {#if fraction !== null}
                <span class="meter" aria-hidden="true">
                    <span class="meter-fill" style:width="{fraction * 100}%"></span>
                </span>
            {/if}
            <span class="actions">
                {#if status.stage === "failed"}
                    <button type="button" class="link" onclick={() => void startMediaSync()}>Retry</button>
                {/if}
                <button
                    type="button"
                    class="link"
                    aria-expanded={$syncPanelOpen}
                    data-sync-button
                    onclick={() => syncPanelOpen.update((open) => !open)}
                >
                    Details
                </button>
                {#if !status.active}
                    <button type="button" class="link close" aria-label={tr.actionsClose()} onclick={dismissMediaSyncStatus}>
                        ×
                    </button>
                {/if}
            </span>
        </div>
    {/if}

    {#if $syncPanelOpen}
        <div class="panel" role="dialog" aria-label={trq.qtMiscSync()} bind:this={panel}>
            <div class="panel-title">{tr.syncMediaLogTitle()}</div>
            {#if status}
                <div class="panel-line">{line}</div>
                {#if status.active}
                    {#if fraction !== null}
                        <progress value={fraction} max="1"></progress>
                    {:else}
                        <progress></progress>
                    {/if}
                {/if}
                {#if mediaSyncTotals(status)}
                    <div class="panel-detail">{mediaSyncTotals(status)}.</div>
                {/if}
                {#if status.active && status.detail}
                    <div class="panel-detail">{status.detail}</div>
                {/if}
            {/if}
            {#if $syncLog.length}
                <ol class="log" bind:this={logList}>
                    {#each $syncLog as entry, i (i)}
                        <li><span class="time">{time(entry.time)}</span> {entry.text}</li>
                    {/each}
                </ol>
            {/if}
            <div class="panel-buttons">
                {#if status?.active}
                    <button type="button" class="btn btn-secondary" onclick={() => void abortMediaSyncNow()}>
                        {tr.syncAbortButton()}
                    </button>
                {/if}
                <button type="button" class="btn btn-primary" onclick={closePanel}>{tr.actionsClose()}</button>
            </div>
        </div>
    {/if}
</div>

<style lang="scss">
    .sync-status {
        position: relative;
        flex: none;
        z-index: 800;
    }

    // over the toolbar's bottom border, so it takes no room
    .edge {
        position: absolute;
        top: -2px;
        left: 0;
        right: 0;
        height: 2px;
        overflow: hidden;
        pointer-events: none;
    }

    .edge-fill {
        height: 100%;
        background: var(--state-new);
        transition: width 0.3s;
    }

    .edge-sweep {
        width: 30%;
        height: 100%;
        background: var(--state-new);
        animation: sweep 1.5s ease-in-out infinite;
    }

    @keyframes sweep {
        from {
            transform: translateX(-100%);
        }
        to {
            transform: translateX(340%);
        }
    }

    .bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-height: 1.75rem;
        padding: 0 0.75rem;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--canvas-elevated);
        color: var(--fg-subtle);
        font-size: 0.85rem;
        font-variant-numeric: tabular-nums;
        &.failed {
            color: var(--accent-danger);
        }
    }

    .text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .spinner {
        flex: none;
        width: 0.8rem;
        height: 0.8rem;
        border: 2px solid var(--border);
        border-top-color: var(--fg-subtle);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .meter {
        flex: 0 1 8rem;
        min-width: 3rem;
        height: 0.4rem;
        border-radius: 0.2rem;
        background: var(--border);
        overflow: hidden;
    }

    .meter-fill {
        display: block;
        height: 100%;
        background: var(--state-new);
        transition: width 0.3s;
    }

    // the line along the toolbar shows it on phones, where the text needs the room
    @media (max-width: 480px) {
        .meter {
            display: none;
        }
    }

    .actions {
        flex: none;
        display: flex;
        gap: 0.25rem;
    }

    // text buttons; the global button styles would box them
    button.link,
    button.link:hover,
    button.link:active {
        padding: 0 0.25rem;
        border: 0;
        background: transparent;
        box-shadow: none;
        color: inherit;
        font-size: inherit;
        text-decoration: underline;
        cursor: pointer;
    }

    button.close {
        text-decoration: none;
        font-size: 1.1rem;
        line-height: 1;
    }

    .panel {
        position: absolute;
        top: calc(100% + 0.25rem);
        left: 50%;
        transform: translateX(-50%);
        width: min(28rem, calc(100vw - 1rem));
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem 1rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--canvas-elevated);
        color: var(--fg);
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    }

    .panel-title {
        font-weight: 600;
    }

    .panel-detail {
        color: var(--fg-subtle);
        font-size: 0.9em;
        white-space: pre-line;
        font-variant-numeric: tabular-nums;
    }

    progress {
        width: 100%;
    }

    .log {
        list-style: none;
        margin: 0;
        padding: 0.4rem 0.5rem;
        max-height: 12rem;
        overflow-y: auto;
        border: 1px solid var(--border-subtle);
        border-radius: var(--border-radius);
        background: var(--canvas-inset);
        font-size: 0.85em;
        li {
            padding: 0.1rem 0;
            overflow-wrap: anywhere;
        }
    }

    .time {
        color: var(--fg-subtle);
        font-variant-numeric: tabular-nums;
    }

    .panel-buttons {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
    }
</style>
