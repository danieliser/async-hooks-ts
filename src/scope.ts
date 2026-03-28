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

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AsyncHooks } from './manager';

/** Module-level AsyncLocalStorage — one storage per process, carries HookScope through async chains. */
export const _storage = new AsyncLocalStorage<HookScope>();

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
