// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Which plugins are running, and starting and stopping them. Every load and
 * unload waits its turn in one queue, so a plugin removed while it (or another
 * plugin its module registered) is still starting is stopped once it has
 * started, never half-way. Kept apart from loader.ts, which supplies the app's
 * API, so it can be tested on its own.
 */

export interface Startable<Api> {
    name: string;
    /** May return a function that undoes what setup did besides hooks and styles. */
    setup(api: Api): void | (() => void) | Promise<void | (() => void)>;
}

export interface PluginRecord {
    name: string;
    /** Its URL, or for another plugin its module registered, the URL and a number. */
    key: string;
    disposers: (() => void)[];
    configAction: (() => void | Promise<void>) | null;
    /** Whether the plugin said how to undo itself, so it can be removed without a reload. */
    unloadable: boolean;
}

export interface RegistryOptions<P extends Startable<Api>, Api> {
    /** The API a plugin's setup gets; what it adds is recorded in the record's disposers. */
    apiFor(record: PluginRecord): Api;
    importModule(url: string): Promise<{ default?: P }>;
    /** How long a plugin may take to start, so a stuck one cannot hold up the others. */
    timeoutMs: number;
    /** How long a module may take to import, for the same reason. */
    importTimeoutMs: number;
    /** Whether a plugin under this key can be removed without a reload, whatever it returns. */
    unloadableByDefault(key: string): boolean;
}

export class PluginRegistry<P extends Startable<Api>, Api> {
    readonly loaded = new Map<string, PluginRecord>();
    /** The keys each module's plugins run under, its own first. */
    private modules = new Map<string, string[]>();
    /** What each module registered when imported, as importing it again runs no code. */
    private selfRegistered = new Map<string, P[]>();
    /** While a module is imported, the plugins it registers. */
    private capturing: P[] | null = null;
    /**
     * An import given up on that has not finished. Until it does, what is
     * registered may be its doing, so it is dropped rather than credited to
     * another module, and no other module is imported.
     */
    private stuckImport: string | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private opts: RegistryOptions<P, Api>) {}

    /** Runs `fn` after every load and unload before it. */
    private inTurn<T>(fn: () => Promise<T> | T): Promise<T> {
        const turn = this.queue.then(fn);
        this.queue = turn.catch(() => {});
        return turn;
    }

    /** Imports a plugin module and starts what it exports or registers. */
    load(url: string): Promise<void> {
        return this.inTurn(() => this.loadNow(url));
    }

    /** Stops a module's plugins; resolves false if a reload is needed to finish. */
    unload(url: string): Promise<boolean> {
        return this.inTurn(() => this.unloadNow(url));
    }

    /**
     * Starts a plugin registered by other means, replacing one under the same
     * key. It waits its turn, so a setup that waits for this fails when its
     * time is up (see registerGlobal in loader.ts).
     */
    register(plugin: P, key: string): Promise<void> {
        return this.inTurn(async () => {
            this.unloadNow(key);
            this.modules.set(key, [key]);
            await this.start(plugin, key);
        });
    }

    /** Takes a plugin a module registers while it is imported; false if none is. */
    capture(plugin: P): boolean {
        if (this.stuckImport !== null) {
            console.warn(`plugin ${plugin.name} not started: ${this.stuckImport} is still loading`);
            return true;
        }
        this.capturing?.push(plugin);
        return this.capturing !== null;
    }

    private async loadNow(url: string): Promise<void> {
        if (this.loaded.has(url)) {
            return;
        }
        if (this.stuckImport !== null) {
            throw new Error(`${this.stuckImport} is still loading; reload the page to try again`);
        }
        this.unloadNow(url);
        const captured: P[] = [];
        this.capturing = captured;
        let exported: P | undefined;
        const importing = Promise.resolve().then(() => this.opts.importModule(url));
        try {
            const module = await withTimeout(importing, this.opts.importTimeoutMs, `${url} took too long to load`);
            exported = module.default?.setup ? module.default : undefined;
        } catch (err) {
            if (err instanceof TimeoutError) {
                // the queue moves on, but what the module registers when it
                // finishes must not land in the next import
                this.stuckImport = url;
                importing.catch(() => {}).finally(() => {
                    this.stuckImport = null;
                });
            }
            throw err;
        } finally {
            this.capturing = null;
        }
        if (captured.length) {
            this.selfRegistered.set(url, captured);
        }
        const registered = this.selfRegistered.get(url) ?? [];
        const main = exported ?? registered[0];
        if (!main) {
            throw new Error(`${url} has no default export with a setup function, and registered no plugin`);
        }
        // a newline keeps the others' keys apart from any installed URL
        const others = registered.filter((p) => p !== main).map((p, i) => [p, `${url}\n${i + 1}`] as const);
        this.modules.set(url, [url, ...others.map(([, key]) => key)]);
        try {
            await this.start(main, url);
        } catch (err) {
            this.modules.delete(url);
            throw err;
        }
        for (const [other, key] of others) {
            await this.start(other, key).catch((err) => console.error(`plugin ${other.name} failed to load`, err));
        }
    }

    private unloadNow(url: string): boolean {
        let done = true;
        for (const key of this.modules.get(url) ?? [url]) {
            const record = this.loaded.get(key);
            if (record) {
                this.loaded.delete(key);
                runDisposers(record);
                done &&= record.unloadable;
            }
        }
        this.modules.delete(url);
        return done;
    }

    private async start(plugin: P, key: string): Promise<void> {
        const record: PluginRecord = {
            name: plugin.name,
            key,
            disposers: [],
            configAction: null,
            unloadable: this.opts.unloadableByDefault(key),
        };
        const setup = Promise.resolve().then(() => plugin.setup(this.opts.apiFor(record)));
        try {
            const dispose = await withTimeout(setup, this.opts.timeoutMs, `plugin ${plugin.name} took too long to start`);
            if (typeof dispose === "function") {
                record.disposers.push(dispose);
                record.unloadable = true;
            }
        } catch (err) {
            runDisposers(record);
            // one that finishes starting after giving up is undone then
            setup.then((dispose) => {
                if (typeof dispose === "function") {
                    record.disposers.push(dispose);
                }
                runDisposers(record);
            }, () => runDisposers(record));
            throw err;
        }
        this.loaded.set(key, record);
    }
}

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function runDisposers(record: PluginRecord): void {
    for (const dispose of record.disposers.splice(0).reverse()) {
        try {
            dispose();
        } catch (err) {
            console.error(`plugin ${record.name} failed to unload`, err);
        }
    }
}
