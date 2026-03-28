import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AsyncHooks } from '../src/index';

function makeHooks() {
  return new AsyncHooks({ actionTimeoutSeconds: 0.05, filterTimeoutSeconds: null });
}

describe('actions', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = makeHooks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('addAction returns unique callback IDs', () => {
    const first = hooks.addAction('actions.unique', () => {});
    const second = hooks.addAction('actions.unique', () => {});
    expect(typeof first).toBe('string');
    expect(typeof second).toBe('string');
    expect(first).not.toBe(second);
  });

  it('doAction fires callbacks in priority order (lower = first)', async () => {
    const events: string[] = [];
    hooks.addAction('actions.priority', async () => { events.push('low'); }, 20);
    hooks.addAction('actions.priority', async () => { events.push('high'); }, 5);
    hooks.addAction('actions.priority', async () => { events.push('medium'); }, 10);
    await hooks.doAction('actions.priority');
    expect(events).toEqual(['high', 'medium', 'low']);
  });

  it('doAction with no callbacks is a noop', async () => {
    await hooks.doAction('actions.noop');
    expect(hooks.didAction('actions.noop')).toBe(0);
  });

  it('multiple callbacks at same priority run in insertion order', async () => {
    const events: string[] = [];
    hooks.addAction('actions.same_priority', () => { events.push('first'); }, 10);
    hooks.addAction('actions.same_priority', () => { events.push('second'); }, 10);
    hooks.addAction('actions.same_priority', () => { events.push('third'); }, 10);
    await hooks.doAction('actions.same_priority');
    expect(events).toEqual(['first', 'second', 'third']);
  });

  it('removeAction removes the callback', async () => {
    const events: string[] = [];
    const id = hooks.addAction('actions.remove', () => { events.push('kept'); });
    hooks.removeAction('actions.remove', id);
    await hooks.doAction('actions.remove');
    expect(events).toEqual([]);
    expect(hooks.hasAction('actions.remove')).toBe(0);
    expect(hooks.hasAction('actions.remove', id)).toBe(false);
  });

  it('removeAction during execution is deferred', async () => {
    const events: string[] = [];
    let secondId: string;

    const first = async () => {
      events.push('first');
      hooks.removeAction('actions.deferred_remove', secondId);
    };
    const second = async () => { events.push('second'); };
    const third = async () => { events.push('third'); };

    secondId = hooks.addAction('actions.deferred_remove', second, 20);
    hooks.addAction('actions.deferred_remove', first, 10);
    hooks.addAction('actions.deferred_remove', third, 30);

    await hooks.doAction('actions.deferred_remove');

    expect(events).toEqual(['first', 'third']);
    expect(hooks.hasAction('actions.deferred_remove', secondId)).toBe(false);
    expect(hooks.hasAction('actions.deferred_remove')).toBe(2);
  });

  it.each([5, 15, 25])('removeAllActions by priority=%i', async (priority) => {
    const events: string[] = [];
    hooks.addAction('actions.remove_all_priority', () => { events.push('p5-a'); }, 5);
    hooks.addAction('actions.remove_all_priority', () => { events.push('p5-b'); }, 5);
    hooks.addAction('actions.remove_all_priority', () => { events.push('p15'); }, 15);
    hooks.addAction('actions.remove_all_priority', () => { events.push('p25'); }, 25);

    hooks.removeAllActions('actions.remove_all_priority', priority);
    await hooks.doAction('actions.remove_all_priority');

    if (priority === 5) {
      expect(events).toEqual(['p15', 'p25']);
      expect(hooks.hasAction('actions.remove_all_priority')).toBe(2);
    } else if (priority === 15) {
      expect(events).toEqual(['p5-a', 'p5-b', 'p25']);
      expect(hooks.hasAction('actions.remove_all_priority')).toBe(3);
    } else {
      expect(events).toEqual(['p5-a', 'p5-b', 'p15']);
      expect(hooks.hasAction('actions.remove_all_priority')).toBe(3);
    }
  });

  it('removeAllActions without priority clears all', async () => {
    hooks.addAction('actions.remove_all_all', () => {}, 1);
    hooks.addAction('actions.remove_all_all', () => {}, 10);
    hooks.addAction('actions.remove_all_all', () => {}, 20);

    const removed = hooks.removeAllActions('actions.remove_all_all');
    expect(removed).toBe(true);
    expect(hooks.hasAction('actions.remove_all_all')).toBe(0);
    await hooks.doAction('actions.remove_all_all');
  });

  it('hasAction returns true/false or count', () => {
    const firstId = hooks.addAction('actions.count', () => {}, 10);
    const secondId = hooks.addAction('actions.count', () => {}, 10);

    expect(hooks.hasAction('actions.count')).toBe(2);
    expect(hooks.hasAction('actions.count', firstId)).toBe(true);
    expect(hooks.hasAction('actions.count', 'missing')).toBe(false);

    hooks.removeAction('actions.count', firstId);

    expect(hooks.hasAction('actions.count')).toBe(1);
    expect(hooks.hasAction('actions.count', firstId)).toBe(false);
    expect(hooks.hasAction('actions.count', secondId)).toBe(true);
  });

  it('doingAction is true during execution, false outside', async () => {
    const marker: boolean[] = [];
    hooks.addAction('actions.during', async () => {
      marker.push(hooks.doingAction('actions.during'));
    });
    expect(hooks.doingAction('actions.during')).toBe(false);
    await hooks.doAction('actions.during');
    expect(marker).toEqual([true]);
    expect(hooks.doingAction('actions.during')).toBe(false);
  });

  it('didAction counts invocations', async () => {
    hooks.addAction('actions.counts', () => {});
    hooks.addAction('actions.counts', () => {});

    expect(hooks.didAction('actions.counts')).toBe(0);
    await hooks.doAction('actions.counts');
    await hooks.doAction('actions.counts', 1, 2);
    expect(hooks.didAction('actions.counts')).toBe(2);
  });

  it('action timeout logs warning and skips', async () => {
    const events: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    hooks.addAction(
      'actions.timeout',
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        events.push('should_not_happen');
      },
      10,
      { timeoutSeconds: 0.001 },
    );

    await hooks.doAction('actions.timeout');

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('do_action timeout'));
  });

  it('action exception is logged and chain continues', async () => {
    const events: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    hooks.addAction('actions.exception', async () => { throw new Error('boom'); }, 10);
    hooks.addAction('actions.exception', async () => { events.push('good'); }, 20);

    await hooks.doAction('actions.exception');

    expect(events).toEqual(['good']);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('do_action exception'),
      expect.any(Error),
    );
  });

  it.each([
    [[]],
    [[1]],
    [[1, 2]],
    [[1, 2, 3]],
    [['x', 'y', 'z']],
  ])('doAction accepts variadic args: %j', async (args: unknown[]) => {
    const received: unknown[][] = [];
    hooks.addAction('actions.varargs', async (...cbArgs) => { received.push(cbArgs); });
    await hooks.doAction('actions.varargs', ...args);
    expect(received).toEqual([args]);
  });

  it('addAction with invalid hookName throws', () => {
    expect(() => hooks.addAction('', () => {})).toThrow(TypeError);
    // @ts-expect-error testing invalid type
    expect(() => hooks.addAction(123, () => {})).toThrow(TypeError);
  });

  it('removing missing action returns false', () => {
    expect(hooks.removeAction('actions.missing', 'not-there')).toBe(false);
    expect(hooks.removeAllActions('actions.missing')).toBe(false);
  });

  it('callback removed during execution is skipped in remaining chain', async () => {
    const events: string[] = [];
    let firstId: string;

    const first = async () => {
      events.push('first');
      hooks.removeAction('actions.early', firstId);
    };
    const second = async () => { events.push('second'); };

    firstId = hooks.addAction('actions.early', first);
    hooks.addAction('actions.early', second, 20);

    await hooks.doAction('actions.early');
    expect(events).toEqual(['first', 'second']);
    expect(hooks.hasAction('actions.early')).toBe(1);
  });

  it('doingAction false when not running', () => {
    expect(hooks.doingAction('never')).toBe(false);
    hooks.addAction('never', () => {});
    expect(hooks.doingAction('never')).toBe(false);
  });
});
