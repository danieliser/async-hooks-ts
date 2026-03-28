import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncHooks } from '../src/index';

describe('sync and async callbacks', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = new AsyncHooks();
  });

  it('sync action works', async () => {
    const events: string[] = [];
    hooks.addAction('sync_async.action', () => { events.push('sync'); });
    await hooks.doAction('sync_async.action');
    expect(events).toEqual(['sync']);
  });

  it('async action works', async () => {
    const events: string[] = [];
    hooks.addAction('sync_async.action2', async () => {
      await Promise.resolve();
      events.push('async');
    });
    await hooks.doAction('sync_async.action2');
    expect(events).toEqual(['async']);
  });

  it('mixed sync and async callbacks in action', async () => {
    const events: string[] = [];

    hooks.addAction('sync_async.mix', () => { events.push('sync1'); }, 10);
    hooks.addAction('sync_async.mix', async () => {
      await Promise.resolve();
      events.push('async');
    }, 15);
    hooks.addAction('sync_async.mix', () => { events.push('sync2'); }, 20);

    await hooks.doAction('sync_async.mix');
    expect(events).toEqual(['sync1', 'async', 'sync2']);
  });

  it('sync action returning a Promise is awaited', async () => {
    const events: string[] = [];

    const syncReturningPromise = () => {
      return new Promise<void>((resolve) => {
        setTimeout(() => { events.push('inner'); resolve(); }, 0);
      });
    };

    hooks.addAction('sync_async.awaitable', syncReturningPromise);
    await hooks.doAction('sync_async.awaitable');
    expect(events).toEqual(['inner']);
  });

  it('sync filter works', async () => {
    const events: string[] = [];
    hooks.addFilter('sync_async.filter', (value: string) => {
      events.push('sync');
      return `${value}-sync`;
    });
    const result = await hooks.applyFilters('sync_async.filter', 'start');
    expect(result).toBe('start-sync');
    expect(events).toEqual(['sync']);
  });

  it('async filter works', async () => {
    const events: string[] = [];
    hooks.addFilter('sync_async.filter2', async (value: string) => {
      await Promise.resolve();
      events.push('async');
      return `${value}-async`;
    });
    const result = await hooks.applyFilters('sync_async.filter2', 'seed');
    expect(result).toBe('seed-async');
    expect(events).toEqual(['async']);
  });

  it('mixed sync and async filters', async () => {
    const events: string[] = [];

    hooks.addFilter('sync_async.filter3', (v: string) => { events.push('sync1'); return `${v}-sync1`; }, 10);
    hooks.addFilter('sync_async.filter3', async (v: string) => {
      events.push('async');
      await Promise.resolve();
      return `${v}-async`;
    }, 15);
    hooks.addFilter('sync_async.filter3', (v: string) => { events.push('sync2'); return `${v}-sync2`; }, 20);
    hooks.addFilter('sync_async.filter3', (v: string) => { events.push('sync3'); return `${v}-sync3`; }, 30);

    const result = await hooks.applyFilters('sync_async.filter3', 'seed');
    expect(result).toBe('seed-sync1-async-sync2-sync3');
    expect(events).toEqual(['sync1', 'async', 'sync2', 'sync3']);
  });

  it('sync filter returning a Promise is awaited', async () => {
    const events: string[] = [];

    const syncReturningPromiseFilter = (value: string) => {
      return new Promise<string>((resolve) => {
        setTimeout(() => { events.push('inner'); resolve(`${value}-inner`); }, 0);
      });
    };

    hooks.addFilter('sync_async.filter4', syncReturningPromiseFilter);
    const result = await hooks.applyFilters('sync_async.filter4', 'x');
    expect(result).toBe('x-inner');
    expect(events).toEqual(['inner']);
  });

  it('sync action can use positional args', async () => {
    const events: string[] = [];
    hooks.addAction('sync_async.args', (value: string, suffix: string) => {
      events.push(value + suffix);
    });
    await hooks.doAction('sync_async.args', 'v', 's');
    expect(events).toEqual(['vs']);
  });

  it('async action can use positional args', async () => {
    const events: string[] = [];
    hooks.addAction('sync_async.args2', async (x: number, y: number, z = 0) => {
      events.push(String(x + y + z));
    });
    await hooks.doAction('sync_async.args2', 1, 2);
    expect(events).toEqual(['3']);
  });

  it('filter chain preserves priority order', async () => {
    const events: string[] = [];
    const seq = ['a', 'b', 'c', 'd', 'e', 'f'];
    const priorities = [30, 10, 50, 20, 40, 5];

    for (let i = 0; i < seq.length; i++) {
      const label = seq[i];
      hooks.addFilter(
        'sync_async.order',
        (value: string) => { events.push(label); return `${value}|${label}`; },
        priorities[i],
      );
    }

    const result = await hooks.applyFilters('sync_async.order', 'start');
    expect(events).toEqual(['f', 'b', 'd', 'a', 'e', 'c']);
    expect(result).toBe('start|f|b|d|a|e|c');
  });

  it('filter can return null and continue', async () => {
    const events: string[] = [];

    hooks.addFilter('sync_async.none', (value: string) => {
      events.push('first');
      return null;
    });
    hooks.addFilter('sync_async.none', (value: unknown) => {
      events.push('second');
      return value === null ? 'final' : `${value}:second`;
    });

    const result = await hooks.applyFilters('sync_async.none', 'start');
    expect(events).toEqual(['first', 'second']);
    expect(result).toBe('final');
  });

  it('filter with keyword-style args (extra positional args)', async () => {
    const events: string[] = [];

    hooks.addFilter('sync_async.kw', (value: string, suffix = 'x') => {
      events.push(`${value}:${suffix}`);
      return `${value}:${suffix}`;
    }, 10, { acceptedArgs: 2 });

    hooks.addFilter('sync_async.kw', async (value: string, suffix = 'y') => {
      events.push(`${value}:${suffix}`);
      return `${value}:${suffix}:a`;
    }, 20, { acceptedArgs: 2 });

    const result = await hooks.applyFilters('sync_async.kw', 'seed', 'custom');
    expect(result).toBe('seed:custom:custom:a');
    expect(events).toEqual(['seed:custom', 'seed:custom:custom']);
  });

  it('action return value is ignored', async () => {
    const events: string[] = [];
    hooks.addAction('sync_async.ignored', () => {
      events.push('v');
      return 'value';
    });
    await hooks.doAction('sync_async.ignored');
    expect(events).toEqual(['v']);
  });

  it.each([0, 1, 2])('action and filter mixed with optional yields (delay=%ims)', async (delayMs) => {
    const events: string[] = [];

    hooks.addAction('sync_async.mixed', async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      events.push('a');
    });
    hooks.addAction('sync_async.mixed', () => { events.push('b'); }, 20);
    hooks.addFilter('sync_async.mixed', async (value: string) => {
      await new Promise((r) => setTimeout(r, delayMs));
      events.push('c');
      return `${value}-c`;
    });

    await hooks.doAction('sync_async.mixed');
    const result = await hooks.applyFilters('sync_async.mixed', 'base');

    expect(events).toEqual(['a', 'b', 'c']);
    expect(result).toBe('base-c');
  });

  it('many sync and async actions with mixed order', async () => {
    const events: string[] = [];

    hooks.addAction('sync_async.extended', () => { events.push('s1'); }, 1);
    hooks.addAction('sync_async.extended', async () => { await Promise.resolve(); events.push('s2'); }, 2);
    hooks.addAction('sync_async.extended', () => { events.push('s3'); }, 3);
    hooks.addAction('sync_async.extended', async () => { await Promise.resolve(); events.push('s4'); }, 4);
    hooks.addAction('sync_async.extended', async () => { await Promise.resolve(); events.push('s5'); }, 5);

    await hooks.doAction('sync_async.extended');
    expect(events).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });
});
