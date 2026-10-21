<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's browser/browser.py
    import { SearchNode, SearchNode_Group_Joiner as Joiner } from "@generated/anki/search_pb";
    import {
        getCard,
        getPreferences,
        joinSearchNodes,
        removeDecks,
        removeTags,
        renameDeck,
        renameTags,
        setConfigJson,
    } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";
    import { onDestroy, onMount, untrack } from "svelte";
    import { get } from "svelte/store";

    import { openAddCards } from "$web/app/actions";
    import { addTagsToNotes, removeTagsFromNotes, renameFlag } from "$web/app/cardops";
    import { askUser, errorMessage, getText, showInfo, showWarning, tooltip } from "$web/app/dialogs";
    import { setSearchInBrowserHandler, setWindowCommands } from "$web/app/frontend";
    import { attachFrame } from "$web/app/host";
    import { popupMenu, type MenuEntry, type MenuItem } from "$web/app/menus";
    import {
        blankNote,
        editorNotetypeCommands,
        openCardLayout,
        openFieldsDialog,
    } from "$web/app/notetypes";
    import { onOpChanges } from "$web/app/ops";
    import { openPreviewer } from "$web/app/previewer";
    import { getProfileConfig, setProfileConfig } from "$web/app/profiles";
    import { runOp } from "$web/app/run";
    import { isEditable } from "$web/app/shortcuts";
    import { openWindow, windows, type WindowHandle } from "$web/app/windows";
    import { hooks } from "$web/plugins/hooks";

    import { browserMenus, browserShortcuts, type BrowserContext } from "./actions";
    import { BrowserModel } from "./model.svelte";
    import Sidebar from "./Sidebar.svelte";
    import { buildSidebar, SAVED_SEARCHES_KEY, savedSearches, type SidebarItem } from "./sidebar";
    import Table from "./Table.svelte";

    interface BrowserApi {
        search?: (node: SearchNode) => void;
        canClose?: () => Promise<boolean>;
    }

    let {
        win,
        initialSearch = undefined,
        initialCardId = undefined,
        api,
    }: { win: WindowHandle; initialSearch?: SearchNode; initialCardId?: bigint; api: BrowserApi } = $props();

    const model = new BrowserModel();
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

    let searchText = $state("");
    let history = $state<string[]>(getProfileConfig<string[]>("searchHistory", []));
    let searchInput: HTMLInputElement | undefined = $state();
    let sidebarItems = $state.raw<SidebarItem[]>([]);
    let sidebarVisible = $state(matchMedia("(min-width: 900px)").matches);
    let sidebar: Sidebar | undefined = $state();
    let editorFrame: HTMLIFrameElement | undefined = $state();
    let editorWindow: (Window & Record<string, any>) | null = null;
    let editorReady = false;
    let editorReadyWaiters: (() => void)[] = [];
    let loadedNoteId: bigint | null = null;
    let previewOpen = $state(false);
    let previewListeners = new Set<() => void>();
    let busy = $state(false);
    const cleanups: (() => void)[] = [];

    const editing = $derived(model.singleSelection !== null);

    // Searching
    ////////////////////////////////////////////////////////////////////////

    async function search(text: string | SearchNode, keepPrompt = false): Promise<void> {
        await saveEditor();
        let normalized: string;
        try {
            normalized = await model.normalize(text);
        } catch (err) {
            await showWarning(errorMessage(err));
            searchInput?.focus();
            return;
        }
        busy = true;
        try {
            await model.runSearch(normalized);
        } catch (err) {
            await showWarning(errorMessage(err));
        } finally {
            busy = false;
        }
        if (!keepPrompt) {
            searchText = normalized;
        }
        if (typeof text === "string" && text.trim()) {
            history = [normalized, ...history.filter((h) => h !== normalized)].slice(0, 30);
            setProfileConfig("searchHistory", history);
        }
    }

    async function defaultSearch(): Promise<void> {
        const prefs = await getPreferences({}).catch(() => null);
        const text = prefs?.editing?.defaultSearchText?.trim();
        if (text) {
            await search(text);
        } else {
            await search(new SearchNode({ filter: { case: "deck", value: "current" } }), true);
            searchText = "";
        }
    }

    function onSearchKey(event: KeyboardEvent): void {
        if (event.key === "Enter") {
            event.preventDefault();
            void search(searchText.trim() || "deck:current");
        }
    }

    async function onSidebarSearch(item: SidebarItem, mods: { and: boolean; or: boolean; not: boolean }): Promise<void> {
        let node = item.search!;
        if (mods.not) {
            node = new SearchNode({ filter: { case: "negated", value: node } });
        }
        if ((mods.and || mods.or) && model.search) {
            try {
                const joined = await joinSearchNodes({
                    joiner: mods.or ? Joiner.OR : Joiner.AND,
                    existingNode: new SearchNode({ filter: { case: "parsableText", value: model.search } }),
                    additionalNode: node,
                });
                await search(joined.val);
            } catch (err) {
                await showWarning(errorMessage(err));
            }
            return;
        }
        await search(node);
    }

    // Editor
    ////////////////////////////////////////////////////////////////////////

    function whenEditorReady(): Promise<void> {
        return editorReady ? Promise.resolve() : new Promise((resolve) => editorReadyWaiters.push(resolve));
    }

    async function saveEditor(): Promise<void> {
        if (editorReady && loadedNoteId !== null) {
            try {
                await editorWindow?.saveNow?.();
            } catch (err) {
                console.warn("saving editor failed", err);
            }
        }
    }

    let loadGeneration = 0;

    // show the selected note in the editor
    $effect(() => {
        const single = model.singleSelection;
        const generation = ++loadGeneration;
        void (async () => {
            if (single === null) {
                await saveEditor();
                loadedNoteId = null;
                return;
            }
            const nid = model.notesMode ? single : await model.currentNoteId();
            if (generation !== loadGeneration || nid === null || nid === loadedNoteId) {
                return;
            }
            await saveEditor();
            await whenEditorReady();
            if (generation !== loadGeneration) {
                return;
            }
            loadedNoteId = nid;
            editorWindow?.loadNote?.({ nid, initial: true, focusTo: undefined });
            if (editorWindow) {
                hooks.editorDidLoadNote.run(editorWindow);
            }
        })();
        for (const listener of previewListeners) {
            listener();
        }
    });

    function attachEditor(node: HTMLIFrameElement): () => void {
        editorWindow = node.contentWindow as Window & Record<string, any>;
        const detach = attachFrame(node.contentWindow!, {
            window: win,
            onBridge: (cmd) => {
                if (cmd === "editorReady") {
                    editorReady = true;
                    editorReadyWaiters.splice(0).forEach((fn) => fn());
                } else if (cmd === "preview") {
                    void preview();
                } else if (cmd === "cards") {
                    notetypeCommands.openCardsDialog?.();
                } else if (cmd === "fields") {
                    notetypeCommands.openFieldsDialog?.();
                }
                return undefined;
            },
            onKey: (event) => handleBrowserKey(event),
            onEscape: () => void win.requestClose(),
        });
        return detach;
    }

    // Preview
    ////////////////////////////////////////////////////////////////////////

    async function preview(): Promise<void> {
        await saveEditor();
        let currentCard: bigint | null = null;
        const refresh = async () => {
            currentCard = await model.currentCardId();
        };
        await refresh();
        previewOpen = true;
        await openPreviewer(
            {
                current: () => (model.selected.size === 1 || model.current !== null ? currentCard : null),
                prev: () => {
                    const index = model.indexOf(model.current);
                    if (index <= 0) {
                        return false;
                    }
                    model.move(-1);
                    return true;
                },
                next: () => {
                    const index = model.indexOf(model.current);
                    if (index < 0 || index >= model.ids.length - 1) {
                        return false;
                    }
                    model.move(1);
                    return true;
                },
                canPrev: () => model.indexOf(model.current) > 0,
                canNext: () => {
                    const index = model.indexOf(model.current);
                    return index >= 0 && index < model.ids.length - 1;
                },
                subscribe: (callback) => {
                    const listener = () => void refresh().then(callback);
                    previewListeners.add(listener);
                    return () => previewListeners.delete(listener);
                },
            },
            () => (previewOpen = false),
        );
    }

    // Sidebar
    ////////////////////////////////////////////////////////////////////////

    async function refreshSidebar(): Promise<void> {
        sidebarItems = (await runOp(() => buildSidebar())) ?? sidebarItems;
    }

    async function saveCurrentSearch(): Promise<void> {
        const name = (await getText(tr.browsingPleaseGiveYourFilterAName()))?.trim();
        if (!name) {
            return;
        }
        const saved = await savedSearches();
        if (name in saved && !(await askUser(tr.browsingConfirmSavedSearchOverwrite({ name })))) {
            return;
        }
        saved[name] = model.search;
        await writeSaved(saved);
    }

    async function writeSaved(saved: Record<string, string>): Promise<void> {
        await runOp(() =>
            setConfigJson({
                key: SAVED_SEARCHES_KEY,
                valueJson: new TextEncoder().encode(JSON.stringify(saved)),
                undoable: false,
            })
        );
        await refreshSidebar();
    }

    async function renameItem(item: SidebarItem, withParents: boolean): Promise<void> {
        const full = item.fullName ?? item.name;
        const prefix = withParents ? "" : full.slice(0, full.length - item.name.length);
        const title = item.kind === "tag" ? tr.actionsRenameTag() : item.kind === "deck" ? tr.actionsRenameDeck() : "Anki";
        const input = await getText(tr.actionsNewName(), { value: withParents ? full : item.name, title });
        if (input === null) {
            return;
        }
        const name = input.replace(/"/g, "");
        if (item.kind === "flag") {
            await renameFlag(Number(item.id), name);
            await refreshSidebar();
            return;
        }
        if (item.kind === "savedSearch") {
            const old = String(item.id);
            const saved = await savedSearches();
            if (!name || name === old || !(old in saved)) {
                return;
            }
            if (name in saved && !(await askUser(tr.browsingConfirmSavedSearchOverwrite({ name })))) {
                return;
            }
            saved[name] = saved[old];
            delete saved[old];
            await writeSaved(saved);
            return;
        }
        const newFull = prefix + name;
        if (!name || newFull === full) {
            return;
        }
        if (item.kind === "deck" && typeof item.id === "bigint") {
            const deckId = item.id;
            await runOp(() => renameDeck({ deckId, newName: newFull }));
        } else if (item.kind === "tag") {
            const out = await runOp(() => renameTags({ currentPrefix: full, newPrefix: newFull }));
            if (out?.count) {
                tooltip(tr.browsingNotesUpdated({ count: out.count }));
            } else if (out) {
                await showInfo(tr.browsingTagRenameWarningEmpty());
            }
        }
    }

    async function deleteItem(item: SidebarItem): Promise<void> {
        if (item.kind === "savedSearch") {
            const saved = await savedSearches();
            delete saved[String(item.id)];
            await writeSaved(saved);
        } else if (item.kind === "deck" && typeof item.id === "bigint") {
            const deckId = item.id;
            const out = await runOp(() => removeDecks({ dids: [deckId] }));
            if (out) {
                tooltip(tr.browsingCardsDeleted({ count: out.count }));
            }
        } else if (item.kind === "tag" && item.fullName) {
            const tags = item.fullName;
            const out = await runOp(() => removeTags({ val: tags }));
            if (out) {
                tooltip(tr.browsingNotesUpdated({ count: out.count }));
            }
        }
    }

    function setChildrenExpanded(item: SidebarItem, expanded: boolean): void {
        for (const child of item.children) {
            sidebar?.setExpanded(child, expanded);
        }
    }

    async function sidebarMenu(item: SidebarItem, event: MouseEvent): Promise<void> {
        const items: MenuEntry[] = [];
        const ntid = typeof item.id === "bigint" ? item.id : null;
        // type specific
        if (item.kind === "notetype" || item.kind === "notetypeRoot") {
            items.push({ label: tr.browsingManageNoteTypes(), action: () => void openNoteTypes(ntid) });
        } else if (item.kind === "notetypeTemplate" && ntid !== null) {
            items.push({
                label: tr.notetypesCards(),
                action: async () => openCardLayout(await blankNote(ntid), item.index ?? 0, true),
            });
        } else if (item.kind === "notetypeField" && ntid !== null) {
            items.push({ label: tr.notetypesFields(), action: () => void openFieldsDialog(ntid, item.index ?? 0) });
        } else if (item.kind === "savedSearchRoot") {
            items.push({ label: tr.browsingSidebarSaveCurrentSearch(), action: () => void saveCurrentSearch() });
        } else if (item.kind === "savedSearch") {
            items.push({
                label: tr.browsingUpdateSavedSearch(),
                action: async () => {
                    const saved = await savedSearches();
                    saved[String(item.id)] = model.search;
                    await writeSaved(saved);
                },
            });
        } else if (item.kind === "tag" && item.fullName) {
            const tags = item.fullName;
            items.push(
                {
                    label: tr.browsingAddToSelectedNotes(),
                    action: async () => {
                        await saveEditor();
                        await addTagsToNotes(await model.selectedNoteIds(), tags);
                    },
                },
                {
                    label: tr.browsingRemoveFromSelectedNotes(),
                    action: async () => {
                        await saveEditor();
                        await removeTagsFromNotes(await model.selectedNoteIds(), tags);
                    },
                },
            );
        }
        items.push(null);
        if (item.kind === "deck" && typeof item.id === "bigint") {
            const deckId = item.id;
            items.push({ label: tr.browsingAddNotes(), action: () => openAddCards({ deckId }) });
        }
        const deletable = item.kind === "savedSearch" || (item.kind === "deck" && typeof item.id === "bigint")
            || (item.kind === "tag" && !!item.fullName);
        if (deletable) {
            items.push({ label: tr.actionsDelete(), action: () => void deleteItem(item) });
        }
        const editable = deletable || (item.kind === "flag" && item.id !== undefined);
        if (editable) {
            items.push({ label: tr.actionsRename(), action: () => void renameItem(item, false) });
            if ((item.kind === "tag" || item.kind === "deck") && item.fullName && item.fullName !== item.name) {
                items.push({ label: tr.actionsRenameWithParents(), action: () => void renameItem(item, true) });
            }
        }
        if (item.kind === "notetypeField") {
            const fieldName = item.name;
            items.push({
                label: tr.browsingFindAndReplace(),
                action: async () => {
                    await saveEditor();
                    const { openFindReplace } = await import("./find-replace");
                    await openFindReplace(await model.selectedNoteIds(), fieldName);
                },
            });
        }
        items.push(null);
        if (item.search) {
            items.push({ label: tr.actionsSearch(), action: () => void search(item.search!) });
        }
        if (item.children.length) {
            items.push(
                null,
                { label: tr.browsingSidebarExpandChildren(), action: () => setChildrenExpanded(item, true) },
                { label: tr.browsingSidebarCollapseChildren(), action: () => setChildrenExpanded(item, false) },
            );
        }
        const cleaned = items.filter((entry, i) => entry !== null || (i > 0 && items[i - 1] !== null));
        while (cleaned.length && cleaned.at(-1) === null) {
            cleaned.pop();
        }
        while (cleaned.length && cleaned[0] === null) {
            cleaned.shift();
        }
        if (cleaned.length) {
            popupMenu(cleaned, { x: event.clientX, y: event.clientY });
        }
    }

    async function openNoteTypes(ntid: bigint | null): Promise<void> {
        const { default: NoteTypes } = await import("../notetypes/NoteTypes.svelte");
        openWindow({
            key: "noteTypes",
            title: tr.notetypesNoteTypes(),
            component: NoteTypes,
            props: { selectedNotetypeId: ntid ?? undefined },
            size: "md",
        });
    }

    // Menus and shortcuts
    ////////////////////////////////////////////////////////////////////////

    const ctx: BrowserContext = {
        model,
        saveEditor,
        preview: () => void preview(),
        focusSearch: () => {
            searchInput?.focus();
            searchInput?.select();
        },
        focusSidebar: () => {
            sidebarVisible = true;
            queueMicrotask(() => sidebar?.focusFilter());
        },
        findReplace: () => void openFindReplace(),
        findDuplicates: () => void openFindDuplicates(),
        searchFor: (text) => void search(text),
        toggleSidebar: () => (sidebarVisible = !sidebarVisible),
    };

    const shortcuts = browserShortcuts(ctx);

    const notetypeCommands = editorNotetypeCommands(
        () => editorWindow,
        async () => {
            const cid = await model.currentCardId();
            return cid === null ? 0 : (await getCard({ cid })).templateIdx;
        },
    );

    async function openFindReplace(): Promise<void> {
        await saveEditor();
        const noteIds = await model.selectedNoteIds();
        const { openFindReplace } = await import("./find-replace");
        await openFindReplace(noteIds);
    }

    async function openFindDuplicates(): Promise<void> {
        await saveEditor();
        const { openFindDuplicates } = await import("./find-duplicates");
        await openFindDuplicates((text) => void search(text));
    }

    async function showMenus(event: MouseEvent): Promise<void> {
        const sections = await browserMenus(ctx);
        const items: MenuItem[] = sections.map((section) => ({ label: section.title, submenu: section.items }));
        popupMenu(items, event.currentTarget as Element);
    }

    async function showRowMenu(event: MouseEvent): Promise<void> {
        const sections = await browserMenus(ctx);
        const byTitle = (i: number) => sections[i].items;
        // desktop's row context menu: the Cards and Notes menus
        const items: MenuEntry[] = [...byTitle(2), null, ...byTitle(1)];
        popupMenu(items, { x: event.clientX, y: event.clientY });
    }

    async function showHeaderMenu(event: MouseEvent): Promise<void> {
        const items: MenuEntry[] = model.allColumns
            .map((column) => ({
                label: model.label(column),
                checked: model.activeColumns.includes(column.key),
                action: () => void model.toggleColumn(column.key),
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
        popupMenu(items, { x: event.clientX, y: event.clientY });
    }

    function matches(spec: string, event: KeyboardEvent): boolean {
        const parts = spec.split("+");
        const key = parts.pop()!;
        const mods = new Set(parts.map((p) => p.toLowerCase()));
        const ctrl = isMac ? event.metaKey : event.ctrlKey;
        if (mods.has("ctrl") !== ctrl || mods.has("alt") !== event.altKey || mods.has("shift") !== event.shiftKey) {
            return false;
        }
        if (key.length === 1 && /[a-z0-9]/i.test(key)) {
            return event.code === `Key${key.toUpperCase()}` || event.code === `Digit${key}`;
        }
        return event.key === key;
    }

    function handleBrowserKey(event: KeyboardEvent): boolean {
        for (const [spec, handler] of shortcuts) {
            if (matches(spec, event)) {
                handler();
                return true;
            }
        }
        return false;
    }

    function onWindowKey(event: KeyboardEvent): void {
        const isTop = get(windows).at(-1)?.handle === win;
        if (!isTop || event.defaultPrevented) {
            return;
        }
        // plain keys belong to text fields; shortcuts with modifiers work everywhere
        const modified = event.ctrlKey || event.metaKey || event.altKey;
        if (!modified && isEditable(event.target)) {
            return;
        }
        if (handleBrowserKey(event)) {
            event.preventDefault();
        }
    }

    // Lifecycle
    ////////////////////////////////////////////////////////////////////////

    onMount(async () => {
        api.search = (node) => void search(node);
        api.canClose = async () => {
            await saveEditor();
            return true;
        };
        setSearchInBrowserHandler((node) => void search(node));
        setWindowCommands(win, notetypeCommands);
        cleanups.push(() => setSearchInBrowserHandler(null));
        cleanups.push(
            onOpChanges((changes, initiator) => {
                if (changes.browserTable) {
                    model.clearRows();
                }
                if (changes.deck || changes.tag || changes.notetype || changes.config) {
                    void refreshSidebar();
                }
                // removed notes leave the table; other changes keep it as it is, like desktop
                if (changes.note && changes.card && initiator !== editorWindow) {
                    void model.redoSearch();
                }
            }),
        );
        await runOp(() => model.init());
        void refreshSidebar();
        if (initialSearch) {
            await search(initialSearch);
        } else {
            await defaultSearch();
        }
        if (initialCardId !== undefined) {
            await model.selectCard(initialCardId);
        } else if (model.ids.length) {
            model.move("first");
        }
    });

    onDestroy(() => {
        api.search = undefined;
        api.canClose = undefined;
        cleanups.forEach((fn) => fn());
    });

    // desktop shows the counts in the window title
    const title = $derived(
        (model.notesMode ? tr.browsingWindowTitleNotes : tr.browsingWindowTitle)({
            total: model.ids.length,
            selected: model.selected.size,
        }),
    );

    $effect(() => {
        const text = title;
        untrack(() => win.setTitle(text));
    });
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="browser" class:editing class:with-sidebar={sidebarVisible}>
    <header class="toolbar">
        <button type="button" class="icon-button" aria-label="Menu" onclick={(e) => void showMenus(e)}>☰</button>
        <button
            type="button"
            class="icon-button"
            aria-label={trq.qtAccelToggleSidebar().replace(/&/g, "")}
            aria-pressed={sidebarVisible}
            onclick={() => (sidebarVisible = !sidebarVisible)}
        >
            ◧
        </button>
        <input
            class="search"
            type="search"
            list="browser-search-history"
            placeholder={tr.browsingSearchBarHint()}
            bind:value={searchText}
            bind:this={searchInput}
            onkeydown={onSearchKey}
            onfocus={() => searchInput?.select()}
        />
        <datalist id="browser-search-history">
            {#each history as entry (entry)}
                <option value={entry}></option>
            {/each}
        </datalist>
        <button
            type="button"
            class="mode"
            title={tr.browsingToggleShowingCardsNotes()}
            onclick={() => void model.toggleMode()}
        >
            {model.notesMode ? tr.browsingNotes() : tr.browsingCards()}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" class:active={previewOpen} onclick={() => void preview()}>
            {tr.actionsPreview()}
        </button>
    </header>

    <div class="body">
        {#if sidebarVisible}
            <aside class="side">
                <Sidebar
                    bind:this={sidebar}
                    items={sidebarItems}
                    onSearch={(item, mods) => void onSidebarSearch(item, mods)}
                    onContextMenu={(item, e) => void sidebarMenu(item, e)}
                />
            </aside>
        {/if}
        <section class="list" aria-busy={busy}>
            <Table
                {model}
                onActivate={() => editorFrame?.focus()}
                onContextMenu={(e) => void showRowMenu(e)}
                onHeaderMenu={(e) => void showHeaderMenu(e)}
            />
            <footer class="status">
                {title}
            </footer>
        </section>
        <section class="editor" class:hidden={!editing}>
            <button type="button" class="back" onclick={() => model.clearSelection()}>‹ {trq.qtMiscBrowse()}</button>
            <iframe
                bind:this={editorFrame}
                title={tr.editingEditCurrent()}
                src="/editor?mode=browser"
                {@attach attachEditor}
            ></iframe>
        </section>
    </div>
</div>

<style lang="scss">
    .browser {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }

    .toolbar {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.4rem 0.5rem;
        border-bottom: 1px solid var(--border-subtle);
    }

    .icon-button {
        width: 2rem;
        height: 2rem;
        border: 0;
        border-radius: var(--border-radius);
        background: transparent;
        color: var(--fg);
        &:hover,
        &[aria-pressed="true"] {
            background: var(--canvas-inset);
        }
    }

    .search {
        flex: 1;
        min-width: 0;
        padding: 0.3rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: var(--border-radius);
        background: var(--canvas-inset);
        color: var(--fg);
    }

    .mode {
        padding: 0.3rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: var(--border-radius);
        background: var(--canvas-elevated);
        color: var(--fg);
        white-space: nowrap;
    }

    .body {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
    }

    .with-sidebar .body {
        grid-template-columns: 14rem 1fr 1fr;
    }

    .side {
        min-height: 0;
        border-inline-end: 1px solid var(--border-subtle);
    }

    .list {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
    }

    .status {
        padding: 0.2rem 0.6rem;
        border-top: 1px solid var(--border-subtle);
        font-size: 0.85em;
        color: var(--fg-subtle);
    }

    .editor {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
        border-inline-start: 1px solid var(--border-subtle);
        iframe {
            flex: 1;
            border: 0;
            width: 100%;
            min-height: 0;
        }
        &.hidden iframe {
            visibility: hidden;
        }
    }

    .back {
        display: none;
    }

    // narrow screens show the list or the editor, and the sidebar over the list
    @media (max-width: 899px) {
        .body,
        .with-sidebar .body {
            grid-template-columns: 1fr;
            position: relative;
        }
        .side {
            position: absolute;
            inset: 0 auto 0 0;
            width: min(18rem, 85vw);
            z-index: 2;
            box-shadow: 4px 0 16px rgba(0, 0, 0, 0.25);
        }
        .editor {
            position: absolute;
            inset: 0;
            z-index: 3;
            background: var(--canvas);
            border: 0;
            &.hidden {
                display: none;
            }
        }
        .back {
            display: block;
            align-self: flex-start;
            margin: 0.3rem;
            padding: 0.25rem 0.5rem;
            border: 0;
            background: none;
            color: var(--fg-link);
        }
        .browser:not(.editing) .editor {
            display: none;
        }
    }
</style>
