# Anki for the web

Desktop Anki running entirely in the browser as an installable, offline-capable
PWA. Nothing is rewritten: the Rust core (`rslib`) is compiled to WebAssembly,
and the desktop's Svelte pages (`ts/`) are reused as they are. The Qt shell
(`qt/aqt`) is the only part reimplemented, in `web/src/lib`.

## How it fits together

- `web/wasm` builds `rslib` for `wasm32-wasip1`. It runs in a worker
  (`src/lib/engine`) with a small WASI implementation: collections and the
  media database live in a pool of OPFS sync access handles, media files and
  backups are plain OPFS files, and sync requests go through `fetch`.
- `src/lib/app` is the port of `aqt`: profiles, the main window states, the
  reviewer, sync, backups, importing and exporting, and the handlers for the
  `FrontendService` calls the `ts/` pages make (`frontend.ts`).
- `src/lib/ui` holds the windows desktop builds with Qt widgets: the deck
  list, overview, reviewer, browser, note types, card layout, preferences and
  the smaller dialogs.
- The `ts/` pages (editor, deck options, statistics, image occlusion, import,
  change notetype, card info and so on) run unchanged in same-origin iframes.
  Their `bridgeCommand()` and backend calls reach the app through
  `window.parent.__ankiHost` (`src/lib/app/host.ts`).
- Cards are shown by desktop's reviewer script in card frames, which run card
  HTML and its scripts. Those load from a separate card origin when one is
  configured, so card scripts cannot read the app's storage, the sync key or
  call the backend. A card frame talks to the app only through `postMessage`
  (`src/lib/app/cardframe.ts` and `cardpage.ts`): bridge commands, the
  backend methods custom scheduling needs, and media files, which the card
  origin's service worker requests through the frame.
- `src/service-worker.ts` caches the app for offline use, adds the COOP/COEP
  headers the engine needs for `SharedArrayBuffer`, and serves media files at
  the site root from the open profile's media folder, like desktop's media
  server.

Only one tab can have the app open at a time, because a collection can only be
opened once.

## Building

Building needs Rust with the `wasm32-wasip1` target, wasi-sdk, `wasm-opt`,
`protoc` and the repo's node modules (`./yarn` at the root).

```
WASI_SDK=/path/to/wasi-sdk web/scripts/build-wasm.sh   # web/static/engine/anki.wasm
web/scripts/gen-ts.sh                                  # protobuf, backend and ftl modules
web/scripts/vendor.sh                                  # MathJax and shared images
cd web && ../node_modules/.bin/vite build              # web/build
node scripts/sw-integrity.mjs                          # file hashes for the service worker
```

`vite dev` and `vite preview` send the isolation headers and proxy AnkiWeb, so
sync works locally too.

Set `VITE_CARD_ORIGIN` when building to load card frames from another origin
that serves the same build, for example `VITE_CARD_ORIGIN=https://cards.example.com`.
Without it, cards run on the app's origin as desktop's do, and card scripts
can reach the rest of the app.

## Deploying

