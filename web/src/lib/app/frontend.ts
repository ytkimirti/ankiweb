// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * FrontendService: the methods desktop's mediasrv.py implements in Python
 * for its web pages, implemented here for the web build.
 */

import { BackendError_Kind } from "@generated/anki/backend_pb";
import { OpChanges } from "@generated/anki/collection_pb";
import { UpdateDeckConfigsMode, UpdateDeckConfigsRequest } from "@generated/anki/deck_config_pb";
import {
    AskUserRequest,
    ConvertPastedImageRequest,
    ConvertPastedImageResponse,
    MessageBoxType,
    openFilePickerRequest,
    ReadClipboardRequest,
    ReadClipboardResponse,
    SetSettingJsonRequest,
    ShowMessageBoxRequest,
    WriteClipboardRequest,
} from "@generated/anki/frontend_pb";
import { Bool, Empty, Json, String as PbString } from "@generated/anki/generic_pb";
import { ChangeNotetypeRequest } from "@generated/anki/notetypes_pb";
import { SearchNode } from "@generated/anki/search_pb";
import * as tr from "@generated/ftl";

import { BackendError } from "../engine/client";
import { callEngine, type CallContext, getEngine, registerFrontendMethod } from "./backend";
import { askUser, showInfo, tooltip } from "./dialogs";
import { fileToEnginePath, IMAGE_EXTENSIONS, pickFiles } from "./files";
import { sourceWindow } from "./host";
import { mediaUrl } from "./media";
import { confirmSchemaModification, getMeta, getProfileConfig, setMeta, setProfileConfig } from "./profiles";
import { avPlayer } from "./sound";

const empty = () => new Empty().toBinary();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonOutput(value: unknown): Uint8Array {
    return new Json({ json: encoder.encode(JSON.stringify(value ?? null)) }).toBinary();
}

/** Desktop's AddCards, EditCurrent and similar windows register their handlers here. */
export interface WindowCommands {
    /** Resolves once any prompt is answered, so closeAllWindows can wait for it. */
    closeAddCards?: (prompt: boolean) => void | Promise<void>;
    closeEditCurrent?: () => void;
    openFieldsDialog?: () => void;
    openCardsDialog?: () => void;
    deckOptionsReady?: () => void;
    importDone?: () => void;
    /** The notes a change-notetype window applies to. */
    changeNotetypeNoteIds?: bigint[];
}

const windowCommands = new WeakMap<object, WindowCommands>();

/** Registers commands for a window, adding to any it already has. */
export function setWindowCommands(key: object, commands: WindowCommands): void {
    windowCommands.set(key, { ...windowCommands.get(key), ...commands });
}

function commandsFor(ctx: CallContext): WindowCommands | undefined {
    const win = sourceWindow(ctx.source);
    return win ? windowCommands.get(win) : undefined;
}

function closeSource(ctx: CallContext): void {
    sourceWindow(ctx.source)?.close();
}

let searchHandler: ((node: SearchNode) => void) | null = null;

/** The browser registers itself to receive searchInBrowser requests. */
export function setSearchInBrowserHandler(handler: ((node: SearchNode) => void) | null): void {
    searchHandler = handler;
}

async function convertImage(data: Uint8Array, ext: string): Promise<Uint8Array> {
    const bitmap = await createImageBitmap(new Blob([data as BlobPart]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const blob = await canvas.convertToBlob({ type, quality: ext === "png" ? 0.5 : 0.8 });
    return new Uint8Array(await blob.arrayBuffer());
}

async function readClipboard(types: string[]): Promise<Record<string, Uint8Array>> {
    const data: Record<string, Uint8Array> = {};
    try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
            for (const type of types) {
                if (item.types.includes(type) && !data[type]) {
                    data[type] = new Uint8Array(await (await item.getType(type)).arrayBuffer());
                }
            }
        }
    } catch (err) {
        console.warn("clipboard read failed", err);
    }
    return data;
}

