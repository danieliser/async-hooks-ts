import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AsyncHooks } from '../src/index';

describe('subscribeAll / unsubscribeAll', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = new AsyncHooks({ actionTimeoutSeconds: 0.1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribeAll returns a callback ID', () => {
    const cid = hooks.subscribeAll(() => {});
    expect(typeof cid).toBe('string');
    expect(cid.length).toBeGreaterThan(0);
  });

  it('hasGlobal is true after subscribe', () => {
    const cid = hooks.subscribeAll(() => {});
    expect(hooks.hasGlobal(cid)).toBe(true);
  });

  it('hasGlobal is false for unknown ID', () => {
    expect(hooks.hasGlobal('nonexistent')).toBe(false);
  });

  it('global handler fires on doAction', async () => {
    const captured: string[] = [];
    hooks.subscribeAll(async (eventName: string) => { captured.push(eventName); });
    await hooks.doAction('task.created');
    expect(captured).toEqual(['task.created']);
  });

  it('global handler fires for every event', async () => {
    const captured: string[] = [];
    hooks.subscribeAll(async (eventName: string) => { captured.push(eventName); });
    await hooks.doAction('task.created');
    await hooks.doAction('task.completed');
    await hooks.doAction('config.changed');
    expect(new Set(captured)).toEqual(new Set(['task.created', 'task.completed', 'config.changed']));
  });

  it('global handler receives event name as first arg', async () => {
    const received: unknown[] = [];
    hooks.subscribeAll(async (eventName: string, ...args: unknown[]) => {
      received.push([eventName, args]);
    });
    await hooks.doAction('my.event', 'payload', { key: 'val' });
    expect(received).toEqual([['my.event', ['payload', { key: 'val' }]]]);
  });

  it('global handler fires on applyFilters', async () => {
    const captured: string[] = [];
    hooks.subscribeAll(async (eventName: string) => { captured.push(eventName); });
    await hooks.applyFilters('task.payload', { id: 1 });
    expect(captured).toEqual(['task.payload']);
  });

  it('global handler receives post-chain filter value', async () => {
    const receivedValues: unknown[] = [];

    hooks.addFilter('num.filter', async (val: number) => val * 2);
    hooks.subscribeAll(async (_eventName: string, value: unknown) => {
      receivedValues.push(value);
    });

    await hooks.applyFilters('num.filter', 5);
    expect(receivedValues).toEqual([10]);
  });

  it('global handler return value is ignored in filter chain', async () => {
    hooks.subscribeAll(async (_eventName: string, _value: unknown) => 9999);
    const result = await hooks.applyFilters('passthrough', 42);
    expect(result).toBe(42);
  });

  it('global fires after specific handlers', async () => {
    const order: string[] = [];

    hooks.addAction('evt.order', async () => { order.push('specific'); }, 10);
    hooks.subscribeAll(async () => { order.push('global'); }, 90);

    await hooks.doAction('evt.order');
    expect(order).toEqual(['specific', 'global']);
  });

  it('global fires even with no specific handlers', async () => {
    const captured: string[] = [];
    hooks.subscribeAll(async (eventName: string) => { captured.push(eventName); });
    await hooks.doAction('evt.no_specific_handlers');
    expect(captured).toEqual(['evt.no_specific_handlers']);
  });

  it('global handlers respect priority', async () => {
    const order: string[] = [];
    hooks.subscribeAll(() => { order.push('second'); }, 50);
    hooks.subscribeAll(() => { order.push('first'); }, 10);
    await hooks.doAction('any.event');
    expect(order).toEqual(['first', 'second']);
  });

  it('unsubscribeAll removes handler', async () => {
    const captured: string[] = [];
    const cid = hooks.subscribeAll(async (eventName: string) => { captured.push(eventName); });
    hooks.unsubscribeAll(cid);

    await hooks.doAction('evt.after_unsub');
    expect(captured).toEqual([]);
  });

  it('unsubscribeAll returns false for unknown ID', () => {
    expect(hooks.unsubscribeAll('nonexistent')).toBe(false);
  });

  it('unsubscribeAll returns false for an action callback', () => {
    const cid = hooks.addAction('evt', () => {});
    expect(hooks.unsubscribeAll(cid)).toBe(false);
  });

  it('hasGlobal is false after unsubscribe', () => {
    const cid = hooks.subscribeAll(() => {});
    hooks.unsubscribeAll(cid);
    expect(hooks.hasGlobal(cid)).toBe(false);
  });

  it('unsubscribeAll deferred during execution (self-removing)', async () => {
    const fired: string[] = [];
    let cid: string;

    const handler = async (_eventName: string) => {
      hooks.unsubscribeAll(cid);
      fired.push('ran');
    };

    cid = hooks.subscribeAll(handler);
    await hooks.doAction('evt.self_remove');
    expect(fired).toEqual(['ran']);

    fired.length = 0;
    await hooks.doAction('evt.self_remove');
    expect(fired).toEqual([]);
  });

  it('global handler exception does not break chain', async () => {
    const secondFired: boolean[] = [];
    hooks.subscribeAll(async () => { throw new Error('boom'); }, 10);
    hooks.subscribeAll(async () => { secondFired.push(true); }, 20);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    await hooks.doAction('evt.error');
    expect(secondFired).toEqual([true]);
  });

  it('no global hooks: no overhead, normal execution unaffected', async () => {
    const fired: string[] = [];
    hooks.addAction('evt.no_global', () => { fired.push('ok'); });
    await hooks.doAction('evt.no_global');
    expect(fired).toEqual(['ok']);
  });
});
