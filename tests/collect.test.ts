import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AsyncHooks } from '../src/index';

function makeHooks() {
  return new AsyncHooks({ actionTimeoutSeconds: 0.05, filterTimeoutSeconds: null });
}

describe('doActionCollect', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = makeHooks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array when no handlers', async () => {
    const results = await hooks.doActionCollect('collect.empty');
    expect(results).toEqual([]);
  });

  it('collects non-null results from handlers', async () => {
    hooks.addAction('collect.results', () => 'alpha', 10);
    hooks.addAction('collect.results', () => 42, 20);
    const results = await hooks.doActionCollect('collect.results');
    expect(results).toEqual(['alpha', 42]);
  });

  it('filters out null/undefined results', async () => {
    hooks.addAction('collect.nulls', () => 'keep', 5);
    hooks.addAction('collect.nulls', () => null, 10);
    hooks.addAction('collect.nulls', () => undefined, 15);
    hooks.addAction('collect.nulls', () => 'also keep', 20);
    const results = await hooks.doActionCollect('collect.nulls');
    expect(results).toEqual(['keep', 'also keep']);
  });

  it('provides shallow copy of object arg to each handler', async () => {
    const original = { count: 0, nested: { value: 'shared' } };
    hooks.addAction('collect.copy', (arg: Record<string, unknown>) => {
      (arg as { count: number }).count += 1;
      return (arg as { count: number }).count;
    }, 10);
    hooks.addAction('collect.copy', (arg: Record<string, unknown>) => {
      (arg as { count: number }).count += 10;
      return (arg as { count: number }).count;
    }, 20);

    const results = await hooks.doActionCollect('collect.copy', original);
    // Each handler gets a shallow copy starting at count=0
    expect(results).toEqual([1, 10]);
    // Original unchanged
    expect(original.count).toBe(0);
  });

  it('isolates errors (failing handler excluded from results)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.addAction('collect.errors', () => 'before', 5);
    hooks.addAction('collect.errors', () => { throw new Error('boom'); }, 10);
    hooks.addAction('collect.errors', () => 'after', 15);
    const results = await hooks.doActionCollect('collect.errors');
    expect(results).toEqual(['before', 'after']);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('respects priority ordering', async () => {
    hooks.addAction('collect.priority', () => 'low', 20);
    hooks.addAction('collect.priority', () => 'high', 5);
    hooks.addAction('collect.priority', () => 'medium', 10);
    const results = await hooks.doActionCollect('collect.priority');
    expect(results).toEqual(['high', 'medium', 'low']);
  });

  it('detached callbacks not collected', async () => {
    hooks.addAction('collect.detached', () => 'normal', 10);
    hooks.addAction('collect.detached', () => 'detached-result', 20, { detach: true });
    const results = await hooks.doActionCollect('collect.detached');
    expect(results).toEqual(['normal']);
  });

  it('global handlers fire but results not collected', async () => {
    const globalCalled: string[] = [];
    hooks.addAction('collect.globals', () => 'specific', 10);
    hooks.subscribeAll((hookName: string) => {
      globalCalled.push(hookName);
      return 'global-result';
    });
    const results = await hooks.doActionCollect('collect.globals');
    expect(results).toEqual(['specific']);
    expect(globalCalled).toContain('collect.globals');
  });

  it('works with async handlers', async () => {
    hooks.addAction('collect.async', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'async-result';
    }, 10);
    hooks.addAction('collect.async', () => 'sync-result', 20);
    const results = await hooks.doActionCollect('collect.async');
    expect(results).toEqual(['async-result', 'sync-result']);
  });
});
