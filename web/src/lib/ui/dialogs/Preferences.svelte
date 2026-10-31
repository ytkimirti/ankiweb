<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's preferences.py
    import type { Preferences } from "@generated/anki/config_pb";
    import { getPreferences, setPreferences } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import { onDestroy, onMount } from "svelte";

    import { onOpenBackup } from "$web/app/actions";
    import { askUser, showInfo, showWarning } from "$web/app/dialogs";
    import { requestPersistentStorage, STORAGE_WARNING, storagePersisted } from "$web/app/pwa";
    import { getMeta, getProfileConfig, setMeta, setProfileConfig, setSchemaModified } from "$web/app/profiles";
    import {
        bottomBarHideMode,
        hideBottomBar,
        hideTopBar,
        reduceMotion,
        topBarHideMode,
        uiScale,
    } from "$web/app/settings";
    import {
        logout,
        mediaSyncLog,
        onSync,
        startPeriodicMediaSync,
        syncLoginDialog,
        syncState,
    } from "$web/app/sync";
    import { themeSetting, type ThemeSetting } from "$web/app/theme";
    import type { WindowHandle } from "$web/app/windows";

    import { LANGUAGES } from "./languages";

    let { win }: { win: WindowHandle } = $props();

    type Tab = "general" | "review" | "editing" | "sync" | "backups" | "labs";
    let tab = $state<Tab>("general");

    let prefs = $state<Preferences | null>(null);
    let original: Preferences | null = null;

    // profile settings
    let autoSync = $state(getProfileConfig<boolean>("autoSync", true));
    let syncMedia = $state(getProfileConfig<boolean>("syncMedia", true));
    let periodicMedia = $state(getProfileConfig<number>("periodicSyncMediaMinutes", 15) !== 0);
    let customSyncUrl = $state(getProfileConfig<string>("customSyncUrl", ""));
    let networkTimeout = $state(getProfileConfig<number>("networkTimeout", 60));
    let fullSync = $state(false);
    let syncUser = $state(getProfileConfig<string | null>("syncKey", null) ? getProfileConfig<string>("syncUser", "") : null);
    let spacebarRatesCard = $state(getProfileConfig<boolean>("spacebarRatesCard", true));
    let answerKeys = $state(getProfileConfig<Record<string, string>>("answerKeys", {}));

    /** How much of the browser's storage the app uses, in bytes. */
    let storageUse = $state<{ usage: number; quota: number } | null>(null);
    const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000).toLocaleString()} MB`;

    async function checkStorage(): Promise<void> {
        await requestPersistentStorage();
        const estimate = await navigator.storage?.estimate?.().catch(() => null);
        storageUse = estimate?.quota ? { usage: estimate.usage ?? 0, quota: estimate.quota } : null;
    }
    void checkStorage();

    const originalLang = getMeta<string | null>("defaultLang", null) ?? "";
    let lang = $state(originalLang);

    /** The language the browser asks for, which an unset choice follows, by name rather than code. */
    function browserLanguageName(): string {
        const code = navigator.language;
        const listed = LANGUAGES.find(([, c]) => c.toLowerCase() === code.toLowerCase());
        if (listed) {
            return listed[0];
        }
        try {
            return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
        } catch {
            return code;
        }
    }

    onMount(async () => {
        const out = await getPreferences({});
        original = out.clone();
        prefs = out;
    });

    async function saveCollectionPrefs(): Promise<void> {
        if (prefs && original && !prefs.equals(original)) {
            await setPreferences(prefs);
            original = prefs.clone();
        }
    }

    function saveProfile(): void {
        setProfileConfig("autoSync", autoSync);
        setProfileConfig("syncMedia", syncMedia);
        setProfileConfig("periodicSyncMediaMinutes", periodicMedia ? 15 : 0);
        setProfileConfig("customSyncUrl", customSyncUrl.trim() || null);
        setProfileConfig("networkTimeout", networkTimeout);
        setProfileConfig("spacebarRatesCard", spacebarRatesCard);
        const keys = Object.fromEntries(Object.entries(answerKeys).filter(([, key]) => key));
        setProfileConfig("answerKeys", keys);
        startPeriodicMediaSync();
    }

    async function save(): Promise<void> {
        saveProfile();
        if (fullSync) {
            await setSchemaModified();
            fullSync = false;
        }
        await saveCollectionPrefs();
        if (lang !== originalLang) {
            setMeta("defaultLang", lang || null);
            await showInfo(tr.preferencesChangesWillTakeEffectWhenYou());
        }
    }

    let saved = false;
    onDestroy(() => {
        if (!saved) {
            saved = true;
            void save();
        }
    });

    async function login(): Promise<void> {
        saveProfile();
        if (await syncLoginDialog()) {
            syncUser = getProfileConfig<string>("syncUser", "");
            if (await askUser(tr.preferencesLoginSuccessfulSyncNow())) {
                saved = true;
                await save();
                win.close();
                await onSync();
            }
        }
    }

    async function doLogout(): Promise<void> {
        if ($syncState.mediaSyncing || $syncState.syncing) {
            await showWarning("Can't log out while sync in progress.");
            return;
        }
        await logout();
        syncUser = null;
    }

    async function showMediaLog(): Promise<void> {
        await showInfo($mediaSyncLog || tr.syncMediaComplete(), { title: tr.syncMediaLogTitle() });
    }

    const learnAheadMins = {
        get value() {
            return Math.round((prefs?.scheduling?.learnAheadSecs ?? 0) / 60);
        },
        set value(mins: number) {
            if (prefs?.scheduling) {
                prefs.scheduling.learnAheadSecs = Math.max(0, mins) * 60;
            }
        },
    };

    const timeLimitMins = {
        get value() {
            return Math.round((prefs?.reviewing?.timeLimitSecs ?? 0) / 60);
        },
        set value(mins: number) {
            if (prefs?.reviewing) {
                prefs.reviewing.timeLimitSecs = Math.max(0, mins) * 60;
            }
        },
    };

    const tabs: [Tab, string][] = [
        ["general", tr.preferencesGeneral()],
        ["review", tr.preferencesReview()],
        ["editing", tr.preferencesEditing()],
        ["sync", tr.preferencesTabSynchronisation()],
        ["backups", tr.preferencesBackups()],
        ["labs", tr.preferencesExperimentalFeaturesTab()],
    ];

    const themes: [ThemeSetting, string][] = [
        ["follow", tr.preferencesThemeFollowSystem()],
        ["light", tr.preferencesThemeLight()],
        ["dark", tr.preferencesThemeDark()],
    ];

    const easeLabels: [number, string][] = [
        [1, tr.studyingAgain()],
        [2, tr.studyingHard()],
        [3, tr.studyingGood()],
        [4, tr.studyingEasy()],
    ];
</script>

<div class="prefs">
    <nav class="tabs" role="tablist">
        {#each tabs as [id, label] (id)}
            <button type="button" role="tab" aria-selected={tab === id} class:active={tab === id} onclick={() => (tab = id)}>
                {label}
            </button>
        {/each}
    </nav>

    <div class="content">
        {#if tab === "general"}
            <section>
                <h3>{tr.preferencesUserInterface()}</h3>
                <label class="row">
                    <span>{tr.preferencesLanguage()}</span>
                    <select bind:value={lang}>
                        <option value="">Same as browser ({browserLanguageName()})</option>
                        {#each LANGUAGES as [name, code] (code)}
                            <option value={code}>{name}</option>
                        {/each}
                    </select>
                </label>
                <label class="row">
                    <span>{tr.preferencesTheme()}</span>
                    <select bind:value={$themeSetting}>
                        {#each themes as [value, label] (value)}
                            <option {value}>{label}</option>
                        {/each}
                    </select>
                </label>
                <label class="row">
                    <span>{tr.preferencesUserInterfaceSize()}</span>
                    <span class="inline">
                        <input
                            type="number"
                            min="50"
                            max="200"
                            step="5"
                            value={Math.round($uiScale * 100)}
                            onchange={(e) => uiScale.set(Math.min(200, Math.max(50, Number(e.currentTarget.value) || 100)) / 100)}
                        />
                        %
                    </span>
                </label>
                <label class="check" title={tr.preferencesReduceMotionTooltip()}>
                    <input type="checkbox" bind:checked={$reduceMotion} />
                    {tr.preferencesReduceMotion()}
                </label>
            </section>
            <section>
                <h3>{tr.preferencesDistractions()}</h3>
                <label class="check">
                    <input type="checkbox" bind:checked={$hideTopBar} />
                    {tr.preferencesHideTopBarDuringReview()}
                </label>
                {#if $hideTopBar}
                    <select class="indent" bind:value={$topBarHideMode}>
                        <option value={0}>{tr.preferencesFullScreenOnly()}</option>
                        <option value={1}>{tr.preferencesAlways()}</option>
                    </select>
                {/if}
                <label class="check">
                    <input type="checkbox" bind:checked={$hideBottomBar} />
                    {tr.preferencesHideBottomBarDuringReview()}
                </label>
                {#if $hideBottomBar}
                    <select class="indent" bind:value={$bottomBarHideMode}>
                        <option value={0}>{tr.preferencesFullScreenOnly()}</option>
                        <option value={1}>{tr.preferencesAlways()}</option>
                    </select>
                {/if}
            </section>
        {:else if tab === "review" && prefs?.scheduling && prefs.reviewing}
            <section>
                <h3>{tr.preferencesScheduler()}</h3>
                <label class="row">
                    <span>{tr.preferencesNextDayStartsAt()}</span>
                    <span class="inline">
                        <input type="number" min="0" max="23" bind:value={prefs.scheduling.rollover} />
                        {tr.preferencesHoursPastMidnight()}
                    </span>
                </label>
                <label class="row">
                    <span>{tr.preferencesLearnAheadLimit()}</span>
                    <span class="inline">
                        <input type="number" min="0" max="9999" bind:value={learnAheadMins.value} />
                        {tr.preferencesMins()}
                    </span>
                </label>
                <label class="row">
                    <span>{tr.preferencesTimeboxTimeLimit()}</span>
                    <span class="inline">
                        <input type="number" min="0" max="9999" bind:value={timeLimitMins.value} />
                        {tr.preferencesMins()}
                    </span>
                </label>
            </section>
            <section>
                <h3>{tr.preferencesReview()}</h3>
                <label class="check">
                    <input
                        type="checkbox"
                        checked={!prefs.reviewing.hideAudioPlayButtons}
                        onchange={(e) => prefs?.reviewing && (prefs.reviewing.hideAudioPlayButtons = !e.currentTarget.checked)}
                    />
                    {tr.preferencesShowPlayButtonsOnCardsWith()}
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={prefs.reviewing.interruptAudioWhenAnswering} />
                    {tr.preferencesInterruptCurrentAudioWhenAnswering()}
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={prefs.reviewing.showRemainingDueCounts} />
                    {tr.preferencesShowRemainingCardCount()}
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={prefs.reviewing.showIntervalsOnButtons} />
                    {tr.preferencesShowNextReviewTimeAboveAnswer()}
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={spacebarRatesCard} />
                    {tr.preferencesSpacebarRatesCard()}
                </label>
            </section>
            <section>
                <h3>{tr.preferencesAnswerKeys()}</h3>
                {#each easeLabels as [ease, label] (ease)}
                    <label class="row">
                        <span>{label}</span>
                        <input
                            type="text"
                            placeholder={tr.preferencesShortcutPlaceholder()}
                            value={answerKeys[String(ease)] ?? String(ease)}
                            oninput={(e) => (answerKeys = { ...answerKeys, [String(ease)]: e.currentTarget.value })}
                        />
                    </label>
                {/each}
            </section>
        {:else if tab === "editing" && prefs?.editing}
            <section>
                <h3>{tr.preferencesEditing()}</h3>
                <label class="check">
                    <input type="checkbox" bind:checked={prefs.editing.pasteImagesAsPng} />
                    {tr.preferencesPasteClipboardImagesAsPng()}
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={prefs.editing.pasteStripsFormatting} />
                    {tr.preferencesPasteWithoutShiftKeyStripsFormatting()}
                </label>
                <label class="row">
                    <span>{tr.preferencesDefaultDeck()}</span>
                    <select
                        value={prefs.editing.addingDefaultsToCurrentDeck ? 0 : 1}
                        onchange={(e) => prefs?.editing && (prefs.editing.addingDefaultsToCurrentDeck = e.currentTarget.value === "0")}
                    >
                        <option value={0}>{tr.preferencesWhenAddingDefaultToCurrentDeck()}</option>
                        <option value={1}>{tr.preferencesChangeDeckDependingOnNoteType()}</option>
                    </select>
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={prefs.editing.renderLatex} />
                    {tr.preferencesGenerateLatexImagesAutomatically()}
                </label>
            </section>
            <section>
                <h3>{tr.preferencesBrowsing()}</h3>
                <label class="row">
                    <span>{tr.preferencesDefaultSearchText()}</span>
                    <input
                        type="text"
                        placeholder={tr.preferencesDefaultSearchTextExample()}
                        bind:value={prefs.editing.defaultSearchText}
                    />
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={prefs.editing.ignoreAccentsInSearch} />
                    {tr.preferencesIgnoreAccentsInSearch()}
                </label>
            </section>
        {:else if tab === "sync"}
            <section>
                <h3>{tr.preferencesAccount()}</h3>
                {#if syncUser !== null}
                    <p>{syncUser}</p>
                    <button type="button" class="btn btn-secondary" onclick={() => void doLogout()}>
                        {tr.syncLogOutButton()}
                    </button>
                {:else}
                    <p>{tr.preferencesAnkiwebIntro()}</p>
                    <button type="button" class="btn btn-primary" onclick={() => void login()}>
                        {tr.syncLogInButton()}
                    </button>
                {/if}
            </section>
            <section>
                <h3>{tr.preferencesTabSynchronisation()}</h3>
                <label class="check">
                    <input type="checkbox" bind:checked={autoSync} />
                    {tr.preferencesAutomaticallySyncOnProfileOpenclose()}
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={syncMedia} />
                    {tr.preferencesSynchronizeAudioAndImagesToo()}
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={periodicMedia} disabled={!syncMedia} />
                    {tr.preferencesPeriodicallySyncMedia()}
                </label>
                <label class="check">
                    <input type="checkbox" bind:checked={fullSync} />
                    {tr.preferencesOnNextSyncForceChangesIn()}
                </label>
                <button type="button" class="btn btn-secondary" onclick={() => void showMediaLog()}>
                    {tr.syncMediaLogButton()}
                </button>
            </section>
            <section>
                <h3>{tr.preferencesNetwork()}</h3>
                <label class="row">
                    <span>{tr.preferencesCustomSyncUrl()}</span>
                    <input type="url" bind:value={customSyncUrl} />
                </label>
                <p class="note">{tr.preferencesCustomSyncUrlDisclaimer()}</p>
                <label class="row">
                    <span>{tr.preferencesNetworkTimeout()}</span>
                    <span class="inline">
                        <input type="number" min="30" max="99999" bind:value={networkTimeout} />
                        {tr.schedulingSeconds()}
                    </span>
                </label>
            </section>
        {:else if tab === "backups" && prefs?.backups}
            <section>
                <p class="note">{tr.preferencesBackupExplanation()}</p>
                <label class="row">
                    <span>{tr.preferencesMinutesBetweenBackups()}</span>
                    <input type="number" min="5" max="9999" bind:value={prefs.backups.minimumIntervalMins} />
                </label>
                <label class="row">
                    <span>{tr.preferencesDailyBackups()}</span>
                    <input type="number" min="0" max="9999" bind:value={prefs.backups.daily} />
                </label>
                <label class="row">
                    <span>{tr.preferencesWeeklyBackups()}</span>
                    <input type="number" min="0" max="9999" bind:value={prefs.backups.weekly} />
                </label>
                <label class="row">
                    <span>{tr.preferencesMonthlyBackups()}</span>
                    <input type="number" min="0" max="9999" bind:value={prefs.backups.monthly} />
                </label>
                <p class="note">{tr.preferencesMediaIsNotBackedUp()}</p>
            </section>
            <section>
                <h3>Storage on this device</h3>
                {#if $storagePersisted}
                    <p class="note">This browser keeps Anki's data until you delete it.</p>
                {:else if $storagePersisted === false}
                    <p class="warning">{STORAGE_WARNING}</p>
                {/if}
                {#if storageUse}
                    <p class="note">Anki uses {megabytes(storageUse.usage)} of the {megabytes(storageUse.quota)} it may use here.</p>
                {/if}
                <div class="inline">
                    {#if $storagePersisted === false}
                        <button type="button" class="btn btn-secondary" onclick={() => void checkStorage()}>Ask again</button>
                    {/if}
                    <button type="button" class="btn btn-secondary" onclick={() => void onOpenBackup()}>
                        Download a backup…
                    </button>
                </div>
            </section>
        {:else if tab === "labs"}
            <iframe class="labs" src="/preferences" title={tr.preferencesExperimentalFeaturesTab()}></iframe>
        {/if}
    </div>

    <footer>
        <button
            type="button"
            class="btn btn-primary"
            onclick={() => void win.requestClose()}
        >
            {tr.actionsClose()}
        </button>
    </footer>
</div>

<style lang="scss">
    .prefs {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }

    .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem;
        padding: 0.5rem 0.75rem 0;
        border-bottom: 1px solid var(--border-subtle);
        button {
            padding: 0.4rem 0.75rem;
            border: 1px solid transparent;
            border-bottom: none;
            border-radius: var(--border-radius) var(--border-radius) 0 0;
            background: transparent;
            color: var(--fg-subtle);
            &.active {
                border-color: var(--border-subtle);
                background: var(--canvas);
                color: var(--fg);
                margin-bottom: -1px;
            }
        }
    }

    .content {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 0.75rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    section {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        align-items: flex-start;
    }

    h3 {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
    }

    .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        width: 100%;
        > span:first-child {
            flex: 1;
        }
        select,
        input[type="text"],
        input[type="url"] {
            max-width: 60%;
        }
    }

    .inline {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
    }

    input[type="number"] {
        width: 5.5rem;
    }

    .check {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .indent {
        margin-inline-start: 1.6rem;
    }

    .note {
        margin: 0;
        color: var(--fg-subtle);
        font-size: 0.9em;
    }

    .warning {
        margin: 0;
        font-size: 0.9em;
        color: var(--accent-danger);
    }

    .labs {
        flex: 1;
        min-height: 20rem;
        border: 0;
        width: 100%;
    }

    footer {
        display: flex;
        justify-content: flex-end;
        padding: 0.5rem 1rem;
        border-top: 1px solid var(--border-subtle);
    }
</style>
