import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncHooks } from '../src/index';

describe('dynamic removal', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = new AsyncHooks();
  });

  it('callback unhooks itself during execution', async () => {
    const events: string[] = [];
    let selfId: string;

    const selfRemoving = async () => {
      events.push('self');
      hooks.removeAction('dynamic.self', selfId);
    };

    selfId = hooks.addAction('dynamic.self', selfRemoving);
    hooks.addAction('dynamic.self', () => { events.push('other'); }, 20);

    await hooks.doAction('dynamic.self');
    await hooks.doAction('dynamic.self');

    expect(events).toEqual(['self', 'other', 'other']);
    expect(hooks.hasAction('dynamic.self')).toBe(1);
  });

  it('callback unhooks another callback during execution', async () => {
    const events: string[] = [];
    let otherId: string;

    const remover = async () => {
      events.push('remover');
      hooks.removeAction('dynamic.other', otherId);
    };
    const other = async () => { events.push('other'); };
    const third = async () => { events.push('third'); };

    otherId = hooks.addAction('dynamic.other', other, 20);
    hooks.addAction('dynamic.other', remover, 10);
    hooks.addAction('dynamic.other', third, 30);

    await hooks.doAction('dynamic.other');
    expect(events).toEqual(['remover', 'third']);
    expect(hooks.hasAction('dynamic.other', otherId)).toBe(false);
  });

  it('callback unhooks another callback by priority', async () => {
    const events: string[] = [];
    let removeeId: string;

    const remover = async () => {
      events.push('remover');
      hooks.removeAction('dynamic.by_priority', removeeId);
    };
    const removee = async () => { events.push('removee'); };
    const keep = async () => { events.push('keep'); };

    removeeId = hooks.addAction('dynamic.by_priority', removee, 20);
    hooks.addAction('dynamic.by_priority', remover, 5);
    hooks.addAction('dynamic.by_priority', keep, 10);

    await hooks.doAction('dynamic.by_priority');
    expect(events).toEqual(['remover', 'keep']);
    expect(hooks.hasAction('dynamic.by_priority')).toBe(2);
  });

  it('adding callback during execution does not run in same cycle', async () => {
    const events: string[] = [];

    hooks.addAction('dynamic.add', async () => {
      events.push('adder');
      hooks.addAction('dynamic.add', () => { events.push('late'); }, 10);
    }, 10);

    await hooks.doAction('dynamic.add');
    expect(events).toEqual(['adder']);
    expect(hooks.hasAction('dynamic.add')).toBe(2);

    await hooks.doAction('dynamic.add');
    expect(events).toEqual(['adder', 'adder', 'late']);
  });

  it('filter can unhook itself during execution', async () => {
    const events: string[] = [];
    let selfId: string;

    const selfFilter = (value: string) => {
      events.push('self');
      hooks.removeFilter('dynamic.filter_self', selfId);
      return `${value}-self`;
    };

    selfId = hooks.addFilter('dynamic.filter_self', selfFilter);
    hooks.addFilter('dynamic.filter_self', (v: string) => {
      events.push('other');
      return `${v}-other`;
    });

    const result1 = await hooks.applyFilters('dynamic.filter_self', 'v');
    expect(result1).toBe('v-self-other');
    expect(events).toEqual(['self', 'other']);

    const result2 = await hooks.applyFilters('dynamic.filter_self', 'x');
    expect(result2).toBe('x-other');
    expect(events).toEqual(['self', 'other', 'other']);
  });

  it('filter can unhook another filter during execution', async () => {
    const events: string[] = [];
    let removeeId: string;

    const removee = (value: string) => { events.push('removee'); return `${value}-removee`; };
    const remover = (value: string) => {
      hooks.removeFilter('dynamic.filter_other', removeeId);
      events.push('remover');
      return `${value}-remover`;
    };
    const late = (value: string) => { events.push('late'); return `${value}-late`; };

    removeeId = hooks.addFilter('dynamic.filter_other', removee, 20);
    hooks.addFilter('dynamic.filter_other', remover, 10);
    hooks.addFilter('dynamic.filter_other', late, 30);

    const result = await hooks.applyFilters('dynamic.filter_other', 'seed');
    expect(result).toBe('seed-remover-late');
    expect(events).toEqual(['remover', 'late']);
    expect(hooks.hasFilter('dynamic.filter_other', removeeId)).toBe(false);
  });

  it('add filter during execution does not run in same chain', async () => {
    const events: string[] = [];

    const first = (value: string) => {
      events.push('first');
      hooks.addFilter('dynamic.filter_add', (v: string) => {
        events.push('second');
        return `${v}-second`;
      });
      return `${value}-first`;
    };

    hooks.addFilter('dynamic.filter_add', first);
    const result1 = await hooks.applyFilters('dynamic.filter_add', 'seed');
    expect(result1).toBe('seed-first');
    expect(events).toEqual(['first']);

    const result2 = await hooks.applyFilters('dynamic.filter_add', 'seed');
    expect(result2).toBe('seed-first-second');
  });

  it('removeAllActions during execution removes all after cleanup', async () => {
    const events: string[] = [];

    hooks.addAction('dynamic.remove_all_nested', async () => {
      events.push('first');
      hooks.removeAllActions('dynamic.remove_all_nested');
    }, 5);
    hooks.addAction('dynamic.remove_all_nested', async () => {
      events.push('second');
    }, 10);

    await hooks.doAction('dynamic.remove_all_nested');
    expect(events).toEqual(['first']);
    expect(hooks.hasAction('dynamic.remove_all_nested')).toBe(0);
  });

  it('removeAllFilters during execution removes all after cleanup', async () => {
    const events: string[] = [];

    hooks.addFilter('dynamic.remove_all_filters_nested', (value: string) => {
      events.push('first');
      hooks.removeAllFilters('dynamic.remove_all_filters_nested');
      return `${value}-first`;
    }, 5);
    hooks.addFilter('dynamic.remove_all_filters_nested', (value: string) => {
      events.push('second');
      return `${value}-second`;
    }, 10);

    const result = await hooks.applyFilters('dynamic.remove_all_filters_nested', 'seed');
    expect(result).toBe('seed-first');
    expect(events).toEqual(['first']);
    expect(hooks.hasFilter('dynamic.remove_all_filters_nested')).toBe(0);
  });

  it('dynamic add and remove in multiple calls', async () => {
    const marker: string[] = [];

    hooks.addAction('dynamic.multi', async () => {
      marker.push('adder');
      const cbId = hooks.addAction('dynamic.multi', () => { marker.push('dynamic'); }, 5);
      hooks.removeAction('dynamic.multi', cbId);
    });

    await hooks.doAction('dynamic.multi');
    await hooks.doAction('dynamic.multi');

    expect(marker).toEqual(['adder', 'adder']);
    expect(hooks.hasAction('dynamic.multi')).toBe(1);
  });

  it('deferred filter removal from nested filter call', async () => {
    const events: string[] = [];
    let targetId: string;

    const first = (value: string, depth = 0) => {
      events.push(`first-${depth}`);
      if (depth < 1) {
        hooks.removeFilter('dynamic.filter_nest', targetId);
      }
      return value;
    };

    const target = (value: string) => {
      events.push('target');
      return `${value}-target`;
    };

    const second = async (value: string, depth = 0): Promise<string> => {
      events.push(`second-${depth}`);
      if (depth >= 1) return `${value}-second`;
      return await hooks.applyFilters('dynamic.filter_nest', `${value}-inner`, depth + 1) as string;
    };

    targetId = hooks.addFilter('dynamic.filter_nest', target, 5);
    hooks.addFilter('dynamic.filter_nest', first, 10, { acceptedArgs: 2 });
    hooks.addFilter('dynamic.filter_nest', second, 20, { acceptedArgs: 2 });

    const result = await hooks.applyFilters('dynamic.filter_nest', 'seed', 0);
    expect(result).toBe('seed-target-inner-second');
    expect(events).toEqual(['target', 'first-0', 'second-0', 'first-1', 'second-1']);
    expect(hooks.hasFilter('dynamic.filter_nest', targetId)).toBe(false);
  });
});
