/**
 * Type definitions and error classes for async-hooks-ts.
 */

export class HookError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = this.constructor.name;
    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HookNotFoundError extends HookError {}
export class DuplicateCallbackError extends HookError {}
export class HookTimeoutError extends HookError {}

export class HookPayloadError extends HookError {
  constructor(
    public readonly hookName: string,
    public readonly schema: unknown,
    public readonly errors: unknown[],
  ) {
    super(
      `Payload validation failed for hook '${hookName}': ${JSON.stringify(errors)}`,
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type HookType = 'action' | 'filter';
export type CallbackCategory = 'action' | 'filter' | 'global';

export interface HandlerInfo {
  callbackId: string;
  hookName: string;
  hookType: HookType;
  priority: number;
  /** Callback function name, or '<anonymous>' for arrow functions/lambdas. */
  handlerName: string;
  /** Always '<module>' in TypeScript — no equivalent to Python's __module__. */
  module: string;
  /** True if registered with detach:true (actions only). */
  detached: boolean;
  /** Always 1 for actions; respects acceptedArgs for filters. */
  acceptedArgs: number;
}

/** Options for addAction / on */
export interface ActionOptions {
  /** Per-callback timeout in seconds (overrides instance default). null = no timeout. */
  timeoutSeconds?: number | null;
  /**
   * If true, callback is fired as an independent Promise and not awaited.
   * doAction returns without waiting. Detached callbacks run concurrently.
   */
  detach?: boolean;
}

/** Options for addFilter / intercept */
export interface FilterOptions {
  /**
   * How many positional args the callback accepts (including the filtered value).
   * Extra args passed to applyFilters are trimmed. Default 1.
   */
  acceptedArgs?: number;
  /** Per-callback timeout in seconds (overrides instance default). null = no timeout. */
  timeoutSeconds?: number | null;
}

/** Options for AsyncHooks constructor */
export interface AsyncHooksOptions {
  /** Default timeout per action listener in seconds. Default 30. null = no timeout. */
  actionTimeoutSeconds?: number | null;
  /** Default timeout per filter listener in seconds. Default null (no timeout). */
  filterTimeoutSeconds?: number | null;
  /** If true, validate payloads against registered schemas at emit time. Default false. */
  validatePayloads?: boolean;
}

/** Any callable — sync or async. Both are supported. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallbackType = (...args: any[]) => any;

/** Schema for typed payload validation. Compatible with Zod, Valibot, or a custom validator. */
export interface PayloadSchema {
  /** Throw if value is invalid. Return value is ignored. */
  validate(value: unknown): unknown;
}
