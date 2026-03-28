import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncHooks } from '../src/index';

describe('introspection: registeredEvents + describe + describeAll', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = new AsyncHooks();
  });

  // ─ registeredEvents ───────────────────────────────────────────────────────

  it('registeredEvents is empty initially', () => {
    expect(hooks.registeredEvents().size).toBe(0);
  });

  it('registeredEvents includes hooks after addAction', () => {
    hooks.addAction('task.created', () => {});
    expect(hooks.registeredEvents()).toContain('task.created');
  });

  it('registeredEvents includes hooks after addFilter', () => {
    hooks.addFilter('task.payload', (v) => v);
    expect(hooks.registeredEvents()).toContain('task.payload');
  });

  it('registeredEvents covers both action and filter registries', () => {
    hooks.addAction('evt.action', () => {});
    hooks.addFilter('evt.filter', (v) => v);
    const events = hooks.registeredEvents();
    expect(events).toContain('evt.action');
    expect(events).toContain('evt.filter');
  });

  it('registeredEvents excludes removed hooks', () => {
    const cid = hooks.addAction('evt.transient', () => {});
    hooks.removeAction('evt.transient', cid);
    expect(hooks.registeredEvents()).not.toContain('evt.transient');
  });

  // ─ describe() ─────────────────────────────────────────────────────────────

  it('describe returns empty array for unknown hook', () => {
    expect(hooks.describe('no.such.hook')).toEqual([]);
  });

  it('describe action basic fields', () => {
    const myHandler = async function myHandler() {};
    const cid = hooks.addAction('task.created', myHandler, 5);
    const infos = hooks.describe('task.created');

    expect(infos).toHaveLength(1);
    const info = infos[0];
    expect(info.callbackId).toBe(cid);
    expect(info.hookName).toBe('task.created');
    expect(info.hookType).toBe('action');
    expect(info.priority).toBe(5);
    expect(info.handlerName).toContain('myHandler');
    expect(info.detached).toBe(false);
    expect(info.acceptedArgs).toBe(1);
  });

  it('describe filter basic fields', () => {
    const myFilter = async (val: unknown) => val;
    const cid = hooks.addFilter('task.payload', myFilter, 20, { acceptedArgs: 2 });
    const infos = hooks.describe('task.payload');

    expect(infos).toHaveLength(1);
    const info = infos[0];
    expect(info.hookType).toBe('filter');
    expect(info.priority).toBe(20);
    expect(info.acceptedArgs).toBe(2);
    expect(info.detached).toBe(false);
    expect(info.callbackId).toBe(cid);
  });

  it('describe sorts by priority ascending', () => {
    hooks.addAction('evt.order', async () => {}, 50);
    hooks.addAction('evt.order', async () => {}, 5);
    const infos = hooks.describe('evt.order');
    expect(infos[0].priority).toBe(5);
    expect(infos[1].priority).toBe(50);
  });

  it('describe shows detached flag', () => {
    const handler = async () => {};
    hooks.addAction('evt.detached', handler, 10, { detach: true });
    const infos = hooks.describe('evt.detached');
    expect(infos[0].detached).toBe(true);
  });

  it('describe anonymous handler name', () => {
    hooks.addAction('evt.lambda', () => {});
    const infos = hooks.describe('evt.lambda');
    // Arrow functions have empty name or '<anonymous>'
    expect(infos[0].handlerName).toBeTruthy();
  });

  it('describe covers both action and filter on same hook', () => {
    hooks.addAction('evt.mixed', async () => {});
    hooks.addFilter('evt.mixed', (v) => v);
    const infos = hooks.describe('evt.mixed');
    const types = new Set(infos.map((i) => i.hookType));
    expect(types).toContain('action');
    expect(types).toContain('filter');
  });

  it('describe excludes callbacks pending deferred removal', async () => {
    const removedCid: string[] = [];

    const selfRemoving = async () => {
      hooks.removeAction('evt.deferred', removedCid[0]);
    };

    const cid = hooks.addAction('evt.deferred', selfRemoving);
    removedCid.push(cid);

    await hooks.doAction('evt.deferred');

    const infos = hooks.describe('evt.deferred');
    expect(infos.every((i) => i.callbackId !== cid)).toBe(true);
  });

  // ─ describeAll() ──────────────────────────────────────────────────────────

  it('describeAll returns empty array when no hooks', () => {
    expect(hooks.describeAll()).toEqual([]);
  });

  it('describeAll covers multiple hooks', () => {
    hooks.addAction('alpha', () => {});
    hooks.addFilter('beta', (v) => v);
    hooks.addAction('gamma', () => {});

    const infos = hooks.describeAll();
    const hookNames = infos.map((i) => i.hookName);
    expect(hookNames).toContain('alpha');
    expect(hookNames).toContain('beta');
    expect(hookNames).toContain('gamma');
  });

  it('describeAll is sorted by hook name', () => {
    hooks.addAction('zzz', () => {});
    hooks.addAction('aaa', () => {});
    hooks.addAction('mmm', () => {});

    const infos = hooks.describeAll();
    const names = infos.map((i) => i.hookName);
    expect(names).toEqual([...names].sort());
  });
});
