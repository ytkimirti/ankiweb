import "@poppanator/sveltekit-svg/dist/svg";

declare global {
    namespace App {}
    /** The Anki version this build is from (.version). */
    const __ANKI_VERSION__: string;
    /** Bytes in engine/anki.wasm at build time; 0 if it was missing. */
    const __ANKI_WASM_SIZE__: number;

    // not yet in TypeScript's DOM types
    interface FileSystemDirectoryHandle {
        entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
    }
}

export {};
