import "@poppanator/sveltekit-svg/dist/svg";

declare global {
    namespace App {}
    /** The Anki version this build is from (.version). */
    const __ANKI_VERSION__: string;

    // not yet in TypeScript's DOM types
    interface FileSystemDirectoryHandle {
        entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
    }
}

export {};
