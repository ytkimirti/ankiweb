<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's toolbar.py and the main window's menu bar (forms/main.ui)
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";

    import * as actions from "$web/app/actions";
    import { switchProfile } from "$web/app/boot";
    import { WEBVIEW_FONT } from "$web/app/card-messages";
    import { mainState, moveToState, redoAction, undoAction, undoInfo } from "$web/app/main";
    import { popupMenu, type MenuEntry, type MenuItem } from "$web/app/menus";
    import { currentProfile } from "$web/app/profiles";
    import { fullScreen, hideTopBar, toggleFullScreen, uiScale, zoomBy } from "$web/app/settings";
    import { shortcutLabel } from "$web/app/shortcuts";
    import { mediaSyncLog, onSync, syncPanelOpen, syncState } from "$web/app/sync";
    import { hooks } from "$web/plugins/hooks";

    import refreshSvg from "./refresh.svg?raw";

    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

    /** Removes Qt's & accelerator markers. */
    function accel(label: string): string {
        return label.replace(/&(.)/g, "$1");
    }

    function mainMenu(): { title: string; items: MenuEntry[] }[] {
        const undo = $undoInfo;
        return [
            {
                title: accel(trq.qtAccelFile()),
                items: [
                    { label: accel(trq.qtAccelSwitchProfile()), shortcut: "Ctrl+Shift+P", action: () => void switchProfile() },
                    null,
                    { label: accel(trq.qtAccelImport()), shortcut: "Ctrl+Shift+I", action: () => void actions.onImport() },
                    { label: accel(trq.qtAccelExport()), shortcut: "Ctrl+E", action: () => void actions.onExport() },
                    null,
                    { label: accel(trq.qtAccelCreateBackup()), action: () => void actions.onCreateBackup() },
                    { label: accel(trq.qtAccelLoadBackup()), action: () => void actions.onOpenBackup() },
                ],
            },
            {
                title: accel(trq.qtAccelEdit()),
                items: [
                    {
                        label: undo.undoText,
                        shortcut: "Ctrl+Z",
                        disabled: !undo.canUndo,
                        action: () => void undoAction(),
                    },
                    {
                        label: undo.redoText,
                        shortcut: isMac ? "Ctrl+Shift+Z" : "Ctrl+Y",
                        disabled: !undo.canRedo,
                        action: () => void redoAction(),
                    },
                ],
            },
            {
                title: accel(trq.qtAccelView()),
                items: [
                    {
                        label: accel(trq.qtAccelFullScreen()),
                        shortcut: "F11",
                        checked: $fullScreen,
                        action: toggleFullScreen,
                    },
                    null,
                    { label: accel(trq.qtAccelZoomIn()), action: () => zoomBy(0.1) },
                    { label: accel(trq.qtAccelZoomOut()), action: () => zoomBy(-0.1) },
                    { label: accel(trq.qtAccelResetZoom()), action: () => uiScale.set(1) },
                ],
            },
            {
                title: accel(trq.qtAccelTools()),
                items: [
                    { label: trq.qtMiscStudyDeck(), shortcut: "/", action: () => void actions.onStudyDeck() },
                    { label: trq.qtMiscCreateFilteredDeck(), shortcut: "F", action: () => void actions.onFilteredDeck() },
                    null,
                    { label: accel(trq.qtAccelCheckDatabase()), action: () => void actions.onCheckDB() },
                    { label: accel(trq.qtAccelCheckMedia()), action: () => void actions.onCheckMedia() },
                    { label: trq.qtMiscEmptyCards(), action: () => void actions.onEmptyCards() },
                    null,
                    { label: trq.qtMiscManageNoteTypes(), shortcut: "Ctrl+Shift+N", action: () => void actions.onNoteTypes() },
                    { label: trq.qtMiscAddons(), action: () => void actions.onPlugins() },
                    { label: accel(trq.qtAccelPreferences()), shortcut: "Ctrl+P", action: () => void actions.onPrefs() },
                ],
            },
            {
                title: accel(trq.qtAccelHelp()),
                items: [
                    { label: accel(trq.qtAccelGuide()), shortcut: "F1", action: actions.onDocumentation },
                    {
                        label: accel(trq.qtAccelSupportAnki()),
                        action: () => window.open("https://apps.ankiweb.net/support/", "_blank", "noopener"),
                    },
                    null,
                    { label: accel(trq.qtAccelAbout()), action: () => void actions.onAbout() },
                ],
            },
        ];
    }

    function showMainMenu(event: MouseEvent): void {
        const sections = mainMenu();
        hooks.mainMenuWillShow.run(sections);
        const items: MenuItem[] = sections.map((section) => ({ label: section.title, submenu: section.items }));
        popupMenu(items, event.currentTarget as Element);
    }

    const links = $derived([
        { label: tr.actionsDecks(), key: "D", action: () => moveToState("deckBrowser"), active: $mainState === "deckBrowser" },
        { label: tr.actionsAdd(), key: "A", action: actions.onAddCard, active: false },
        { label: trq.qtMiscBrowse(), key: "B", action: actions.onBrowse, active: false },
        { label: trq.qtMiscStats(), key: "T", action: actions.onStats, active: false },
    ]);
