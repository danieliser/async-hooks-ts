import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncHooks } from '../src/index';

describe('namespaces', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = new AsyncHooks({ actionTimeoutSeconds: 0.1 });
  });

  // ─ _hookMatchesNamespace ──────────────────────────────────────────────────

  it('exact match', () => {
    expect(hooks._hookMatchesNamespace('task', 'task')).toBe(true);
  });

  it('child match', () => {
    expect(hooks._hookMatchesNamespace('task.created', 'task')).toBe(true);
  });

  it('nested child match', () => {
    expect(hooks._hookMatchesNamespace('task.lifecycle.start', 'task')).toBe(true);
  });

  it('no partial prefix match (taskrunner != task)', () => {
    expect(hooks._hookMatchesNamespace('taskrunner.created', 'task')).toBe(false);
  });

  it('sibling does not match', () => {
    expect(hooks._hookMatchesNamespace('config.changed', 'task')).toBe(false);
  });

  it('sub-namespace match', () => {
    expect(hooks._hookMatchesNamespace('task.lifecycle.start', 'task.lifecycle')).toBe(true);
    expect(hooks._hookMatchesNamespace('task.created', 'task.lifecycle')).toBe(false);
  });

  // ─ subscribeAll with namespace ────────────────────────────────────────────

  it('subscribeAll namespace fires for matching event', async () => {
    const captured: string[] = [];
    hooks.subscribeAll(async (eventName: string) => { captured.push(eventName); }, 90, 'task');
    await hooks.doAction('task.created');
    expect(captured).toEqual(['task.created']);
  });

  it('subscribeAll namespace does not fire for other namespace', async () => {
    const captured: string[] = [];
    hooks.subscribeAll(async (eventName: string) => { captured.push(eventName); }, 90, 'task');
    await hooks.doAction('config.changed');
    expect(captured).toEqual([]);
  });

  it('subscribeAll namespace fires for all matching events', async () => {
    const captured: string[] = [];
    hooks.subscribeAll(async (eventName: string) => { captured.push(eventName); }, 90, 'task');
    await hooks.doAction('task.created');
    await hooks.doAction('task.completed');
    await hooks.doAction('task.dispatch');
    await hooks.doAction('config.changed');
    expect(new Set(captured)).toEqual(new Set(['task.created', 'task.completed', 'task.dispatch']));
  });

  it('subscribeAll without namespace fires for everything', async () => {
    const captured: string[] = [];
    hooks.subscribeAll(async (eventName: string) => { captured.push(eventName); });
    await hooks.doAction('task.created');
    await hooks.doAction('config.changed');
    expect(new Set(captured)).toEqual(new Set(['task.created', 'config.changed']));
  });

  it('multiple namespace subscriptions are independent', async () => {
    const taskEvents: string[] = [];
    const configEvents: string[] = [];
    hooks.subscribeAll(async (n: string) => { taskEvents.push(n); }, 90, 'task');
    hooks.subscribeAll(async (n: string) => { configEvents.push(n); }, 90, 'config');
    await hooks.doAction('task.created');
    await hooks.doAction('config.changed');
    expect(taskEvents).toEqual(['task.created']);
    expect(configEvents).toEqual(['config.changed']);
  });

  it('namespace fires on applyFilters', async () => {
    const captured: string[] = [];
    hooks.subscribeAll(async (n: string) => { captured.push(n); }, 90, 'task');
    await hooks.applyFilters('task.payload', { id: 1 });
    await hooks.applyFilters('config.value', 'x');
    expect(captured).toEqual(['task.payload']);
  });

  it('namespace exact match fires (hook == namespace)', async () => {
    const captured: string[] = [];
    hooks.subscribeAll((n: string) => { captured.push(n); }, 90, 'task');
    await hooks.doAction('task');
    expect(captured).toEqual(['task']);
  });

  it('sub-namespace routing', async () => {
    const lifecycle: string[] = [];
    const other: string[] = [];
    hooks.subscribeAll((n: string) => { lifecycle.push(n); }, 90, 'task.lifecycle');
    hooks.subscribeAll((n: string) => { other.push(n); }, 90, 'task');
    await hooks.doAction('task.lifecycle.start');
    await hooks.doAction('task.created');
    expect(lifecycle).toEqual(['task.lifecycle.start']);
    expect(new Set(other)).toEqual(new Set(['task.lifecycle.start', 'task.created']));
  });

  it('subscribeAll with empty namespace throws', () => {
    expect(() => hooks.subscribeAll(() => {}, 90, '')).toThrow(TypeError);
  });

  // ─ registeredEvents(namespace) ────────────────────────────────────────────

  it('registeredEvents namespace filter', () => {
    hooks.addAction('task.created', () => {});
    hooks.addAction('task.completed', () => {});
    hooks.addAction('config.changed', () => {});
    const events = hooks.registeredEvents('task');
    expect(events).toEqual(new Set(['task.created', 'task.completed']));
  });

  it('registeredEvents namespace no match returns empty set', () => {
    hooks.addAction('config.changed', () => {});
    expect(hooks.registeredEvents('task').size).toBe(0);
  });

  it('registeredEvents without namespace returns all', () => {
    hooks.addAction('task.created', () => {});
    hooks.addFilter('config.value', (v) => v);
    const events = hooks.registeredEvents();
    expect(events).toContain('task.created');
    expect(events).toContain('config.value');
  });

  it('registeredEvents no partial prefix match', () => {
    hooks.addAction('taskrunner.created', () => {});
    expect(hooks.registeredEvents('task').size).toBe(0);
  });

  // ─ describeAll(namespace) ─────────────────────────────────────────────────

  it('describeAll namespace filter', () => {
    hooks.addAction('task.created', () => {});
    hooks.addAction('task.completed', () => {});
    hooks.addFilter('config.value', (v) => v);
    const infos = hooks.describeAll('task');
    const hookNames = new Set(infos.map((i) => i.hookName));
    expect(hookNames).toEqual(new Set(['task.created', 'task.completed']));
    expect(hookNames).not.toContain('config.value');
  });

  it('describeAll without namespace returns all', () => {
    hooks.addAction('task.created', () => {});
    hooks.addFilter('config.value', (v) => v);
    const infos = hooks.describeAll();
    const hookNames = new Set(infos.map((i) => i.hookName));
    expect(hookNames).toContain('task.created');
    expect(hookNames).toContain('config.value');
  });

  // ─ removeNamespace() ──────────────────────────────────────────────────────

  it('removeNamespace clears matching hooks', () => {
    hooks.addAction('task.created', () => {});
    hooks.addAction('task.completed', () => {});
    hooks.addFilter('config.value', (v) => v);
    const count = hooks.removeNamespace('task');
    expect(count).toBe(2);
    expect(hooks.registeredEvents('task').size).toBe(0);
    expect(hooks.registeredEvents()).toContain('config.value');
  });

  it('removeNamespace returns 0 if no match', () => {
    hooks.addAction('config.changed', () => {});
    expect(hooks.removeNamespace('task')).toBe(0);
  });

  it('removeNamespace no partial prefix match', () => {
    hooks.addAction('taskrunner.start', () => {});
    expect(hooks.removeNamespace('task')).toBe(0);
    expect(hooks.registeredEvents()).toContain('taskrunner.start');
  });

  it('removeNamespace removes both action and filter on same hook', () => {
    hooks.addAction('task.created', () => {});
    hooks.addFilter('task.created', (v) => v);
    hooks.removeNamespace('task');
    expect(hooks.hasAction('task.created')).toBe(0);
    expect(hooks.hasFilter('task.created')).toBe(0);
  });

  it('removeNamespace sub-namespace', () => {
    hooks.addAction('task.lifecycle.start', () => {});
    hooks.addAction('task.lifecycle.stop', () => {});
    hooks.addAction('task.created', () => {});
    const count = hooks.removeNamespace('task.lifecycle');
    expect(count).toBe(2);
    expect(hooks.registeredEvents()).toContain('task.created');
    expect(hooks.registeredEvents('task.lifecycle').size).toBe(0);
  });

  it('removeNamespace with empty string throws', () => {
    expect(() => hooks.removeNamespace('')).toThrow(TypeError);
  });

  it('removed namespace callbacks no longer fire', async () => {
    const fired: string[] = [];
    hooks.addAction('task.created', () => { fired.push('task'); });
    hooks.addAction('config.changed', () => { fired.push('config'); });
    hooks.removeNamespace('task');
    await hooks.doAction('task.created');
    await hooks.doAction('config.changed');
    expect(fired).toEqual(['config']);
  });
});
