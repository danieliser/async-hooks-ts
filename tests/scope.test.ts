import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncHooks } from '../src/index';

describe('scope', () => {
  let hooks: AsyncHooks;

  beforeEach(() => {
    hooks = new AsyncHooks();
  });

  it('scope.run() makes scope accessible via currentScope', async () => {
    await hooks.scope('batch', { task_id: 'abc' }).run(async (scope) => {
      expect(scope.name).toBe('batch');
      expect(hooks.currentScope).toBe(scope);
    });
    expect(hooks.currentScope).toBeUndefined();
  });

  it('currentScope is accessible inside action callbacks', async () => {
    const called: boolean[] = [];

    hooks.addAction('scope.current', async () => {
      called.push(hooks.currentScope !== undefined);
    });

    await hooks.scope('callback', { job: 'job-1' }).run(async () => {
      await hooks.doAction('scope.current');
    });

    expect(called).toEqual([true]);
  });

  it('scope records action and filter counts', async () => {
    hooks.addAction('scope.counting', async () => {});
    hooks.addFilter('scope.counting', (v: string) => `${v}-filtered`);

    let didActionCount = 0;
    let didFilterCount = 0;

    await hooks.scope('count').run(async (scope) => {
      await hooks.doAction('scope.counting');
      await hooks.applyFilters('scope.counting', 'value');
      didActionCount = scope.didAction('scope.counting');
      didFilterCount = scope.didFilter('scope.counting');
    });

    expect(didActionCount).toBe(1);
    expect(didFilterCount).toBe(1);
    expect(hooks.currentScope).toBeUndefined();
  });

  it('scope.didAction and didFilter track events from callbacks', async () => {
    const scopeCaptured: unknown[] = [];

    hooks.addAction('scope.metrics', async () => {});
    hooks.addAction('scope.metrics', async () => {
      const scope = hooks.currentScope;
      if (scope) {
        scopeCaptured.push(scope.didAction('scope.metrics'));
        scopeCaptured.push(scope.didFilter('scope.metrics'));
      }
    }, 20);
    hooks.addFilter('scope.metrics', (v) => v);

    await hooks.scope('metrics').run(async () => {
      await hooks.doAction('scope.metrics');
      await hooks.applyFilters('scope.metrics', 'v');
    });

    expect(scopeCaptured).toEqual([1, 0]);
  });

  it('scope metadata is accessible via scope.get() and scope.metadata', async () => {
    const metadataValues: string[] = [];

    hooks.addAction('scope.metadata', async () => {
      const scope = hooks.currentScope;
      if (scope) {
        metadataValues.push(String(scope.get('task_id')));
        metadataValues.push(String(scope.get('job')));
      }
    });

    await hooks.scope('meta', { task_id: 'task-42', job: 'render' }).run(async () => {
      await hooks.doAction('scope.metadata');
    });

    expect(metadataValues).toEqual(['task-42', 'render']);
  });

  it('scope.metadata exposes the metadata map directly', async () => {
    await hooks.scope('mapping', { job_id: 'j-1' }).run(async (scope) => {
      expect(scope.metadata['job_id']).toBe('j-1');
      expect(scope.metadata['missing']).toBeUndefined();
    });
  });

  it('nested scopes: parent is set correctly', async () => {
    const captures: string[] = [];

    hooks.addAction('scope.inner', async () => {
      const scope = hooks.currentScope;
      if (scope && scope.parent) {
        captures.push(scope.parent.name);
        captures.push(String(scope.parent.get('request_id')));
      }
    });

    await hooks.scope('outer', { request_id: 'r1' }).run(async () => {
      await hooks.scope('inner', { request_id: 'r2' }).run(async () => {
        await hooks.doAction('scope.inner');
      });
    });

    expect(captures).toEqual(['outer', 'r1']);
  });

  it('scope.parent tracks nesting', async () => {
    const parents: string[] = [];

    hooks.addAction('scope.parent', async () => {
      const scope = hooks.currentScope;
      if (scope?.parent) parents.push(scope.parent.name);
    });

    await hooks.scope('parent').run(async () => {
      await hooks.scope('child').run(async () => {
        await hooks.doAction('scope.parent');
      });
    });

    expect(parents).toEqual(['parent']);
  });

  it('currentScope is task-local (concurrent runs do not share scope)', async () => {
    async function runOne() {
      return hooks.scope('one', { marker: 'A' }).run(async (_scope) => {
        await new Promise((r) => setTimeout(r, 0));
        const curr = hooks.currentScope;
        return String(curr?.get('task_id') ?? 'missing');
      });
    }

    async function runTwo() {
      return hooks.scope('two', { marker: 'B' }).run(async (_scope) => {
        await new Promise((r) => setTimeout(r, 0));
        const curr = hooks.currentScope;
        return String(curr?.get('task_id') ?? 'missing');
      });
    }

    const [r1, r2] = await Promise.all([runOne(), runTwo()]);
    expect(r1).toBe('missing');
    expect(r2).toBe('missing');
  });

  it('scope cleanup on exit after nested calls', async () => {
    const events: string[] = [];

    hooks.addAction('scope.cleanup-action', async () => {
      const scope = hooks.currentScope;
      events.push(scope?.name ?? 'missing');
      await hooks.applyFilters('scope.cleanup-filter', 'x');
    });

    await hooks.scope('outer', { task_id: 'cleanup' }).run(async () => {
      await hooks.doAction('scope.cleanup-action');
    });

    expect(events).toEqual(['outer']);
    expect(hooks.currentScope).toBeUndefined();
  });

  it('currentScope is accessible after nested scopes complete', async () => {
    const order: string[] = [];

    hooks.addAction('scope.nested', async () => {
      order.push('inner-enter');
      await Promise.resolve();
      order.push('inner-exit');
    });

    await hooks.scope('outer', { task_id: '123' }).run(async () => {
      await hooks.doAction('scope.nested');
      order.push('inside');
    });

    order.push('outside');
    expect(order).toEqual(['inner-enter', 'inner-exit', 'inside', 'outside']);
    expect(hooks.currentScope).toBeUndefined();
  });
});
