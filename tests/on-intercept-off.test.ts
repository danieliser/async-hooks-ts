import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncHooks } from '../src/index';

describe('on / intercept / off', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = new AsyncHooks({ actionTimeoutSeconds: 0.05 });
  });

  // ─ on() ───────────────────────────────────────────────────────────────────

  it('on registers in action registry', () => {
    const handler = async () => {};
    const cid = hooks.on('evt.on', handler);
    expect(hooks.hasAction('evt.on', cid)).toBe(true);
    expect(hooks.hasFilter('evt.on', cid)).toBe(false);
  });

  it('on fires on doAction', async () => {
    const fired: string[] = [];
    hooks.on('evt.action', async () => { fired.push('fired'); });
    await hooks.doAction('evt.action');
    expect(fired).toEqual(['fired']);
  });

  it('on does not fire on applyFilters', async () => {
    const fired: string[] = [];
    hooks.on('evt.filter_only', async (val: unknown) => { fired.push('fired'); return val; });
    const result = await hooks.applyFilters('evt.filter_only', 42);
    expect(fired).toEqual([]);
    expect(result).toBe(42);
  });

  it('on return value is ignored', async () => {
    hooks.on('evt.return', async () => 'this should be ignored');
    const result = await hooks.doAction('evt.return');
    expect(result).toBeUndefined();
  });

  it('on respects priority', async () => {
    const order: string[] = [];
    hooks.on('evt.priority', () => { order.push('b'); }, 20);
    hooks.on('evt.priority', () => { order.push('a'); }, 5);
    await hooks.doAction('evt.priority');
    expect(order).toEqual(['a', 'b']);
  });

  // ─ intercept() ────────────────────────────────────────────────────────────

  it('intercept registers in filter registry', () => {
    const handler = async (val: unknown) => val;
    const cid = hooks.intercept('evt.intercept', handler);
    expect(hooks.hasFilter('evt.intercept', cid)).toBe(true);
    expect(hooks.hasAction('evt.intercept', cid)).toBe(false);
  });

  it('intercept fires on applyFilters', async () => {
    hooks.intercept('evt.double', async (val: number) => val * 2);
    const result = await hooks.applyFilters('evt.double', 5);
    expect(result).toBe(10);
  });

  it('intercept does not fire on doAction', async () => {
    const fired: string[] = [];
    hooks.intercept('evt.action_only', async () => { fired.push('fired'); });
    await hooks.doAction('evt.action_only');
    expect(fired).toEqual([]);
  });

  it('intercept chains values', async () => {
    hooks.intercept('evt.chain', (v: number) => v + 1, 10);
    hooks.intercept('evt.chain', (v: number) => v * 3, 20);
    const result = await hooks.applyFilters('evt.chain', 4);
    expect(result).toBe(15); // (4 + 1) * 3
  });

  // ─ off() ──────────────────────────────────────────────────────────────────

  it('off removes action registered via on', async () => {
    const fired: string[] = [];
    const cid = hooks.on('evt.off_action', async () => { fired.push('fired'); });
    hooks.off('evt.off_action', cid);
    await hooks.doAction('evt.off_action');
    expect(fired).toEqual([]);
  });

  it('off removes filter registered via intercept', async () => {
    const cid = hooks.intercept('evt.off_filter', async (val: number) => val * 2);
    hooks.off('evt.off_filter', cid);
    const result = await hooks.applyFilters('evt.off_filter', 5);
    expect(result).toBe(5);
  });

  it('off removes action registered via addAction', async () => {
    const fired: string[] = [];
    const cid = hooks.addAction('evt.off_add_action', async () => { fired.push('fired'); });
    hooks.off('evt.off_add_action', cid);
    await hooks.doAction('evt.off_add_action');
    expect(fired).toEqual([]);
  });

  it('off removes filter registered via addFilter', async () => {
    const cid = hooks.addFilter('evt.off_add_filter', async (val: number) => val * 2);
    hooks.off('evt.off_add_filter', cid);
    const result = await hooks.applyFilters('evt.off_add_filter', 5);
    expect(result).toBe(5);
  });

  it('off returns false for unknown callback ID', () => {
    expect(hooks.off('evt.unknown', 'nonexistent-id')).toBe(false);
  });

  it('off deferred during action execution (self-removing)', async () => {
    const fired: string[] = [];
    let cid: string;

    const handler = async () => {
      hooks.off('evt.deferred_off', cid);
      fired.push('ran');
    };

    cid = hooks.on('evt.deferred_off', handler);
    await hooks.doAction('evt.deferred_off');
    expect(fired).toEqual(['ran']);

    fired.length = 0;
    await hooks.doAction('evt.deferred_off');
    expect(fired).toEqual([]);
  });
});