</script>

<!-- desktop flattens the bar while reviewing, unless it hides it then -->
<header class="toolbar" class:flat={$mainState === "review" && !$hideTopBar} style:font-family={WEBVIEW_FONT}>
    <button type="button" class="menu-button" aria-label="Menu" title={$currentProfile ?? ""} onclick={showMainMenu}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
    </button>
    <!-- spaces between the links, as desktop's inline links have -->
    <nav class="links">
        {#each links as link (link.key)}
            <button
                type="button"
                class="hitem"
                aria-current={link.active ? "page" : undefined}
                title={tr.actionsShortcutKey({ val: shortcutLabel(link.key) })}
                onclick={link.action}
            >
                {link.label}
            </button>{" "}
        {/each}
        <button
            type="button"
            class="hitem"
            class:normal-sync={$syncState.required === "normal"}
            class:full-sync={$syncState.required === "full"}
            title={$syncState.mediaSyncing ? $mediaSyncLog : tr.actionsShortcutKey({ val: "Y" })}
            aria-expanded={$syncState.mediaSyncing ? $syncPanelOpen : undefined}
            data-sync-button
            onclick={() => void onSync()}
        >
            {trq.qtMiscSync()}
            <span class="sync-icon" class:spin={$syncState.syncing || $syncState.mediaSyncing}>
                {@html refreshSvg}
            </span>
        </button>
    </nav>
    <span class="spacer"></span>
</header>

<style lang="scss">
    @use "$ts/lib/sass/button-mixins" as button;
    @use "$ts/lib/sass/elevation" as *;

    /* desktop's toolbar.scss on a fancy body: a tray hanging from the top,
       elevated on the deck list and overview, flat glass while reviewing */
    .toolbar {
        display: flex;
        align-items: flex-start;
        gap: 0.25rem;
        padding: 0 0.5rem 5px;
        padding-top: env(safe-area-inset-top);
        line-height: normal;
        background: var(--canvas);
        user-select: none;
    }

    .menu-button,
    .spacer {
        flex: 0 0 2.25rem;
    }

    .menu-button {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 2rem;
        padding: 0;
        border: 0;
        border-radius: var(--border-radius);
        background: transparent;
        color: var(--fg);
        // the global button styles add a border and shadow in these states
        &:hover,
        &:active {
            border: 0;
            box-shadow: none;
        }
        &:hover {
            background: var(--button-gradient-start, var(--canvas-inset));
        }
    }

    .links {
        flex: 0 1 auto;
        margin: 0 auto;
        // long labels wrap rather than being cut off
        text-align: center;
        overflow: hidden;
        border-bottom-left-radius: var(--border-radius-medium);
        border-bottom-right-radius: var(--border-radius-medium);
        background: var(--canvas-elevated);
        @include elevation(1);
        &:hover {
            @include elevation(2);
        }
        .flat & {
            background: var(--canvas-glass);
            backdrop-filter: blur(var(--blur));
            @include elevation(1, $opacity-boost: -0.1);
        }
    }

    .hitem {
        display: inline-flex;
        align-items: center;
        padding: 5px 12px;
        border: 1px solid transparent;
        border-radius: 0;
        background: var(--canvas-glass);
        box-shadow: none;
        color: var(--fg);
        font-weight: bold;
        text-decoration: none;
        cursor: pointer;
        &:first-child {
            padding-left: 18px;
        }
        &:last-child {
            padding-right: 18px;
        }
        .flat & {
            background: transparent;
        }
        // outranks the global button:hover and :active styles
        &:hover,
        &:focus-visible {
            border: 1px solid var(--border-subtle);
            background: var(--canvas-glass);
            box-shadow: none;
        }
        .flat &:hover,
        .flat &:focus-visible {
            background: transparent;
        }
        &:active,
        .flat &:active {
            border-color: var(--border-subtle);
            background: var(--canvas-inset);
            @include button.impressed-shadow(0.35);
        }
    }

    .normal-sync {
        color: var(--state-new);
    }

    .full-sync {
        color: var(--state-learn);
    }

    .sync-icon {
        display: inline-flex;
        width: 0;
        height: 16px;
        overflow: hidden;
        transition: width var(--transition) ease-in;
        :global(svg) {
            width: 16px;
            height: 16px;
            fill: currentColor;
        }
        &.spin {
            width: 16px;
            animation: spin 2s linear infinite;
        }
    }

    @keyframes spin {
        from {
            transform: rotate(0deg);
        }
        to {
            transform: rotate(360deg);
        }
    }

    @media (max-width: 480px) {
        .spacer {
            display: none;
        }
        .links {
            flex: 1;
            display: flex;
            flex-wrap: wrap;
            justify-content: space-around;
        }
        .hitem,
        .hitem:first-child,
        .hitem:last-child {
            padding: 5px 0.3rem;
        }
    }
</style>