`web/build` is a static site. AnkiWeb does not allow cross-origin requests, so
the host must forward `/ankiweb-proxy/<host>/<path>` to
`https://<host>/<path>` for `ankiweb.net` hosts. The sync `meta` request can
be redirected to another AnkiWeb server, which the browser would follow
cross-origin, so the proxy must return such redirects as a 200 with
`x-ankiweb-redirect` (the status) and `x-ankiweb-location` headers. The host
should also send the `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers, and `Cross-Origin-Resource-Policy:
cross-origin` and `Cross-Origin-Embedder-Policy: require-corp` for `/reviewer`.
`web/vercel.json` and `web/api` do all of this
for Vercel:

```
cp -r web/vercel.json web/api web/build/ && vercel deploy web/build --prod
```

Serve the card origin from the same deployment by adding its domain to the
project.

## Plugins

Desktop add-ons are Python and cannot run here. The app is instead built so
they can be rebuilt as web-native plugins: an ES module whose default export
names the plugin and receives an API object when the app starts.

```js
// my-plugin.js
export default {
    name: "Answer timer",
    setup(api) {
        const started = new Map();
        api.hooks.reviewerDidShowQuestion.append((card) => started.set(card.cardId, Date.now()));
        api.hooks.reviewerDidAnswerCard.append((card, ease) => {
            const seconds = (Date.now() - started.get(card.cardId)) / 1000;
            api.dialogs.tooltip(`Answered ${ease} after ${seconds.toFixed(1)}s`);
        });
        api.hooks.mainMenuWillShow.append((sections) => {
            sections.find((s) => s.title === "Tools")?.items.push({
                label: "Answer timer settings",
                action: () => api.dialogs.showInfo("Nothing to set yet."),
            });
        });
    },
};
```

Install a plugin from Tools > Add-ons by its URL. The module must be served
with CORS headers if it is on another origin, since module scripts are always
fetched with CORS. Installed plugins are stored in the profile-independent
settings and load on the next start; a plugin that fails to load is skipped and
logged to the console. Code can also call
`globalThis.ankiweb.registerPlugin(plugin)` directly.

### The API

| Member | What it gives you |
| --- | --- |
| `hooks` | Hook points, named after desktop's `gui_hooks` (see below). |
| `backend` | Every backend method, typed, as in `@generated/backend`. Changes made with them are broadcast to the open windows. |
| `tr` | Translations, as in `@generated/ftl`. |
| `dialogs` | `showInfo`, `showWarning`, `askUser`, `getText`, `chooseFrom`, `openForm`, `tooltip`. |
| `windows` | `openWindow` for a Svelte component or a page URL, `findWindow`, `closeAllWindows`. |
| `menus` | `popupMenu` for context menus. |
| `actions` | The main window's actions: `onAddCard`, `onBrowse`, `onStats`, `openBrowser`, `onSync` and the rest. |
| `main` | The main window state (`deckBrowser`, `overview`, `review`) and `moveToState`. |
| `reviewer` | The running reviewer: the current card and its rendered text. |
| `registerFrontendMethod` | Answers a `FrontendService` method, for plugin pages that call one. |
| `getConfig(fallback)` / `setConfig(value)` | Settings kept for this plugin. |

### Hooks

A `Hook` notifies listeners; a `Filter` passes a value through each listener,
which returns the value to use. Both have `append(fn)`, which returns a
function that removes the listener.

| Hook | Desktop equivalent |
| --- | --- |
| `stateWillChange`, `stateDidChange` | `state_will_change`, `state_did_change` |
| `mainMenuWillShow` | adding to `mw.form.menu*` |
| `operationDidExecute` | `operation_did_execute` |
| `profileDidOpen`, `profileWillClose` | `profile_did_open`, `profile_will_close` |
| `syncWillStart`, `syncDidFinish` | `sync_will_start`, `sync_did_finish` |
| `deckBrowserDidRender` | `deck_browser_did_render` |
| `deckBrowserWillShowOptionsMenu` | `deck_browser_will_show_options_menu` |
| `overviewDidRefresh` | `overview_did_refresh` |
| `overviewWillRenderBottom` (filter) | `overview_will_render_bottom` |
| `cardWillShow` (filter) | `card_will_show` |
| `fieldFilter` (filter) | `field_filter` |
| `reviewerDidShowQuestion`, `reviewerDidShowAnswer` | `reviewer_did_show_question`, `reviewer_did_show_answer` |
| `reviewerWillAnswerCard` (filter) | `reviewer_will_answer_card` |
| `reviewerDidAnswerCard` | `reviewer_did_answer_card` |
| `reviewerWillShowContextMenu` | `reviewer_will_show_context_menu` |
| `reviewerWillEnd` | `reviewer_will_end` |
| `webviewDidReceiveBridgeCommand` (filter) | `webview_did_receive_js_message` |
| `editorDidLoadNote` | `editor_did_load_note` |

Card HTML can still call `pycmd("myplugin:...")`; handle it with
`webviewDidReceiveBridgeCommand`, returning `[true, result]` when handled.

## Differences from desktop

- LaTeX is not rendered, since there is no TeX install to run; MathJax works.
- Text to speech uses the browser's voices.
- Ctrl+N and Ctrl+W belong to the browser and cannot be used as shortcuts.
- Media sync blocks other collection work while it runs, so the periodic media
  sync only runs from the deck list.
- Safari has no `credentialless` embedding, so cards there can only show
  images from other sites that send `Cross-Origin-Resource-Policy` headers.