async function writeClipboard(data: Record<string, Uint8Array>): Promise<void> {
    const entries: Record<string, Blob> = {};
    for (const [type, bytes] of Object.entries(data)) {
        if (ClipboardItem.supports?.(type) ?? true) {
            entries[type] = new Blob([bytes as BlobPart], { type });
        }
    }
    await navigator.clipboard.write([new ClipboardItem(entries)]);
}

export function registerFrontendHandlers(): void {
    // Settings
    registerFrontendMethod("getProfileConfigJson", (input) => {
        return jsonOutput(getProfileConfig(PbString.fromBinary(input).val, null));
    });
    registerFrontendMethod("setProfileConfigJson", (input) => {
        const req = SetSettingJsonRequest.fromBinary(input);
        setProfileConfig(req.key, JSON.parse(decoder.decode(req.valueJson)));
        return empty();
    });
    registerFrontendMethod("getMetaJson", (input) => {
        return jsonOutput(getMeta(PbString.fromBinary(input).val, null));
    });
    registerFrontendMethod("setMetaJson", (input) => {
        const req = SetSettingJsonRequest.fromBinary(input);
        setMeta(req.key, JSON.parse(decoder.decode(req.valueJson)));
        return empty();
    });
    // desktop returns null for missing keys rather than an error
    registerFrontendMethod("getConfigJson", async (input) => {
        try {
            return await getEngine().callMethod("getConfigJson", input);
        } catch (err) {
            if (err instanceof BackendError && err.kind === BackendError_Kind.NOT_FOUND_ERROR) {
                return jsonOutput(null);
            }
            throw err;
        }
    });

    // Dialogs
    registerFrontendMethod("askUser", async (input) => {
        const req = AskUserRequest.fromBinary(input);
        const answer = await askUser(req.text, { title: req.title, defaultNo: req.defaultNo });
        return new Bool({ val: answer }).toBinary();
    });
    registerFrontendMethod("showMessageBox", async (input) => {
        const req = ShowMessageBoxRequest.fromBinary(input);
        const kind = req.type === MessageBoxType.WARNING
            ? "warning"
            : req.type === MessageBoxType.CRITICAL
            ? "critical"
            : "info";
        await showInfo(req.text, { title: req.title, kind, html: req.textFormat !== "plain" });
        return new Bool({ val: true }).toBinary();
    });
    registerFrontendMethod("openLink", (input) => {
        window.open(PbString.fromBinary(input).val, "_blank", "noopener");
        return empty();
    });

    // Files and media
    registerFrontendMethod("openFilePicker", async (input) => {
        const req = openFilePickerRequest.fromBinary(input);
        const accept = req.extensions.map((ext) => `.${ext}`).join(",");
        const [file] = await pickFiles({ accept });
        const path = file ? await fileToEnginePath(file, file.name) : "";
        return new PbString({ val: path }).toBinary();
    });
    registerFrontendMethod("openMedia", (input) => {
        const name = PbString.fromBinary(input).val;
        if (IMAGE_EXTENSIONS.includes(name.split(".").pop()?.toLowerCase() ?? "")) {
            window.open(mediaUrl(name), "_blank", "noopener");
        }
        return empty();
    });
    registerFrontendMethod("showInMediaFolder", (input) => {
        window.open(mediaUrl(PbString.fromBinary(input).val), "_blank", "noopener");
        return empty();
    });
    registerFrontendMethod("playFile", (input) => {
        avPlayer.playFile(PbString.fromBinary(input).val);
        return empty();
    });
    registerFrontendMethod("recordAudio", async () => {
        const { recordAudioDialog } = await import("./actions");
        const path = await recordAudioDialog();
        return new PbString({ val: path ?? "" }).toBinary();
    });
    registerFrontendMethod("convertPastedImage", async (input) => {
        const req = ConvertPastedImageRequest.fromBinary(input);
        return new ConvertPastedImageResponse({ data: await convertImage(req.data, req.ext) }).toBinary();
    });
    registerFrontendMethod("readClipboard", async (input) => {
        const req = ReadClipboardRequest.fromBinary(input);
        return new ReadClipboardResponse({ data: await readClipboard(req.types) }).toBinary();
    });
    registerFrontendMethod("writeClipboard", async (input) => {
        await writeClipboard(WriteClipboardRequest.fromBinary(input).data);
        return empty();
    });
    // the browser's colour picker has no custom palette to save
    registerFrontendMethod("saveCustomColours", () => empty());

    // Windows
    registerFrontendMethod("searchInBrowser", async (input) => {
        const node = SearchNode.fromBinary(input);
        if (searchHandler) {
            searchHandler(node);
        } else {
            const { openBrowser } = await import("./actions");
            openBrowser({ search: node });
        }
        return empty();
    });
    registerFrontendMethod("closeAddCards", async (input, ctx) => {
        const prompt = Bool.fromBinary(input).val;
        const commands = commandsFor(ctx);
        if (commands?.closeAddCards) {
            await commands.closeAddCards(prompt);
        } else if (!prompt || await askUser(tr.addingDiscardCurrentInput(), { yes: tr.actionsDiscard(), no: tr.addingKeepEditing() })) {
            closeSource(ctx);
        }
        return empty();
    });
    registerFrontendMethod("closeEditCurrent", (_input, ctx) => {
        const commands = commandsFor(ctx);
        if (commands?.closeEditCurrent) {
            commands.closeEditCurrent();
        } else {
            closeSource(ctx);
        }
        return empty();
    });
    registerFrontendMethod("openFieldsDialog", (_input, ctx) => {
        commandsFor(ctx)?.openFieldsDialog?.();
        return empty();
    });
    registerFrontendMethod("openCardsDialog", (_input, ctx) => {
        commandsFor(ctx)?.openCardsDialog?.();
        return empty();
    });
    registerFrontendMethod("deckOptionsReady", (_input, ctx) => {
        commandsFor(ctx)?.deckOptionsReady?.();
        return empty();
    });
    registerFrontendMethod("deckOptionsRequireClose", (_input, ctx) => {
        closeSource(ctx);
        return empty();
    });
    registerFrontendMethod("updateDeckConfigs", async (input, ctx) => {
        const output = await callEngineWithChanges("updateDeckConfigs", input, 1, ctx);
        const req = UpdateDeckConfigsRequest.fromBinary(input);
        if (req.mode !== UpdateDeckConfigsMode.COMPUTE_ALL_PARAMS) {
            closeSource(ctx);
        }
        return output;
    });
    registerFrontendMethod("changeNotetype", async (input, ctx) => {
        const request = ChangeNotetypeRequest.fromBinary(input);
        const noteIds = commandsFor(ctx)?.changeNotetypeNoteIds;
        if (noteIds) {
            request.noteIds = noteIds;
        }
        if (!(await confirmSchemaModification())) {
            return new OpChanges().toBinary();
        }
        const output = await callEngineWithChanges("changeNotetype", request.toBinary(), 1, ctx);
        tooltip(tr.browsingNotesUpdated({ count: request.noteIds.length }));
        closeSource(ctx);
        return output;
    });
    registerFrontendMethod("importDone", (_input, ctx) => {
        commandsFor(ctx)?.importDone?.();
        return empty();
    });
    registerFrontendMethod("importDialogRequireClose", (_input, ctx) => {
        closeSource(ctx);
        return empty();
    });
}

/** Runs a backend method from an override, still broadcasting its changes. */
function callEngineWithChanges(
    method: string,
    input: Uint8Array,
    opChangesType: number,
    ctx: CallContext,
): Promise<Uint8Array> {
    return callEngine(method, input, opChangesType, ctx);
}

