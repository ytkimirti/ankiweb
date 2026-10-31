<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import * as tr from "@generated/ftl";

    import { engineCrash } from "$web/app/backend";
    import { progressState } from "$web/app/progress";
    import { windows, type AppWindow } from "$web/app/windows";

    const top = $derived($windows[$windows.length - 1] as AppWindow | undefined);

    function frame(node: HTMLIFrameElement, win: AppWindow): void {
        win.handle.setFrame(node.contentWindow!);
        node.addEventListener("load", () => {
            // the frame's window object stays the same across reloads
            win.handle.setFrame(node.contentWindow!);
            win.handle.frameLoaded();
        });
    }

    function onKeydown(event: KeyboardEvent): void {
        // wherever focus was left (a window opened with a shortcut leaves it behind
        // the window); dialogs and menus above take their Escape first
        // not past the crash notice or a running operation's progress, which take no Escape
        if (event.key === "Escape" && top && !event.defaultPrevented && !$engineCrash && !$progressState) {
            event.preventDefault();
            void top.handle.requestClose();
        }
    }
</script>

<svelte:window onkeydown={onKeydown} />

{#each $windows as win (win.id)}
    <div class="window-backdrop" class:inactive={win !== top}>
        <section
            class="app-window size-{win.size}"
            role="dialog"
            aria-modal="true"
            aria-label={win.title}
        >
            <header class="window-header">
                <h2 class="window-title">{win.title}</h2>
                <button
                    type="button"
                    class="window-close"
                    title={tr.actionsClose()}
                    aria-label={tr.actionsClose()}
                    onclick={() => win.handle.requestClose()}
                >
                    ✕
                </button>
            </header>
            <div class="window-body">
                {#if win.url}
                    <iframe title={win.title} src={win.url} use:frame={win}></iframe>
                {:else if win.component}
                    <win.component {...win.props ?? {}} win={win.handle} />
                {/if}
            </div>
        </section>
    </div>
{/each}

<style lang="scss">
    .window-backdrop {
        position: fixed;
        inset: 0;
        z-index: 900;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.3);
        &.inactive {
            background: transparent;
        }
    }

    .app-window {
        background: var(--canvas);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: var(--border-radius-medium, 8px);
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.35);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-width: calc(100vw - 2rem);
        max-height: calc(100dvh - 2rem);
        &.size-sm {
            width: 28rem;
        }
        &.size-md {
            width: 42rem;
            height: min(36rem, calc(100dvh - 2rem));
        }
        &.size-lg {
            width: 64rem;
            height: min(48rem, calc(100dvh - 2rem));
        }
        &.size-xl {
            width: 90rem;
            height: calc(100dvh - 2rem);
        }
        &.size-full {
            width: 100vw;
            height: 100dvh;
            max-width: 100vw;
            max-height: 100dvh;
            border-radius: 0;
            border: none;
        }
    }

    @media (max-width: 700px) {
        .app-window:not(.size-sm) {
            width: 100vw;
            height: 100dvh;
            max-width: 100vw;
            max-height: 100dvh;
            border-radius: 0;
            border: none;
        }
    }

    .window-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 0.5rem 0.4rem 1rem;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--canvas-elevated);
        padding-top: max(0.4rem, env(safe-area-inset-top));
    }

    .window-title {
        flex: 1;
        font-size: 1rem;
        font-weight: 600;
        margin: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .window-close {
        all: unset;
        cursor: pointer;
        width: 2rem;
        height: 2rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        &:hover {
            background: var(--canvas-inset);
        }
    }

    .window-body {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: auto;
        > iframe {
            flex: 1;
            border: none;
            width: 100%;
            height: 100%;
        }
    }
</style>
