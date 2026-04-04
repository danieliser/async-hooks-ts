import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AsyncHooks, VetoError, HookError } from '../src/index';

function makeHooks() {
  return new AsyncHooks({ actionTimeoutSeconds: 0.05, filterTimeoutSeconds: null });
}

describe('VetoError filter veto', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = makeHooks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('VetoError extends HookError', () => {
    const err = new VetoError('test');
    expect(err).toBeInstanceOf(HookError);
    expect(err).toBeInstanceOf(Error);
  });

  it('VetoError stores reason', () => {
    const err = new VetoError('not allowed');
    expect(err.reason).toBe('not allowed');
    expect(err.message).toBe('Filter vetoed: not allowed');
  });

  it('filter chain stops on VetoError', async () => {
    const calls: string[] = [];
    hooks.addFilter('veto.stop', (val: unknown) => {
      calls.push('first');
      return val;
    }, 5);
    hooks.addFilter('veto.stop', () => {
      calls.push('vetoer');
      throw new VetoError('denied');
    }, 10);
    hooks.addFilter('veto.stop', (val: unknown) => {
      calls.push('third');
      return val;
    }, 15);

    await hooks.applyFilters('veto.stop', { data: 1 });
    expect(calls).toEqual(['first', 'vetoer']);
  });

  it('vetoed value gets _vetoed and _veto_reason markers (when value is object)', async () => {
    hooks.addFilter('veto.markers', () => {
      throw new VetoError('bad request');
    }, 10);

    const result = await hooks.applyFilters('veto.markers', { data: 1 });
    expect(result).toEqual({
      data: 1,
      _vetoed: true,
      _veto_reason: 'bad request',
    });
  });

  it('global handlers still fire after veto', async () => {
    const globalCalled: unknown[] = [];
    hooks.addFilter('veto.globals', () => {
      throw new VetoError('nope');
    }, 10);
    hooks.subscribeAll((hookName: string, val: unknown) => {
      globalCalled.push({ hookName, val });
    });

    const result = await hooks.applyFilters('veto.globals', { x: 1 });
    expect((result as Record<string, unknown>)._vetoed).toBe(true);
    expect(globalCalled.length).toBe(1);
    expect((globalCalled[0] as Record<string, unknown>).hookName).toBe('veto.globals');
  });

  it('regular errors still swallowed (existing behavior preserved)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    hooks.addFilter('veto.regular', (val: unknown) => {
      calls.push('first');
      throw new Error('normal error');
    }, 5);
    hooks.addFilter('veto.regular', (val: unknown) => {
      calls.push('second');
      return val;
    }, 10);

    await hooks.applyFilters('veto.regular', 'value');
    // Regular errors are swallowed and chain continues
    expect(calls).toEqual(['first', 'second']);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('subsequent filters after veto are skipped', async () => {
    const calls: string[] = [];
    hooks.addFilter('veto.skip', (val: unknown) => {
      calls.push('a');
      return val;
    }, 1);
    hooks.addFilter('veto.skip', () => {
      calls.push('b-veto');
      throw new VetoError('stop');
    }, 2);
    hooks.addFilter('veto.skip', (val: unknown) => {
      calls.push('c');
      return val;
    }, 3);
    hooks.addFilter('veto.skip', (val: unknown) => {
      calls.push('d');
      return val;
    }, 4);

    await hooks.applyFilters('veto.skip', {});
    expect(calls).toEqual(['a', 'b-veto']);
  });

  it('works when value is not an object (veto stops chain, returns value as-is)', async () => {
    hooks.addFilter('veto.primitive', () => {
      throw new VetoError('blocked');
    }, 10);
    hooks.addFilter('veto.primitive', (val: unknown) => {
      return 'should not reach';
    }, 20);

    const result = await hooks.applyFilters('veto.primitive', 42);
    // Primitive values can't have markers set, returned as-is
    expect(result).toBe(42);
  });
});
