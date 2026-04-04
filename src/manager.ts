/**
 * AsyncHooks — WordPress-style async actions and filters for TypeScript.
 *
 * Supports:
 *  - Priority-ordered callbacks (lower number = higher priority)
 *  - Sync and async callbacks (both are awaited transparently)
 *  - Per-callback timeouts (action default: 30s, filter default: none)
 *  - Detached action callbacks (fire-and-forget, non-blocking)
 *  - Deferred removal during execution (re-entrancy safe)
 *  - Global wildcard handlers (subscribeAll / unsubscribeAll)
 *  - Namespace prefix routing (task.* etc)
 *  - Execution scopes (didAction, didFilter, currentScope)
 *  - Introspection (registeredEvents, describe, describeAll)
 *  - Typed payload validation (registerSchema / validatePayloads)
 */

// Use globalThis.crypto.randomUUID() — works in Node 19+, all modern browsers,
// Deno, Bun, and Cloudflare Workers. No Node-specific import needed.
const randomUUID = (): string => globalThis.crypto.randomUUID();
import { _storage, HookScope } from './scope';
import {
  ActionOptions,
  AsyncHooksOptions,
  CallbackCategory,
  CallbackType,
  DuplicateCallbackError,
  FilterOptions,
  HandlerInfo,
  HookPayloadError,
  PayloadSchema,
  VetoError,
} from './types';

const DEFAULT_ACTION_TIMEOUT = 30;
const DEFAULT_FILTER_TIMEOUT: number | null = null;

// ─ Timeout helpers ────────────────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(timeoutSecs: number) {
    super(`Hook listener timed out after ${timeoutSecs}s`);
    this.name = 'TimeoutError';
  }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof TimeoutError;
}

