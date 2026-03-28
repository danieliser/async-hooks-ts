import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AsyncHooks } from '../src/index';

function makeHooks() {
  return new AsyncHooks({ actionTimeoutSeconds: 0.05, filterTimeoutSeconds: null });
}

describe('filters', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = makeHooks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('addFilter + applyFilters chains value through callbacks', async () => {
    const marker: string[] = [];
    hooks.addFilter('filters.chain', (value: string) => `${value}+1`);
    hooks.addFilter('filters.chain', (value: string) => {
      marker.push('second');
      return `${value}:second`;
    });
    hooks.addFilter('filters.chain', (value: string) => `${value}*3`);

    const result = await hooks.applyFilters('filters.chain', 'v');
    expect(result).toBe('v+1:second*3');
    expect(marker).toEqual(['second']);
  });

  it('filter priority order (lower = first)', async () => {
    const marker: string[] = [];

    hooks.addFilter('filters.priority', (v: string) => { marker.push('second'); return `${v}-second`; }, 5);
    hooks.addFilter('filters.priority', (v: string) => { marker.push('first'); return `${v}-first`; }, 10);
    hooks.addFilter('filters.priority', (v: string) => { marker.push('third'); return `${v}-third`; }, 20);

    const result = await hooks.applyFilters('filters.priority', 'start');
    expect(marker).toEqual(['second', 'first', 'third']);
    expect(result).toBe('start-second-first-third');
  });

  it.each([1, 2, 3])('acceptedArgs=%i controls argument passing', async (acceptedArgs) => {
    const events: string[] = [];

    const expectedEvents: Record<number, string[]> = {
      1: ['one:0', 'two:undefined', 'three:undefined:undefined'],
      2: ['one:1', 'two:10', 'three:10:undefined'],
      3: ['one:2', 'two:10', 'three:10:20'],
    };

    const oneArg = (value: string, ...rest: unknown[]) => {
      events.push(`one:${rest.length}`);
      return value;
    };
    const twoArgs = (value: string, argA?: number) => {
      events.push(`two:${argA}`);
      if (argA == null) return value;
      return `${value}-${argA}`;
    };
    const threeArgs = (value: string, argA?: number, argB?: number) => {
      events.push(`three:${argA}:${argB}`);
      if (argA == null) return value;
      if (argB == null) return `${value}-${argA}`;
      return `${value}-${argA}-${argB}`;
    };

    hooks.addFilter('filters.args', oneArg, 1, { acceptedArgs });
    hooks.addFilter('filters.args', twoArgs, 2, { acceptedArgs });
    hooks.addFilter('filters.args', threeArgs, 3, { acceptedArgs });

    const result = await hooks.applyFilters('filters.args', 'v', 10, 20);

    expect(events).toEqual(expectedEvents[acceptedArgs]);
    if (acceptedArgs === 1) {
      expect(result).toBe('v');
    } else if (acceptedArgs === 2) {
      expect(result).toBe('v-10-10');
    } else {
      expect(result).toBe('v-10-10-20');
    }
  });

  it('removeFilter works immediately', async () => {
    const marker: string[] = [];
    hooks.addFilter('filters.remove', (v) => { marker.push('keep'); return v; }, 10);
    const removeId = hooks.addFilter('filters.remove', (v) => { marker.push('remove'); return v; }, 20);

    hooks.removeFilter('filters.remove', removeId);
    const result = await hooks.applyFilters('filters.remove', 'start');

    expect(marker).toEqual(['keep']);
    expect(result).toBe('start');
  });

  it('removeFilter deferred until execution completes', async () => {
    const marker: string[] = [];
    let deferredId: string;

    const first = (value: string) => {
      hooks.removeFilter('filters.remove_deferred', deferredId);
      return `${value}:first`;
    };
    const second = (value: string) => {
      marker.push('second');
      return `${value}:second`;
    };

    hooks.addFilter('filters.remove_deferred', (v: string) => `${v}:first`);
    deferredId = hooks.addFilter('filters.remove_deferred', first, 20);
    hooks.addFilter('filters.remove_deferred', second, 30);

    const result = await hooks.applyFilters('filters.remove_deferred', 'seed');
    expect(result).toBe('seed:first:first:second');
    expect(marker).toEqual(['second']);
    expect(hooks.hasFilter('filters.remove_deferred', deferredId)).toBe(false);
  });

  it('hasFilter returns true/false or count', () => {
    const firstId = hooks.addFilter('filters.has', (v) => v);
    const secondId = hooks.addFilter('filters.has', (v) => v, 20);

    expect(hooks.hasFilter('filters.has')).toBe(2);
    expect(hooks.hasFilter('filters.has', firstId)).toBe(true);
    expect(hooks.hasFilter('filters.has', 'missing')).toBe(false);

    hooks.removeFilter('filters.has', firstId);
    expect(hooks.hasFilter('filters.has')).toBe(1);
    expect(hooks.hasFilter('filters.has', firstId)).toBe(false);
    expect(hooks.hasFilter('filters.has', secondId)).toBe(true);
  });

  it('doingFilter is true during execution', async () => {
    const marker: boolean[] = [];
    hooks.addFilter('filters.state', (v: string) => {
      marker.push(hooks.doingFilter('filters.state'));
      return v;
    });
    expect(hooks.doingFilter('filters.state')).toBe(false);
    await hooks.applyFilters('filters.state', 'x');
    expect(marker).toEqual([true]);
    expect(hooks.doingFilter('filters.state')).toBe(false);
  });

  it('didFilter counts invocations', async () => {
    hooks.addFilter('filters.count', (v) => v);
    hooks.addFilter('filters.count', (v) => v, 20);

    await hooks.applyFilters('filters.count', 'one');
    await hooks.applyFilters('filters.count', 'two');
    expect(hooks.didFilter('filters.count')).toBe(2);
  });

  it('exception in filter logs error and keeps current value', async () => {
    const marker: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    hooks.addFilter('filters.exception', async (_v: string) => { throw new Error('bad filter'); }, 10);
    hooks.addFilter('filters.exception', (v: string) => { marker.push('good'); return `${v}:good`; }, 20);

    const result = await hooks.applyFilters('filters.exception', 'seed');
    expect(result).toBe('seed:good');
    expect(marker).toEqual(['good']);
    expect(hooks.didFilter('filters.exception')).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('apply_filters exception'),
      expect.any(Error),
    );
  });

  it('empty filter chain returns original value', async () => {
    const result = await hooks.applyFilters('filters.empty', { alpha: 1 });
    expect(result).toEqual({ alpha: 1 });
  });

  it.each([1, 5, 25, 50])('n=%i filters transform stabilization', async (n) => {
    for (let i = 0; i < n; i++) {
      const idx = i;
      hooks.addFilter('filters.large_chain', (value: string) => `${value}|${idx}`, i);
    }
    const result = await hooks.applyFilters('filters.large_chain', 'start') as string;
    expect(result.startsWith('start')).toBe(true);
    expect(result.split('|').length - 1).toBe(n);
  });

  it('handles sync and async filters mixed', async () => {
    hooks.addFilter('filters.mix', (v: string) => `${v}:s`, 5);
    hooks.addFilter('filters.mix', async (v: string) => { await Promise.resolve(); return `${v}:a`; }, 10);
    hooks.addFilter('filters.mix', (v: string) => `${v}:s`, 15);

    const result = await hooks.applyFilters('filters.mix', 'seed');
    expect(result).toBe('seed:s:a:s');
  });

  it('filter timeout logs warning and keeps current value', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    hooks.addFilter(
      'filters.timeout',
      async (v: string) => {
        await new Promise((r) => setTimeout(r, 50));
        return `${v}:late`;
      },
      10,
      { timeoutSeconds: 0.001 },
    );

    const result = await hooks.applyFilters('filters.timeout', 'seed');
    expect(result).toBe('seed');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('apply_filters timeout'));
  });

  it('filter applied to complex types (object mutation)', async () => {
    hooks.addFilter('filters.types', (value: Record<string, number>) => {
      value['count'] += 1;
      return value;
    });
    const value = { count: 1 };
    const result = await hooks.applyFilters('filters.types', value);
    expect(result).toBe(value);
    expect((value as Record<string, number>)['count']).toBe(2);
  });

  it('removeAllFilters by priority', async () => {
    const values: string[] = [];
    hooks.addFilter('filters.remove_priority', (v: string) => { values.push('a'); return `${v}a`; }, 5);
    hooks.addFilter('filters.remove_priority', (v: string) => { values.push('b'); return `${v}b`; }, 10);
    hooks.addFilter('filters.remove_priority', (v: string) => { values.push('c'); return `${v}c`; }, 10);

    hooks.removeAllFilters('filters.remove_priority', 10);
    const result = await hooks.applyFilters('filters.remove_priority', 'x');

    expect(values).toEqual(['a']);
    expect(result).toBe('xa');
    expect(hooks.hasFilter('filters.remove_priority')).toBe(1);
  });

  it('removeAllFilters without priority clears all', async () => {
    hooks.addFilter('filters.remove_all', (v) => v, 1);
    hooks.addFilter('filters.remove_all', (v) => v, 2);
    expect(hooks.removeAllFilters('filters.remove_all')).toBe(true);
    expect(hooks.hasFilter('filters.remove_all')).toBe(0);

    const result = await hooks.applyFilters('filters.remove_all', 'ok');
    expect(result).toBe('ok');
  });

  it('filter chain handles unicode values', async () => {
    hooks.addFilter('filters.unicode', (v: string) => `${v}-☃`);
    const result = await hooks.applyFilters('filters.unicode', 'value');
    expect(result).toBe('value-☃');
  });

  it('filter chaining supports null/undefined value', async () => {
    const marker: string[] = [];
    hooks.addFilter('filters.none', (_v) => { marker.push('a'); return 'a'; });
    hooks.addFilter('filters.none', (_v) => { marker.push('b'); return null; });
    hooks.addFilter('filters.none', (v) => { marker.push('c'); return v; });

    const result = await hooks.applyFilters('filters.none', null);
    expect(marker).toEqual(['a', 'b', 'c']);
    expect(result).toBeNull();
  });

  it('addFilter with invalid hookName throws', () => {
    expect(() => hooks.addFilter('', (v) => v)).toThrow(TypeError);
    // @ts-expect-error testing invalid type
    expect(() => hooks.addFilter(123, (v) => v)).toThrow(TypeError);
  });
});
