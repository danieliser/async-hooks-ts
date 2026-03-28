import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncHooks } from '../src/index';

describe('re-entrancy', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = new AsyncHooks();
  });

  it('action callback can trigger nested action', async () => {
    const events: string[] = [];

    hooks.addAction('reentrance.inner', async () => { events.push('inner'); });
    hooks.addAction('reentrance.outer', async () => {
      events.push('outer-start');
      await hooks.doAction('reentrance.inner');
      events.push('outer-end');
    });

    await hooks.doAction('reentrance.outer');
    expect(events).toEqual(['outer-start', 'inner', 'outer-end']);
  });

  it('nested action levels and doingAction states', async () => {
    const events: string[] = [];
    let level = 0;

    hooks.addAction('reentrance.level_3', async () => {
      events.push(`l3:${hooks.doingAction('reentrance.level_3')}`);
    });

    hooks.addAction('reentrance.level_2', async () => {
      level += 1;
      events.push(`l2-enter:${hooks.doingAction('reentrance.level_2')}`);
      await hooks.doAction('reentrance.level_3');
      events.push(`l2-exit:${hooks.doingAction('reentrance.level_2')}`);
    });

    hooks.addAction('reentrance.level_1', async () => {
      events.push(`l1-enter:${hooks.doingAction('reentrance.level_1')}`);
      await hooks.doAction('reentrance.level_2');
      events.push(`l1-mid:${hooks.doingAction('reentrance.level_1')}`);
      events.push(`state:${level}`);
      events.push(`l1-exit:${hooks.doingAction('reentrance.level_1')}`);
    });

    await hooks.doAction('reentrance.level_1');

    expect(hooks.doingAction('reentrance.level_1')).toBe(false);
    expect(hooks.doingAction('reentrance.level_2')).toBe(false);
    expect(hooks.doingAction('reentrance.level_3')).toBe(false);

    expect(events).toEqual([
      'l1-enter:true',
      'l2-enter:true',
      'l3:true',
      'l2-exit:true',
      'l1-mid:true',
      'state:1',
      'l1-exit:true',
    ]);
  });

  it('deferred removals cleanup only on outermost return', async () => {
    const events: string[] = [];
    let callCount = 0;
    let removedId: string;

    const keep = async () => {
      callCount += 1;
      if (callCount === 1) {
        hooks.removeAction('reentrance.nested_same', removedId);
        events.push(`during:${hooks.hasAction('reentrance.nested_same')}`);
        await hooks.doAction('reentrance.nested_same', 1);
        events.push(`after_nested:${hooks.hasAction('reentrance.nested_same')}`);
      } else {
        events.push(`nested:${hooks.hasAction('reentrance.nested_same')}`);
      }
    };

    const removed = async () => { events.push('removed-ran'); };

    removedId = hooks.addAction('reentrance.nested_same', removed, 20);
    hooks.addAction('reentrance.nested_same', keep, 10);

    await hooks.doAction('reentrance.nested_same');

    expect(events).toEqual(['during:2', 'nested:2', 'after_nested:2']);
    expect(hooks.hasAction('reentrance.nested_same')).toBe(1);
  });

  it('deferred removal cleanup after nested levels', async () => {
    const events: string[] = [];
    const ids: string[] = [];

    const a = async () => {
      events.push('a1');
      if (events.filter(e => e === 'a1').length === 1) {
        hooks.removeAction('reentrance.outer', ids[1]);
        await hooks.doAction('reentrance.inner');
      }
      events.push('a2');
    };

    const b = async () => { events.push('b'); };
    const c = async () => { events.push('c'); };

    const bId = hooks.addAction('reentrance.outer', b, 20);
    const cId = hooks.addAction('reentrance.outer', c, 30);
    ids.push(bId, cId);
    hooks.addAction('reentrance.outer', a, 10);
    hooks.addAction('reentrance.inner', c);

    await hooks.doAction('reentrance.outer');

    expect(events).toEqual(['a1', 'c', 'a2', 'b']);
    expect(hooks.hasAction('reentrance.outer')).toBe(2);
    expect(hooks.hasAction('reentrance.inner')).toBe(1);
  });

  it('multiple levels of nesting for actions', async () => {
    const events: string[] = [];

    hooks.addAction('reentrance.level0', async () => {
      events.push('l0');
      await hooks.doAction('reentrance.n0');
    });
    hooks.addAction('reentrance.n0', async () => {
      events.push('l1');
      await hooks.doAction('reentrance.n1');
    });
    hooks.addAction('reentrance.n1', async () => {
      events.push('l2');
      await hooks.doAction('reentrance.n2');
    });
    hooks.addAction('reentrance.n2', async () => { events.push('l3'); });

    await hooks.doAction('reentrance.level0');
    expect(events).toEqual(['l0', 'l1', 'l2', 'l3']);
  });

  it.each(['a', 'b', 'c', 'd', 'e'])(
    'no deadlock with multiple fires on hook %s',
    async (hookName) => {
      const events: string[] = [];

      hooks.removeAction('reentrance.chain', 'never');

      hooks.addAction(`reentrance.${hookName}`, () => { events.push(hookName); });
      await hooks.doAction(`reentrance.${hookName}`);
      await hooks.doAction(`reentrance.${hookName}`);

      hooks.addAction('reentrance.chain', async () => {
        events.push('a');
        await hooks.doAction('reentrance.chain2');
      });
      hooks.addAction('reentrance.chain', async () => { events.push('b'); });
      hooks.addAction('reentrance.chain2', async () => { events.push('c2'); });

      await hooks.doAction('reentrance.chain');
      expect(events).toContain('a');
      expect(events).toContain('b');
    },
  );

  it('callback runs even when parent scope is not current', async () => {
    const events: string[] = [];

    hooks.addAction('reentrance.parent', async () => {
      events.push('parent-before');
      await hooks.doAction('reentrance.child');
      events.push('parent-after');
    });
    hooks.addAction('reentrance.child', async () => { events.push('child'); });

    await hooks.doAction('reentrance.parent');
    expect(events).toEqual(['parent-before', 'child', 'parent-after']);
  });
});