async function runWithTimeout<T>(fn: () => T | Promise<T>, timeoutSecs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(timeoutSecs)), timeoutSecs * 1000);
  });
  try {
    return await Promise.race([Promise.resolve(fn()), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// ─ Callback helpers ───────────────────────────────────────────────────────────

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof (value as Record<string, unknown>)['then'] === 'function';
}

function resolveHandlerName(cb: CallbackType): string {
  return cb.name || '<anonymous>';
}

// ─ Type aliases ───────────────────────────────────────────────────────────────

type PriorityMap = Map<number, Array<[string, CallbackType]>>;
type GlobalEntry = [string, CallbackType, string | null]; // [callbackId, callback, namespace]

// ─ Main class ─────────────────────────────────────────────────────────────────

export class AsyncHooks {
  // Hook name → priority → [(callbackId, callback)]
  private readonly _actionHooks = new Map<string, PriorityMap>();
  private readonly _filterHooks = new Map<string, PriorityMap>();

  // Hook name → set of callbackIds to remove after execution completes
  private readonly _removedActions = new Map<string, Set<string>>();
  private readonly _removedFilters = new Map<string, Set<string>>();

  // Hook name → current nesting depth (re-entrancy)
  private readonly _actionNesting = new Map<string, number>();
  private readonly _filterNesting = new Map<string, number>();

  // Hook name → total invocation count
  private readonly _actionCallCount = new Map<string, number>();
  private readonly _filterCallCount = new Map<string, number>();

  // Callback ID → metadata
  private readonly _callbackRegistry = new Map<string, CallbackType>();
  private readonly _callbackHooks = new Map<string, string>();
  private readonly _callbackTypes = new Map<string, CallbackCategory>();
  private readonly _callbackTimeouts = new Map<string, number | null>();
  private readonly _filterAcceptedArgs = new Map<string, number>();
  private readonly _detachedCallbacks = new Set<string>();

  // Tag tracking for bulk removal
  private readonly _callbackTags = new Map<string, string>();    // callbackId → tag
  private readonly _tagCallbacks = new Map<string, Set<string>>(); // tag → set of callbackIds

  // Global wildcard handlers — fired for every event
  private readonly _globalHooks = new Map<number, GlobalEntry[]>();
  private _globalNesting = 0;
  private readonly _removedGlobals = new Set<string>();

  // Schema registry for typed payload validation
  private readonly _hookSchemas = new Map<string, PayloadSchema>();
  private _validatePayloads: boolean;

  // Timeout configuration
  private readonly _actionTimeout: number | null;
  private readonly _filterTimeout: number | null;

  constructor(options: AsyncHooksOptions = {}) {
    this._actionTimeout =
      'actionTimeoutSeconds' in options
        ? options.actionTimeoutSeconds ?? null
        : DEFAULT_ACTION_TIMEOUT;
    this._filterTimeout =
      'filterTimeoutSeconds' in options
        ? options.filterTimeoutSeconds ?? null
        : DEFAULT_FILTER_TIMEOUT;
    this._validatePayloads = options.validatePayloads ?? false;
  }

  // ─ Action Methods ──────────────────────────────────────────────────────────

  /**
   * Register an action callback.
   *
   * @param hookName - Hook name, e.g. "task.created"
   * @param callback - Sync or async callable. Return value is ignored.
   * @param priority - Execution order (lower = higher priority). Default 10.
   * @param options  - { timeoutSeconds?, detach? }
   * @returns Unique callbackId for later removal.
   */
  addAction(
    hookName: string,
    callback: CallbackType,
    priority = 10,
    options: ActionOptions = {},
  ): string {
    this._validateHookName(hookName);
    this._validateCallback(callback);
    this._validatePriority(priority);

    const callbackId = randomUUID();
    if (this._callbackRegistry.has(callbackId)) {
      throw new DuplicateCallbackError(
        `Duplicate callback id collision for action '${hookName}': ${callbackId}`,
      );
    }

    this._ensurePriorityMap(this._actionHooks, hookName, priority).push([callbackId, callback]);
    this._callbackRegistry.set(callbackId, callback);
    this._callbackHooks.set(callbackId, hookName);
    this._callbackTypes.set(callbackId, 'action');

    if (options.timeoutSeconds != null) {
      this._callbackTimeouts.set(callbackId, options.timeoutSeconds);
    }
    if (options.detach) {
      this._detachedCallbacks.add(callbackId);
    }
    if (options.tag) {
      this._storeTag(callbackId, options.tag);
    }

    return callbackId;
  }

  /**
   * Ergonomic alias for addAction.
   * Use when you want to observe an event without transforming a value.
   */
  on(hookName: string, callback: CallbackType, priority = 10, options: ActionOptions = {}): string {
    return this.addAction(hookName, callback, priority, options);
  }

  /**
   * Fire an action hook.
   *
   * Attached callbacks are awaited in priority order (lower number first).
   * Detached callbacks (registered with detach:true) are fired as independent
   * Promises and not awaited — doAction returns immediately without waiting.
   *
   * Timeouts and errors are logged to console.warn / console.error; the chain
   * always continues to the next callback.
   *
   * Global handlers registered via subscribeAll() fire after all name-specific
   * callbacks, regardless of hook name.
   */
  async doAction(hookName: string, ...args: unknown[]): Promise<void> {
    const hasSpecific = this._actionHooks.has(hookName);
    const hasGlobal = this._globalHooks.size > 0;
    if (!hasSpecific && !hasGlobal) return;

    if (this._validatePayloads && this._hookSchemas.has(hookName)) {
      this._validatePayload(hookName, args.length > 0 ? args[0] : {});
    }

    this._actionCallCount.set(hookName, (this._actionCallCount.get(hookName) ?? 0) + 1);
    this._actionNesting.set(hookName, (this._actionNesting.get(hookName) ?? 0) + 1);

    _storage.getStore()?.recordAction(hookName);

    try {
      if (hasSpecific) {
        const priorityMap = this._actionHooks.get(hookName)!;
        for (const priority of [...priorityMap.keys()].sort((a, b) => a - b)) {
          for (const [callbackId, callback] of [...priorityMap.get(priority)!]) {
            if (this._removedActions.get(hookName)?.has(callbackId)) continue;

            if (this._detachedCallbacks.has(callbackId)) {
              void this._runDetachedListener(callbackId, hookName, callback, args);
            } else {
              const timeout = this._callbackTimeouts.has(callbackId)
                ? this._callbackTimeouts.get(callbackId)!
                : this._actionTimeout;
              try {
                await this._runActionListener(callbackId, hookName, callback, args, timeout);
              } catch (err) {
                if (isTimeoutError(err)) {
                  console.warn(
                    `do_action timeout hook=${hookName} callback=${callbackId} timeout_seconds=${timeout}`,
                  );
                } else {
                  console.error(
                    `do_action exception hook=${hookName} callback=${callbackId} error=${
                      err instanceof Error ? err.constructor.name : typeof err
                    }`,
                    err,
                  );
                }
              }
            }
          }
        }
      }

      if (hasGlobal) {
        await this._runGlobalHooks(hookName, args);
      }
    } finally {
      this._actionNesting.set(hookName, (this._actionNesting.get(hookName) ?? 1) - 1);
      if ((this._actionNesting.get(hookName) ?? 0) === 0) {
        this._cleanupRemovals('action', hookName);
      }
    }
  }

  /**
   * Fire an action hook and collect non-null/undefined return values.
   *
   * Same priority-ordered execution as doAction. Each callback receives a
   * shallow copy of the first arg if it's an object (mutations don't leak).
   * Errors are isolated per handler (logged, skipped). Detached callbacks
   * are fire-and-forget (results not collected). Global handlers fire after
   * but their results are NOT collected.
   */
  async doActionCollect(hookName: string, ...args: unknown[]): Promise<unknown[]> {
    const results: unknown[] = [];
    const hasSpecific = this._actionHooks.has(hookName);
    const hasGlobal = this._globalHooks.size > 0;
    if (!hasSpecific && !hasGlobal) return results;

    if (this._validatePayloads && this._hookSchemas.has(hookName)) {
      this._validatePayload(hookName, args.length > 0 ? args[0] : {});
    }

    this._actionCallCount.set(hookName, (this._actionCallCount.get(hookName) ?? 0) + 1);
    this._actionNesting.set(hookName, (this._actionNesting.get(hookName) ?? 0) + 1);

    _storage.getStore()?.recordAction(hookName);

    try {
      if (hasSpecific) {
        const priorityMap = this._actionHooks.get(hookName)!;
        for (const priority of [...priorityMap.keys()].sort((a, b) => a - b)) {
          for (const [callbackId, callback] of [...priorityMap.get(priority)!]) {
            if (this._removedActions.get(hookName)?.has(callbackId)) continue;

            if (this._detachedCallbacks.has(callbackId)) {
              void this._runDetachedListener(callbackId, hookName, callback, args);
            } else {
              const timeout = this._callbackTimeouts.has(callbackId)
                ? this._callbackTimeouts.get(callbackId)!
                : this._actionTimeout;

              // Build args with shallow copy of first arg if it's an object
              const callArgs = this._shallowCopyFirstArg(args);

              try {
                const result = await this._runActionListenerWithResult(
                  callbackId, hookName, callback, callArgs, timeout,
                );
                if (result != null) results.push(result);
              } catch (err) {
                if (isTimeoutError(err)) {
                  console.warn(
                    `do_action_collect timeout hook=${hookName} callback=${callbackId} timeout_seconds=${timeout}`,
                  );
                } else {
                  console.error(
                    `do_action_collect exception hook=${hookName} callback=${callbackId} error=${
                      err instanceof Error ? err.constructor.name : typeof err
                    }`,
                    err,
                  );
                }
              }
            }
          }
        }
      }

      if (hasGlobal) {
        await this._runGlobalHooks(hookName, args);
      }
    } finally {
      this._actionNesting.set(hookName, (this._actionNesting.get(hookName) ?? 1) - 1);
      if ((this._actionNesting.get(hookName) ?? 0) === 0) {
        this._cleanupRemovals('action', hookName);
      }
    }

    return results;
  }

  /**
   * Remove an action callback by ID.
   * If called during hook execution, removal is deferred until the hook completes.
   * Returns false if the callbackId is not a registered action on hookName.
   */
  removeAction(hookName: string, callbackId: string): boolean {
    if (!callbackId) return false;
    if (
      this._callbackTypes.get(callbackId) !== 'action' ||
      this._callbackHooks.get(callbackId) !== hookName
    ) {
      return false;
    }

    if ((this._actionNesting.get(hookName) ?? 0) > 0) {
      this._getOrCreate(this._removedActions, hookName).add(callbackId);
      return true;
    }

    return this._removeCallback('action', hookName, callbackId);
  }

  /**
   * Remove all actions from a hook, optionally limited to a specific priority.
   * Returns false if nothing was registered.
   */
  removeAllActions(hookName: string, priority?: number): boolean {
    if (!this._actionHooks.has(hookName)) return false;

    if ((this._actionNesting.get(hookName) ?? 0) > 0) {
      const ids = this._collectCallbackIds('action', hookName, priority);
      if (!ids.length) return false;
      const bucket = this._getOrCreate(this._removedActions, hookName);
      for (const id of ids) bucket.add(id);
      return true;
    }

    if (priority !== undefined) {
      const priorityMap = this._actionHooks.get(hookName)!;
      const callbacks = priorityMap.get(priority);
      if (!callbacks?.length) return false;
      for (const [cbId] of [...callbacks]) {
        this._removeCallback('action', hookName, cbId);
      }
      return true;
    }

    for (const [, callbacks] of [...this._actionHooks.get(hookName)!]) {
      for (const [cbId] of [...callbacks]) {
        this._removeCallback('action', hookName, cbId);
      }
    }
    this._actionHooks.delete(hookName);
    return true;
  }

  /**
   * Check whether an action exists.
   * With callbackId: returns true/false.
   * Without callbackId: returns count of registered callbacks (0 if none).
   */
  hasAction(hookName: string, callbackId?: string): boolean | number {
    if (callbackId !== undefined) {
      return (
        this._callbackTypes.get(callbackId) === 'action' &&
        this._callbackHooks.get(callbackId) === hookName &&
        this._callbackRegistry.has(callbackId)
      );
    }
    return this._countCallbacks(this._actionHooks, hookName);
  }

  /** Return true if callbackId was registered with detach:true. */
  isDetached(callbackId: string): boolean {
    return this._detachedCallbacks.has(callbackId);
  }

  /** Return true if an action hook is currently executing. */
  doingAction(hookName: string): boolean {
    return (this._actionNesting.get(hookName) ?? 0) > 0;
  }

  /** Return the number of times an action hook has been fired. */
  didAction(hookName: string): number {
    return this._actionCallCount.get(hookName) ?? 0;
  }

  // ─ Filter Methods ──────────────────────────────────────────────────────────

  /**
   * Register a filter callback.
   *
   * @param hookName    - Hook name, e.g. "task.payload"
   * @param callback    - Sync or async callable. Must return the (possibly modified) value.
   * @param priority    - Execution order (lower = higher priority). Default 10.
   * @param options     - { acceptedArgs?, timeoutSeconds? }
   * @returns Unique callbackId for later removal.
   */
  addFilter(
    hookName: string,
    callback: CallbackType,
    priority = 10,
    options: FilterOptions = {},
  ): string {
    this._validateHookName(hookName);
    this._validateCallback(callback);
    this._validatePriority(priority);

    const acceptedArgs = options.acceptedArgs ?? 1;
    if (!Number.isInteger(acceptedArgs) || acceptedArgs < 0) {
      throw new TypeError('acceptedArgs must be a non-negative integer');
    }

    const callbackId = randomUUID();
    this._ensurePriorityMap(this._filterHooks, hookName, priority).push([callbackId, callback]);
    this._callbackRegistry.set(callbackId, callback);
    this._callbackHooks.set(callbackId, hookName);
    this._callbackTypes.set(callbackId, 'filter');
    this._filterAcceptedArgs.set(callbackId, acceptedArgs);

    if (options.timeoutSeconds != null) {
      this._callbackTimeouts.set(callbackId, options.timeoutSeconds);
    }
    if (options.tag) {
      this._storeTag(callbackId, options.tag);
    }

    return callbackId;
  }

  /**
   * Ergonomic alias for addFilter.
   * Use when you want to transform a value passing through a hook.
   */
  intercept(
    hookName: string,
    callback: CallbackType,
    priority = 10,
    options: FilterOptions = {},
  ): string {
    return this.addFilter(hookName, callback, priority, options);
  }

  /**
   * Apply a filter chain to a value and return the final transformed value.
   *
   * Each callback receives (currentValue, ...extraArgs) and its return value
   * becomes the next callback's input. If a callback throws or times out, the
   * current value passes through unchanged and execution continues.
   *
   * Global handlers fire after the chain with the post-chain value. Their
   * return values are ignored — they are observers, not transformers.
   */
  async applyFilters(hookName: string, value: unknown, ...args: unknown[]): Promise<unknown> {
    const hasSpecific = this._filterHooks.has(hookName);
    const hasGlobal = this._globalHooks.size > 0;
    if (!hasSpecific && !hasGlobal) return value;

    if (this._validatePayloads && this._hookSchemas.has(hookName)) {
      this._validatePayload(hookName, value);
    }

    this._filterCallCount.set(hookName, (this._filterCallCount.get(hookName) ?? 0) + 1);
    this._filterNesting.set(hookName, (this._filterNesting.get(hookName) ?? 0) + 1);

    _storage.getStore()?.recordFilter(hookName);

    try {
      let currentValue = value;
      let vetoed = false;

      if (hasSpecific) {
        const priorityMap = this._filterHooks.get(hookName)!;
        for (const priority of [...priorityMap.keys()].sort((a, b) => a - b)) {
          if (vetoed) break;
          for (const [callbackId, callback] of [...priorityMap.get(priority)!]) {
            if (vetoed) break;
            if (this._removedFilters.get(hookName)?.has(callbackId)) continue;

            const timeout = this._callbackTimeouts.has(callbackId)
              ? this._callbackTimeouts.get(callbackId)!
              : this._filterTimeout;
            const acceptedArgs = this._filterAcceptedArgs.get(callbackId) ?? 1;
            const filteredArgs = this._filterArgsForCallback(args, acceptedArgs);

            try {
              currentValue = await this._runFilterListener(
                callbackId,
                hookName,
                callback,
                currentValue,
                filteredArgs,
                timeout,
              );
            } catch (err) {
              if (err instanceof VetoError) {
                // Short-circuit: mark vetoed, stop chain
                if (currentValue != null && typeof currentValue === 'object') {
                  (currentValue as Record<string, unknown>)._vetoed = true;
                  (currentValue as Record<string, unknown>)._veto_reason = err.reason;
                }
                vetoed = true;
              } else if (isTimeoutError(err)) {
                console.warn(
                  `apply_filters timeout hook=${hookName} callback=${callbackId} timeout_seconds=${timeout}`,
                );
              } else {
                console.error(
                  `apply_filters exception hook=${hookName} callback=${callbackId} error=${
                    err instanceof Error ? err.constructor.name : typeof err
                  }`,
                  err,
                );
              }
            }
          }
        }
      }

      if (hasGlobal) {
        await this._runGlobalHooks(hookName, [currentValue, ...args]);
      }

      return currentValue;
    } finally {
      this._filterNesting.set(hookName, (this._filterNesting.get(hookName) ?? 1) - 1);
      if ((this._filterNesting.get(hookName) ?? 0) === 0) {
        this._cleanupRemovals('filter', hookName);
      }
    }
  }

  /**
   * Remove a filter callback by ID.
   * If called during hook execution, removal is deferred until the hook completes.
   * Returns false if callbackId is not a registered filter on hookName.
   */
  removeFilter(hookName: string, callbackId: string): boolean {
    if (!callbackId) return false;
    if (
      this._callbackTypes.get(callbackId) !== 'filter' ||
      this._callbackHooks.get(callbackId) !== hookName
    ) {
      return false;
    }

    if ((this._filterNesting.get(hookName) ?? 0) > 0) {
      this._getOrCreate(this._removedFilters, hookName).add(callbackId);
      return true;
    }

    return this._removeCallback('filter', hookName, callbackId);
  }

  /**
   * Remove all filters from a hook, optionally limited to a specific priority.
   * Returns false if nothing was registered.
   */
  removeAllFilters(hookName: string, priority?: number): boolean {
    if (!this._filterHooks.has(hookName)) return false;

    if ((this._filterNesting.get(hookName) ?? 0) > 0) {
      const ids = this._collectCallbackIds('filter', hookName, priority);
      if (!ids.length) return false;
      const bucket = this._getOrCreate(this._removedFilters, hookName);
      for (const id of ids) bucket.add(id);
      return true;
    }

    if (priority !== undefined) {
      const priorityMap = this._filterHooks.get(hookName)!;
      const callbacks = priorityMap.get(priority);
      if (!callbacks?.length) return false;
      for (const [cbId] of [...callbacks]) {
        this._removeCallback('filter', hookName, cbId);
      }
      return true;
    }

    for (const [, callbacks] of [...this._filterHooks.get(hookName)!]) {
      for (const [cbId] of [...callbacks]) {
        this._removeCallback('filter', hookName, cbId);
      }
    }
    this._filterHooks.delete(hookName);
    return true;
  }

  /**
   * Check whether a filter exists.
   * With callbackId: returns true/false.
   * Without callbackId: returns count of registered callbacks (0 if none).
   */
  hasFilter(hookName: string, callbackId?: string): boolean | number {
    if (callbackId !== undefined) {
      return (
        this._callbackTypes.get(callbackId) === 'filter' &&
        this._callbackHooks.get(callbackId) === hookName &&
        this._callbackRegistry.has(callbackId)
      );
    }
    return this._countCallbacks(this._filterHooks, hookName);
  }

  /** Return true if a filter hook is currently executing. */
  doingFilter(hookName: string): boolean {
    return (this._filterNesting.get(hookName) ?? 0) > 0;
  }

  /** Return the number of times a filter hook has been applied. */
  didFilter(hookName: string): number {
    return this._filterCallCount.get(hookName) ?? 0;
  }

  // ─ Universal Removal ───────────────────────────────────────────────────────

  /**
   * Remove a callback by ID regardless of type. Counterpart to on().
   * Routes to removeAction or removeFilter based on the registered type.
   * Returns false for unknown or global callbackIds.
   */
  off(hookName: string, callbackId: string): boolean {
    const kind = this._callbackTypes.get(callbackId);
    if (kind === 'action') return this.removeAction(hookName, callbackId);
    if (kind === 'filter') return this.removeFilter(hookName, callbackId);
    return false;
  }

  // ─ Global Wildcard Hooks ───────────────────────────────────────────────────

  /**
   * Register a handler that fires for every doAction() and applyFilters() call.
   *
   * The handler receives the event name as the first argument, followed by the
   * original emission args:
   *
   *   async function handler(eventName: string, ...args: unknown[]) { ... }
   *
   * For filters, args[0] is the post-chain value. Return values are ignored —
   * global handlers are observers, not transformers.
   *
   * @param callback  - Sync or async callable.
   * @param priority  - Execution order among global handlers. Default 90.
   * @param namespace - If given, only fires for hooks matching this namespace prefix.
   *                    "task" matches "task", "task.created", "task.lifecycle.start"
   *                    but NOT "taskrunner.created".
   * @returns Unique callbackId for use with unsubscribeAll().
   */
  subscribeAll(callback: CallbackType, priority = 90, namespace?: string, tag?: string): string {
    if (typeof callback !== 'function') throw new TypeError('callback must be callable');
    if (!Number.isInteger(priority)) throw new TypeError('priority must be an integer');
    if (namespace !== undefined && (!namespace || typeof namespace !== 'string')) {
      throw new TypeError('namespace must be a non-empty string');
    }

    const callbackId = randomUUID();
    if (!this._globalHooks.has(priority)) this._globalHooks.set(priority, []);
    this._globalHooks.get(priority)!.push([callbackId, callback, namespace ?? null]);
    this._callbackRegistry.set(callbackId, callback);
    this._callbackTypes.set(callbackId, 'global');

    if (tag) {
      this._storeTag(callbackId, tag);
    }

    return callbackId;
  }

  /**
   * Remove a global wildcard handler registered via subscribeAll().
   * If called during global handler execution, removal is deferred.
   * Returns false if callbackId is not a global handler.
   */
  unsubscribeAll(callbackId: string): boolean {
    if (this._callbackTypes.get(callbackId) !== 'global') return false;

    if (this._globalNesting > 0) {
      this._removedGlobals.add(callbackId);
      return true;
    }

    return this._removeGlobalCallback(callbackId);
  }

  /**
   * Remove all callbacks (actions, filters, globals) registered with the given tag.
   * Returns the number of callbacks removed.
   */
  removeByTag(tag: string): number {
    const callbackIds = this._tagCallbacks.get(tag);
    if (!callbackIds?.size) return 0;

    let count = 0;
    for (const callbackId of [...callbackIds]) {
      const kind = this._callbackTypes.get(callbackId);
      if (!kind) continue;

      let removed = false;
      if (kind === 'global') {
        if (this._globalNesting > 0) {
          this._removedGlobals.add(callbackId);
          removed = true;
        } else {
          removed = this._removeGlobalCallback(callbackId);
        }
      } else {
        const hookName = this._callbackHooks.get(callbackId);
        if (!hookName) continue;

        const nestingMap = kind === 'action' ? this._actionNesting : this._filterNesting;
        if ((nestingMap.get(hookName) ?? 0) > 0) {
          const removedBucket = kind === 'action' ? this._removedActions : this._removedFilters;
          this._getOrCreate(removedBucket, hookName).add(callbackId);
          removed = true;
        } else {
          removed = this._removeCallback(kind, hookName, callbackId);
        }
      }

      if (removed) count++;
    }

    // Clean up tag maps for non-deferred removals
    this._cleanupTagMaps(tag);

    return count;
  }

  /** Return true if callbackId is a registered global handler. */
  hasGlobal(callbackId: string): boolean {
    return (
      this._callbackTypes.get(callbackId) === 'global' &&
      this._callbackRegistry.has(callbackId)
    );
  }

  // ─ Introspection API ───────────────────────────────────────────────────────

  /**
   * Return the set of all hook names with at least one registered callback.
   *
   * @param namespace - If given, return only hooks matching this namespace prefix.
   */
  registeredEvents(namespace?: string): Set<string> {
    const events = new Set([...this._actionHooks.keys(), ...this._filterHooks.keys()]);
    if (namespace !== undefined) {
      for (const h of events) {
        if (!this._hookMatchesNamespace(h, namespace)) events.delete(h);
      }
    }
    return events;
  }

  /**
   * Return ordered descriptors for all callbacks registered on hookName.
   * Results are sorted by priority (ascending), then registration order.
   * Covers both action and filter registries.
   * Excludes callbacks pending deferred removal.
   * Returns [] if no callbacks are registered.
   */
  describe(hookName: string): HandlerInfo[] {
    const result: HandlerInfo[] = [];
    const pendingActionRemoval = this._removedActions.get(hookName) ?? new Set<string>();
    const pendingFilterRemoval = this._removedFilters.get(hookName) ?? new Set<string>();

    const actionMap = this._actionHooks.get(hookName);
    if (actionMap) {
      for (const priority of [...actionMap.keys()].sort((a, b) => a - b)) {
        for (const [callbackId, callback] of actionMap.get(priority)!) {
          if (pendingActionRemoval.has(callbackId)) continue;
          result.push({
            callbackId,
            hookName,
            hookType: 'action',
            priority,
            handlerName: resolveHandlerName(callback),
            module: '<module>',
            detached: this._detachedCallbacks.has(callbackId),
            acceptedArgs: 1,
          });
        }
      }
    }

    const filterMap = this._filterHooks.get(hookName);
    if (filterMap) {
      for (const priority of [...filterMap.keys()].sort((a, b) => a - b)) {
        for (const [callbackId, callback] of filterMap.get(priority)!) {
          if (pendingFilterRemoval.has(callbackId)) continue;
          result.push({
            callbackId,
            hookName,
            hookType: 'filter',
            priority,
            handlerName: resolveHandlerName(callback),
            module: '<module>',
            detached: false,
            acceptedArgs: this._filterAcceptedArgs.get(callbackId) ?? 1,
          });
        }
      }
    }

    return result;
  }

  /**
   * Return descriptors for all callbacks across all hooks, sorted by hook name.
   *
   * @param namespace - If given, limit to hooks matching this namespace prefix.
   */
  describeAll(namespace?: string): HandlerInfo[] {
    const result: HandlerInfo[] = [];
    for (const hookName of [...this.registeredEvents(namespace)].sort()) {
      result.push(...this.describe(hookName));
    }
    return result;
  }

  /**
   * Remove all action and filter callbacks on hooks matching a namespace prefix.
   *
   * "task" matches "task", "task.created", "task.lifecycle.start" but NOT "taskrunner.*".
   *
   * @returns Number of distinct hook names cleared.
   */
  removeNamespace(namespace: string): number {
    if (!namespace || typeof namespace !== 'string') {
      throw new TypeError('namespace must be a non-empty string');
    }

    const matching = [...this.registeredEvents()].filter((h) =>
      this._hookMatchesNamespace(h, namespace),
    );
    for (const hookName of matching) {
      this.removeAllActions(hookName);
      this.removeAllFilters(hookName);
    }
    return matching.length;
  }

  // ─ Typed Payload Validation ────────────────────────────────────────────────

  /** Whether payload schema validation is active. Toggle without recreating the instance. */
  get validatePayloads(): boolean {
    return this._validatePayloads;
  }
  set validatePayloads(value: boolean) {
    this._validatePayloads = value;
  }

  /**
   * Register a schema for typed payload validation on hookName.
   *
   * When validatePayloads=true, doAction() validates args[0] and applyFilters()
   * validates the filter value before dispatching to any callbacks.
   *
   * Compatible with any object that has a validate(value) method
   * (Zod, Valibot, custom validators, etc.).
   */
  registerSchema(hookName: string, schema: PayloadSchema): void {
    this._validateHookName(hookName);
    this._hookSchemas.set(hookName, schema);
  }

  /** Return the registered schema for hookName, or undefined. */
  schemaFor(hookName: string): PayloadSchema | undefined {
    return this._hookSchemas.get(hookName);
  }

  // ─ Scope ───────────────────────────────────────────────────────────────────

  /**
   * Create an execution scope. Use .run() to enter it.
   *
   *   await hooks.scope('myBatch', { requestId: 'r-1' }).run(async (scope) => {
   *     await hooks.doAction('task.created', payload);
   *   });
   */
  scope(name = '', metadata: Record<string, unknown> = {}): HookScope {
    return new HookScope(this, name, metadata);
  }

  /** The active HookScope for the current async context, or undefined if none. */
  get currentScope(): HookScope | undefined {
    return _storage.getStore();
  }

  // ─ Internal helpers (accessible for tests) ─────────────────────────────────

  _hookMatchesNamespace(hookName: string, namespace: string): boolean {
    return hookName === namespace || hookName.startsWith(`${namespace}.`);
  }

  // ─ Private methods ─────────────────────────────────────────────────────────

  private async _runGlobalHooks(hookName: string, args: unknown[]): Promise<void> {
    this._globalNesting++;
    try {
      for (const priority of [...this._globalHooks.keys()].sort((a, b) => a - b)) {
        for (const [callbackId, callback, ns] of [...this._globalHooks.get(priority)!]) {
          if (this._removedGlobals.has(callbackId)) continue;
          if (ns !== null && !this._hookMatchesNamespace(hookName, ns)) continue;

          try {
            await this._runActionListener(
              callbackId,
              hookName,
              callback,
              [hookName, ...args],
              this._actionTimeout,
            );
          } catch (err) {
            if (isTimeoutError(err)) {
              console.warn(`global_hook timeout hook=${hookName} callback=${callbackId}`);
            } else {
              console.error(
                `global_hook exception hook=${hookName} callback=${callbackId}`,
                err,
              );
            }
          }
        }
      }
    } finally {
      this._globalNesting--;
      if (this._globalNesting === 0) {
        this._cleanupGlobalRemovals();
      }
    }
  }

  private _removeGlobalCallback(callbackId: string): boolean {
    let removed = false;
    for (const [priority, callbacks] of [...this._globalHooks]) {
      const filtered = callbacks.filter(([cid]) => cid !== callbackId);
      if (filtered.length !== callbacks.length) {
        removed = true;
        if (filtered.length === 0) {
          this._globalHooks.delete(priority);
        } else {
          this._globalHooks.set(priority, filtered);
        }
      }
    }
    if (removed) {
      this._callbackRegistry.delete(callbackId);
      this._callbackTypes.delete(callbackId);
      this._removedGlobals.delete(callbackId);
      this._removeTagForCallback(callbackId);
    }
    return removed;
  }

  private _cleanupGlobalRemovals(): void {
    for (const callbackId of [...this._removedGlobals]) {
      this._removeGlobalCallback(callbackId);
    }
    this._removedGlobals.clear();
  }

  private _storeTag(callbackId: string, tag: string): void {
    this._callbackTags.set(callbackId, tag);
    if (!this._tagCallbacks.has(tag)) this._tagCallbacks.set(tag, new Set());
    this._tagCallbacks.get(tag)!.add(callbackId);
  }

  private _removeTagForCallback(callbackId: string): void {
    const tag = this._callbackTags.get(callbackId);
    if (!tag) return;
    this._callbackTags.delete(callbackId);
    const ids = this._tagCallbacks.get(tag);
    if (ids) {
      ids.delete(callbackId);
      if (ids.size === 0) this._tagCallbacks.delete(tag);
    }
  }

  private _cleanupTagMaps(tag: string): void {
    const ids = this._tagCallbacks.get(tag);
    if (!ids) return;
    for (const id of [...ids]) {
      if (!this._callbackRegistry.has(id)) {
        ids.delete(id);
        this._callbackTags.delete(id);
      }
    }
    if (ids.size === 0) this._tagCallbacks.delete(tag);
  }

  private _shallowCopyFirstArg(args: unknown[]): unknown[] {
    if (args.length === 0) return args;
    const first = args[0];
    if (first != null && typeof first === 'object' && !Array.isArray(first)) {
      return [{ ...first }, ...args.slice(1)];
    }
    return [...args];
  }

  private async _runActionListenerWithResult(
    _callbackId: string,
    _hookName: string,
    callback: CallbackType,
    args: unknown[],
    timeout: number | null,
  ): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      const result = callback(...args);
      if (isThenable(result)) return await result;
      return result;
    };

    if (timeout != null) {
      return await runWithTimeout(run, timeout);
    }
    return await run();
  }

  private _validatePayload(hookName: string, payload: unknown): void {
    const schema = this._hookSchemas.get(hookName);
    if (!schema) return;
    try {
      schema.validate(payload);
    } catch (err) {
      throw new HookPayloadError(hookName, schema, [
        err instanceof Error ? err.message : String(err),
      ]);
    }
  }

  private async _runDetachedListener(
    callbackId: string,
    hookName: string,
    callback: CallbackType,
    args: unknown[],
  ): Promise<void> {
    try {
      const result = callback(...args);
      if (isThenable(result)) await result;
    } catch (err) {
      console.error(
        `do_action detached exception hook=${hookName} callback=${callbackId}`,
        err,
      );
    }
  }

  private async _runActionListener(
    _callbackId: string,
    _hookName: string,
    callback: CallbackType,
    args: unknown[],
    timeout: number | null,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const result = callback(...args);
      if (isThenable(result)) await result;
    };

    if (timeout != null) {
      await runWithTimeout(run, timeout);
    } else {
      await run();
    }
  }

  private async _runFilterListener(
    _callbackId: string,
    _hookName: string,
    callback: CallbackType,
    currentValue: unknown,
    args: unknown[],
    timeout: number | null,
  ): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      const result = callback(currentValue, ...args);
      if (isThenable(result)) return await result;
      return result;
    };

    if (timeout != null) {
      return await runWithTimeout(run, timeout);
    }
    return await run();
  }

  private _filterArgsForCallback(args: unknown[], acceptedArgs: number): unknown[] {
    const extraAllowed = Math.max(acceptedArgs - 1, 0);
    return args.slice(0, extraAllowed);
  }

  private _collectCallbackIds(
    kind: 'action' | 'filter',
    hookName: string,
    priority?: number,
  ): string[] {
    const hooks = kind === 'action' ? this._actionHooks : this._filterHooks;
    const priorityMap = hooks.get(hookName);
    if (!priorityMap) return [];

    const ids: string[] = [];
    if (priority !== undefined) {
      for (const [cbId] of priorityMap.get(priority) ?? []) ids.push(cbId);
    } else {
      for (const callbacks of priorityMap.values()) {
        for (const [cbId] of callbacks) ids.push(cbId);
      }
    }
    return ids;
  }

  private _removeCallback(
    kind: 'action' | 'filter',
    hookName: string,
    callbackId: string,
  ): boolean {
    const hooks = kind === 'action' ? this._actionHooks : this._filterHooks;
    const priorityMap = hooks.get(hookName);
    if (!priorityMap) return false;

    let removed = false;
    for (const [priority, callbacks] of [...priorityMap]) {
      const filtered = callbacks.filter(([cid]) => cid !== callbackId);
      if (filtered.length !== callbacks.length) {
        removed = true;
        if (filtered.length === 0) {
          priorityMap.delete(priority);
        } else {
          priorityMap.set(priority, filtered);
        }
      }
    }

    if (priorityMap.size === 0) hooks.delete(hookName);

    if (removed) {
      this._callbackRegistry.delete(callbackId);
      this._callbackHooks.delete(callbackId);
      this._callbackTypes.delete(callbackId);
      this._callbackTimeouts.delete(callbackId);
      this._filterAcceptedArgs.delete(callbackId);
      this._detachedCallbacks.delete(callbackId);
      this._removedActions.get(hookName)?.delete(callbackId);
      this._removedFilters.get(hookName)?.delete(callbackId);
      this._removeTagForCallback(callbackId);
    }

    return removed;
  }

  private _cleanupRemovals(kind: 'action' | 'filter', hookName: string): void {
    const removedBucket = kind === 'action' ? this._removedActions : this._removedFilters;
    const hooks = kind === 'action' ? this._actionHooks : this._filterHooks;
    const removedIds = removedBucket.get(hookName);

    if (!removedIds?.size) {
      removedBucket.delete(hookName);
      return;
    }

    const priorityMap = hooks.get(hookName);
    if (priorityMap) {
      for (const [priority, callbacks] of [...priorityMap]) {
        const filtered = callbacks.filter(([cid]) => !removedIds.has(cid));
        if (filtered.length === 0) {
          priorityMap.delete(priority);
        } else {
          priorityMap.set(priority, filtered);
        }
      }
      if (priorityMap.size === 0) hooks.delete(hookName);
    }

    for (const callbackId of removedIds) {
      this._callbackRegistry.delete(callbackId);
      this._callbackHooks.delete(callbackId);
      this._callbackTypes.delete(callbackId);
      this._callbackTimeouts.delete(callbackId);
      this._filterAcceptedArgs.delete(callbackId);
      this._detachedCallbacks.delete(callbackId);
      this._removeTagForCallback(callbackId);
    }

    removedBucket.delete(hookName);
  }

  private _ensurePriorityMap(
    hooks: Map<string, PriorityMap>,
    hookName: string,
    priority: number,
  ): Array<[string, CallbackType]> {
    if (!hooks.has(hookName)) hooks.set(hookName, new Map());
    const pm = hooks.get(hookName)!;
    if (!pm.has(priority)) pm.set(priority, []);
    return pm.get(priority)!;
  }

  private _getOrCreate(map: Map<string, Set<string>>, key: string): Set<string> {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key)!;
  }

  private _countCallbacks(hooks: Map<string, PriorityMap>, hookName: string): number {
    const pm = hooks.get(hookName);
    if (!pm) return 0;
    let count = 0;
    for (const cbs of pm.values()) count += cbs.length;
    return count;
  }

  private _validateHookName(hookName: string): void {
    if (!hookName || typeof hookName !== 'string') {
      throw new TypeError('hookName must be a non-empty string');
    }
  }

  private _validateCallback(callback: CallbackType): void {
    if (typeof callback !== 'function') throw new TypeError('callback must be callable');
  }

  private _validatePriority(priority: number): void {
    if (!Number.isInteger(priority)) throw new TypeError('priority must be an integer');
  }
}
