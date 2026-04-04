import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AsyncHooks } from '../src/index';

function makeHooks() {
  return new AsyncHooks({ actionTimeoutSeconds: 0.05, filterTimeoutSeconds: null });
}

describe('tag-based removal', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = makeHooks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('addAction with tag stores tag association', () => {
    const id = hooks.addAction('tags.action', () => {}, 10, { tag: 'my-plugin' });
    expect(hooks.hasAction('tags.action', id)).toBe(true);
    // Tag is stored — removeByTag should find it
    expect(hooks.removeByTag('my-plugin')).toBe(1);
    expect(hooks.hasAction('tags.action', id)).toBe(false);
  });

  it('addFilter with tag stores tag association', () => {
    const id = hooks.addFilter('tags.filter', (v: unknown) => v, 10, { tag: 'my-plugin' });
    expect(hooks.hasFilter('tags.filter', id)).toBe(true);
    expect(hooks.removeByTag('my-plugin')).toBe(1);
    expect(hooks.hasFilter('tags.filter', id)).toBe(false);
  });

  it('subscribeAll with tag stores tag association', () => {
    const id = hooks.subscribeAll(() => {}, 90, undefined, 'my-plugin');
    expect(hooks.hasGlobal(id)).toBe(true);
    expect(hooks.removeByTag('my-plugin')).toBe(1);
    expect(hooks.hasGlobal(id)).toBe(false);
  });

  it('removeByTag removes all tagged actions', async () => {
    const calls: string[] = [];
    hooks.addAction('tags.multi', () => calls.push('tagged-1'), 10, { tag: 'bulk' });
    hooks.addAction('tags.multi', () => calls.push('tagged-2'), 20, { tag: 'bulk' });
    hooks.addAction('tags.multi', () => calls.push('untagged'), 30);

    hooks.removeByTag('bulk');
    await hooks.doAction('tags.multi');
    expect(calls).toEqual(['untagged']);
  });

  it('removeByTag removes all tagged filters', async () => {
    hooks.addFilter('tags.fmulti', (v: number) => v + 1, 10, { tag: 'bulk' });
    hooks.addFilter('tags.fmulti', (v: number) => v + 10, 20, { tag: 'bulk' });
    hooks.addFilter('tags.fmulti', (v: number) => v + 100, 30);

    hooks.removeByTag('bulk');
    const result = await hooks.applyFilters('tags.fmulti', 0);
    expect(result).toBe(100);
  });

  it('removeByTag removes all tagged globals', async () => {
    const globalCalls: string[] = [];
    hooks.subscribeAll(() => globalCalls.push('tagged'), 90, undefined, 'bulk');
    hooks.subscribeAll(() => globalCalls.push('untagged'), 90);

    hooks.removeByTag('bulk');
    await hooks.doAction('tags.globals');
    expect(globalCalls).toEqual(['untagged']);
  });

  it('removeByTag returns count of removed callbacks', () => {
    hooks.addAction('tags.count', () => {}, 10, { tag: 'x' });
    hooks.addAction('tags.count2', () => {}, 10, { tag: 'x' });
    hooks.addFilter('tags.count3', (v: unknown) => v, 10, { tag: 'x' });
    expect(hooks.removeByTag('x')).toBe(3);
  });

  it('removeByTag returns 0 for unknown tag', () => {
    expect(hooks.removeByTag('nonexistent')).toBe(0);
  });

  it('mixed tags: removeByTag only removes matching tag', async () => {
    const calls: string[] = [];
    hooks.addAction('tags.mixed', () => calls.push('a'), 10, { tag: 'alpha' });
    hooks.addAction('tags.mixed', () => calls.push('b'), 20, { tag: 'beta' });
    hooks.addAction('tags.mixed', () => calls.push('c'), 30, { tag: 'alpha' });

    hooks.removeByTag('alpha');
    await hooks.doAction('tags.mixed');
    expect(calls).toEqual(['b']);
  });

  it('on() and intercept() support tag option', () => {
    const id1 = hooks.on('tags.on', () => {}, 10, { tag: 'plug' });
    const id2 = hooks.intercept('tags.intercept', (v: unknown) => v, 10, { tag: 'plug' });
    expect(hooks.removeByTag('plug')).toBe(2);
    expect(hooks.hasAction('tags.on', id1)).toBe(false);
    expect(hooks.hasFilter('tags.intercept', id2)).toBe(false);
  });

  it('deferred removal during execution (tag removal while hook is running)', async () => {
    const calls: string[] = [];
    const id2 = hooks.addAction('tags.deferred', () => {
      calls.push('first');
      // Remove by tag while executing — should defer
      hooks.removeByTag('defer-tag');
    }, 5);

    hooks.addAction('tags.deferred', () => calls.push('tagged'), 10, { tag: 'defer-tag' });
    hooks.addAction('tags.deferred', () => calls.push('after'), 20);

    await hooks.doAction('tags.deferred');
    // The tagged callback runs because removal is deferred during execution
    // But after execution completes, it should be removed
    expect(calls).toContain('first');

    // After the hook finishes, the tagged callback should be gone
    calls.length = 0;
    await hooks.doAction('tags.deferred');
    expect(calls).not.toContain('tagged');
  });
});
