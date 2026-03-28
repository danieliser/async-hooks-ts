import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncHooks, HookPayloadError } from '../src/index';

// Simple schema that validates objects have a required 'taskId' string field.
const TaskSchema = {
  validate(value: unknown) {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Expected an object');
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj['taskId'] !== 'string') {
      throw new Error('taskId must be a string');
    }
    if (obj['priority'] !== undefined && typeof obj['priority'] !== 'number') {
      throw new Error('priority must be a number');
    }
  },
};

const OtherSchema = {
  validate(value: unknown) {
    if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>)['name'] !== 'string') {
      throw new Error('name must be a string');
    }
  },
};

function makeHooks(validate = true) {
  return new AsyncHooks({ validatePayloads: validate });
}

describe('typed payload validation', () => {
  // ─ registerSchema / schemaFor ──────────────────────────────────────────────

  it('registerSchema stores and schemaFor retrieves the schema', () => {
    const hooks = makeHooks();
    hooks.registerSchema('task.created', TaskSchema);
    expect(hooks.schemaFor('task.created')).toBe(TaskSchema);
  });

  it('schemaFor returns undefined for unknown hook', () => {
    const hooks = makeHooks();
    expect(hooks.schemaFor('no.such.hook')).toBeUndefined();
  });

  it('registerSchema throws on empty hookName', () => {
    const hooks = makeHooks();
    expect(() => hooks.registerSchema('', TaskSchema)).toThrow(TypeError);
  });

  // ─ validatePayloads property ──────────────────────────────────────────────

  it('validatePayloads defaults to false', () => {
    const hooks = new AsyncHooks();
    expect(hooks.validatePayloads).toBe(false);
  });

  it('validatePayloads true via constructor', () => {
    const hooks = new AsyncHooks({ validatePayloads: true });
    expect(hooks.validatePayloads).toBe(true);
  });

  it('validatePayloads is settable at runtime', () => {
    const hooks = new AsyncHooks();
    hooks.validatePayloads = true;
    expect(hooks.validatePayloads).toBe(true);
    hooks.validatePayloads = false;
    expect(hooks.validatePayloads).toBe(false);
  });

  // ─ doAction validation ────────────────────────────────────────────────────

  it('doAction valid payload passes', async () => {
    const hooks = makeHooks(true);
    hooks.registerSchema('task.created', TaskSchema);
    const fired: boolean[] = [];
    hooks.addAction('task.created', () => { fired.push(true); });
    await hooks.doAction('task.created', { taskId: 't1', priority: 5 });
    expect(fired).toEqual([true]);
  });

  it('doAction invalid payload raises HookPayloadError', async () => {
    const hooks = makeHooks(true);
    hooks.registerSchema('task.created', TaskSchema);
    hooks.addAction('task.created', () => {}); // listener required to trigger validation

    await expect(
      hooks.doAction('task.created', { priority: 'not-a-number' }),
    ).rejects.toThrow(HookPayloadError);
  });

  it('HookPayloadError has expected fields', async () => {
    const hooks = makeHooks(true);
    hooks.registerSchema('task.created', TaskSchema);
    hooks.addAction('task.created', () => {}); // listener required to trigger validation

    try {
      await hooks.doAction('task.created', { bad: 'data' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HookPayloadError);
      const e = err as HookPayloadError;
      expect(e.hookName).toBe('task.created');
      expect(e.schema).toBe(TaskSchema);
      expect(Array.isArray(e.errors)).toBe(true);
      expect(e.errors.length).toBeGreaterThan(0);
      expect(String(e)).toContain('task.created');
    }
  });

  it('doAction with no schema: any payload passes', async () => {
    const hooks = makeHooks(true);
    const fired: boolean[] = [];
    hooks.addAction('evt.untyped', () => { fired.push(true); });
    await hooks.doAction('evt.untyped', { garbage: true });
    expect(fired).toEqual([true]);
  });

  it('doAction with validatePayloads=false skips validation', async () => {
    const hooks = makeHooks(false);
    hooks.registerSchema('task.created', TaskSchema);
    const fired: boolean[] = [];
    hooks.addAction('task.created', () => { fired.push(true); });
    await hooks.doAction('task.created', { wrong_field: 'value' });
    expect(fired).toEqual([true]);
  });

  it('doAction validation toggleable at runtime', async () => {
    const hooks = new AsyncHooks();
    hooks.registerSchema('task.created', TaskSchema);
    const invalid = { wrong: 'data' };

    hooks.addAction('task.created', () => {});
    // Off by default — no error
    await hooks.doAction('task.created', invalid);

    // Enable at runtime
    hooks.validatePayloads = true;
    await expect(hooks.doAction('task.created', invalid)).rejects.toThrow(HookPayloadError);
  });

  // ─ applyFilters validation ────────────────────────────────────────────────

  it('applyFilters valid value passes', async () => {
    const hooks = makeHooks(true);
    hooks.registerSchema('task.payload', TaskSchema);
    const payload = { taskId: 't1' };
    const result = await hooks.applyFilters('task.payload', payload);
    expect(result).toBe(payload);
  });

  it('applyFilters invalid value raises HookPayloadError', async () => {
    const hooks = makeHooks(true);
    hooks.registerSchema('task.payload', TaskSchema);
    hooks.addFilter('task.payload', (v) => v); // listener required to trigger validation
    await expect(
      hooks.applyFilters('task.payload', { missing_task_id: true }),
    ).rejects.toThrow(HookPayloadError);
  });

  it('applyFilters with validatePayloads=false skips validation', async () => {
    const hooks = makeHooks(false);
    hooks.registerSchema('task.payload', TaskSchema);
    hooks.addFilter('task.payload', (v) => v);
    const result = await hooks.applyFilters('task.payload', { garbage: 1 });
    expect(result).toEqual({ garbage: 1 });
  });

  it('applyFilters HookPayloadError has correct hookName', async () => {
    const hooks = makeHooks(true);
    hooks.registerSchema('task.payload', TaskSchema);
    hooks.addFilter('task.payload', (v) => v); // listener required to trigger validation
    try {
      await hooks.applyFilters('task.payload', { missing: true });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HookPayloadError);
      expect((err as HookPayloadError).hookName).toBe('task.payload');
    }
  });
});
