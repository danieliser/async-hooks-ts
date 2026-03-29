/**
 * HookScope — execution context for async-hooks-ts.
 *
 * Scopes are async-context-local via AsyncLocalStorage: two concurrent Promise
 * chains each have their own active scope and do not interfere.
 *
 * Usage:
 *   await hooks.scope('myBatch', { requestId: 'r-1' }).run(async (scope) => {
 *     await hooks.doAction('task.created', payload);
 *     console.log(scope.didAction('task.created')); // 1
 *   });
 */

import type { AsyncHooks } from './manager';

/**
 * AsyncLocalStorage — universal runtime detection.
 *
 * Node.js: full async context tracking across await boundaries via
 * the native AsyncLocalStorage from async_hooks.
 *
 * Browser/Deno/Workers: synchronous fallback — scopes work within a
 * single call stack but won't carry across microtask boundaries. The
 * core hooks/filters work identically either way; only scope.didAction()
 * counts may diverge in highly concurrent browser code.
 */
interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

// Synchronous fallback — works everywhere, no async context tracking
class SyncLocalStorage<T> implements AsyncLocalStorageLike<T> {
  private _store: T | undefined;
  getStore(): T | undefined { return this._store; }
  run<R>(store: T, fn: () => R): R {
    const prev = this._store;
    this._store = store;
    try { return fn(); }
    finally { this._store = prev; }
  }
}

// Runtime detection: use Node's AsyncLocalStorage if available,
// otherwise fall back to synchronous scope tracking.
//
// Static require/import of 'node:async_hooks' breaks bundlers (esbuild,
// webpack, Vite) even inside try/catch — they analyze statically.
// We use globalThis.__require (set by Node) or check for process.versions
// to detect Node, then load async_hooks via the module system dynamically.
let _als: AsyncLocalStorageLike<HookScope>;

// In Node.js, globalThis.process exists and has version info
const _isNode = typeof globalThis !== 'undefined'
  && typeof globalThis.process?.versions?.node === 'string';

if (_isNode) {
  // Node.js — use native AsyncLocalStorage for full async context tracking.
  // The 'module' global is available in CJS; for ESM we'd need import().
  // Since this runs at module evaluation time and vitest/Node support
  // top-level require via createRequire, we use a dynamic string to
  // prevent bundler static analysis.
  try {
    const mod = 'async_hooks';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ah = require(mod);
    _als = new ah.AsyncLocalStorage();
  } catch {
    _als = new SyncLocalStorage();
  }
} else {
  // Browser / Deno / Workers — synchronous scope tracking
  _als = new SyncLocalStorage();
}

/** Module-level storage — carries HookScope through async chains (Node) or call stacks (browser). */
export const _storage: AsyncLocalStorageLike<HookScope> = _als;

class HookContext {
  readonly metadata: Record<string, unknown>;
  private readonly _actionsFired = new Map<string, number>();
  private readonly _filtersApplied = new Map<string, number>();

  constructor(metadata: Record<string, unknown>) {
    this.metadata = metadata;
  }

  recordAction(hookName: string): void {
    this._actionsFired.set(hookName, (this._actionsFired.get(hookName) ?? 0) + 1);
  }

  recordFilter(hookName: string): void {
    this._filtersApplied.set(hookName, (this._filtersApplied.get(hookName) ?? 0) + 1);
  }

  didAction(hookName: string): number {
    return this._actionsFired.get(hookName) ?? 0;
  }

  didFilter(hookName: string): number {
    return this._filtersApplied.get(hookName) ?? 0;
  }
}

export class HookScope {
  readonly name: string;
  readonly hooks: AsyncHooks;
  private readonly _ctx: HookContext;
  private _parent: HookScope | null = null;

  constructor(hooks: AsyncHooks, name = '', metadata: Record<string, unknown> = {}) {
    this.hooks = hooks;
    this.name = name;
    this._ctx = new HookContext(metadata);
  }

  /** Parent scope if this scope was entered inside another scope, or null. */
  get parent(): HookScope | null {
    return this._parent;
  }

  /** Metadata passed when creating the scope. */
  get metadata(): Record<string, unknown> {
    return this._ctx.metadata;
  }

  /** How many times has hookName fired as an action within this scope? */
  didAction(hookName: string): number {
    return this._ctx.didAction(hookName);
  }

  /** How many times has hookName been applied as a filter within this scope? */
  didFilter(hookName: string): number {
    return this._ctx.didFilter(hookName);
  }

  /** Called internally by AsyncHooks when an action fires. */
  recordAction(hookName: string): void {
    this._ctx.recordAction(hookName);
  }

  /** Called internally by AsyncHooks when a filter is applied. */
  recordFilter(hookName: string): void {
    this._ctx.recordFilter(hookName);
  }

  /** Whether hookName is currently executing as an action (globally). */
  doingAction(hookName: string): boolean {
    return this.hooks.doingAction(hookName);
  }

  /** Whether hookName is currently executing as a filter (globally). */
  doingFilter(hookName: string): boolean {
    return this.hooks.doingFilter(hookName);
  }

  /**
   * Convenience accessor for metadata by key.
   * Equivalent to scope.metadata[key].
   */
  get<T = unknown>(key: string): T | undefined {
    return this._ctx.metadata[key] as T | undefined;
  }

  /**
   * Run fn within this scope. Equivalent to Python's `async with hooks.scope(...) as scope:`.
   *
   * The scope is active for the entire async chain of fn — any await inside fn
   * will see this scope as the current scope via AsyncLocalStorage.
   *
   * Nesting is supported: if called inside another scope.run(), the outer scope
   * becomes this scope's parent.
   *
   *   await hooks.scope('outer', { reqId: 'r1' }).run(async (outer) => {
   *     await hooks.scope('inner').run(async (inner) => {
   *       inner.parent === outer; // true
   *     });
   *   });
   */
  async run<T>(fn: (scope: HookScope) => Promise<T>): Promise<T> {
    this._parent = _storage.getStore() ?? null;
    return _storage.run(this, () => fn(this));
  }
}
