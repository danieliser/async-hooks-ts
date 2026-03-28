# async-hooks-ts

WordPress-style async actions and filters for TypeScript. Priority-ordered callbacks, deferred removal, scoped context, global wildcard subscriptions, and typed payload validation.

## Install

```bash
npm install async-hooks-ts
```

## Quick Start

```typescript
import { AsyncHooks } from 'async-hooks-ts';

const hooks = new AsyncHooks();

// Listen for an event
hooks.on('task.created', async (task) => {
  await notify(task);
});

// Fire the event
await hooks.doAction('task.created', { id: 'task-1', name: 'Deploy' });

// Transform a value
hooks.intercept('task.title', (title: string) => title.trim().toUpperCase());

const title = await hooks.applyFilters('task.title', '  deploy prod  ');
// → 'DEPLOY PROD'
```

---

## API Reference

### Actions — fire-and-forget events

```typescript
// Register
const id = hooks.addAction('hook.name', callback, priority?, options?)
const id = hooks.on('hook.name', callback, priority?, options?)

// Fire
await hooks.doAction('hook.name', ...args)

// Remove
hooks.removeAction('hook.name', id)
hooks.removeAllActions('hook.name', priority?)
hooks.off('hook.name', id)

// Inspect
hooks.hasAction('hook.name')          // count
hooks.hasAction('hook.name', id)      // boolean
hooks.doingAction('hook.name')        // currently executing?
hooks.didAction('hook.name')          // total invocation count
```

### Filters — transform a value through a pipeline

```typescript
// Register
const id = hooks.addFilter('hook.name', callback, priority?, options?)
const id = hooks.intercept('hook.name', callback, priority?, options?)

// Apply
const result = await hooks.applyFilters('hook.name', value, ...extraArgs)

// Remove
hooks.removeFilter('hook.name', id)
hooks.removeAllFilters('hook.name', priority?)
hooks.off('hook.name', id)

// Inspect
hooks.hasFilter('hook.name')
hooks.doingFilter('hook.name')
hooks.didFilter('hook.name')
```

### Options

```typescript
// Action options
hooks.addAction('evt', cb, 10, {
  timeoutSeconds: 5,   // per-callback timeout (overrides instance default)
  detach: true,        // fire-and-forget — doAction doesn't await it
});

// Filter options
hooks.addFilter('evt', cb, 10, {
  acceptedArgs: 2,     // how many args the callback accepts (including value)
  timeoutSeconds: 5,
});

// Instance defaults
const hooks = new AsyncHooks({
  actionTimeoutSeconds: 30,   // default 30s per action listener
  filterTimeoutSeconds: null, // default no timeout for filters
  validatePayloads: false,    // typed payload validation off by default
});
```

---

## Common Patterns

### Filtering Values

The most direct use: run a value through a pipeline of transforms. Each
callback receives the output of the previous one. If a callback throws or
times out, the current value passes through unchanged.

```typescript
// Markdown → HTML pipeline
hooks.addFilter('content.render', (content: string) => {
  return content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}, 10);

hooks.addFilter('content.render', async (content: string) => {
  return await sanitizeHtml(content); // async is fine
}, 20);

hooks.addFilter('content.render', (content: string) => {
  return `<div class="prose">${content}</div>`;
}, 30);

const html = await hooks.applyFilters('content.render', markdownSource);
```

Extra positional args pass context that any filter can opt into via `acceptedArgs`:

```typescript
hooks.addFilter('content.render', (content, context) => {
  return context.darkMode ? wrapDark(content) : content;
}, 50, { acceptedArgs: 2 }); // opts into the second arg

const html = await hooks.applyFilters('content.render', source, { darkMode: true });
```

---

### Service Registration Pattern

Use actions and filters as a lightweight inversion-of-control container.
Services register themselves at startup; the host discovers them without
hard-coding imports.

```typescript
// ── registry.ts ──────────────────────────────────────────────────────
const hooks = new AsyncHooks();
export { hooks };

// Collect registered services
export async function getServices(): Promise<Service[]> {
  return await hooks.applyFilters('services.register', []) as Service[];
}

// ── email-service.ts ─────────────────────────────────────────────────
import { hooks } from './registry';

hooks.addFilter('services.register', (services: Service[]) => {
  return [...services, new EmailService()];
});

// ── sms-service.ts ───────────────────────────────────────────────────
import { hooks } from './registry';

hooks.addFilter('services.register', (services: Service[]) => {
  return [...services, new SmsService()];
}, 20);

// ── main.ts ──────────────────────────────────────────────────────────
import './email-service';
import './sms-service';
import { getServices } from './registry';

const services = await getServices();
// → [EmailService, SmsService]
```

The same pattern works for capability or plugin registration:

```typescript
// Collect all registered agent types
hooks.addFilter('agent.types', (types: Record<string, AgentFactory>) => ({
  ...types,
  'code-reviewer': (opts) => new CodeReviewerAgent(opts),
}));

hooks.addFilter('agent.types', (types) => ({
  ...types,
  'test-runner': (opts) => new TestRunnerAgent(opts),
}));

const agentTypes = await hooks.applyFilters('agent.types', {});
// agentTypes['code-reviewer'](options) → new agent
```

---

### System Lifecycle Actions

Fire hooks at well-known points in your application lifecycle. Any module
can subscribe without the host knowing about it.

```typescript
// ── app.ts ───────────────────────────────────────────────────────────
const hooks = new AsyncHooks();

async function boot() {
  await hooks.doAction('app.init');

  const config = await hooks.applyFilters('app.config', defaultConfig);

  await hooks.doAction('app.ready', config);
}

async function shutdown() {
  await hooks.doAction('app.shutdown');
}

// ── database-module.ts ───────────────────────────────────────────────
hooks.on('app.init', async () => {
  await db.connect();
  console.log('DB connected');
});

hooks.on('app.shutdown', async () => {
  await db.disconnect();
});

// ── feature-flags.ts ─────────────────────────────────────────────────
hooks.intercept('app.config', (config) => ({
  ...config,
  features: loadFeatureFlags(),
}));

// ── metrics.ts ───────────────────────────────────────────────────────
hooks.on('app.ready', async (config) => {
  await metrics.init({ env: config.env });
});
```

---

### Agent / Worker Registration (PERSIST-style)

Register agents at module load time; dispatch them by name via an action.
The orchestrator fires `agent.dispatch` and the matching handler picks it up.

```typescript
const hooks = new AsyncHooks();

// Each agent module self-registers
hooks.on('agent.register', async () => {
  hooks.on('agent.run.code-reviewer', async (task) => {
    const result = await runCodeReview(task);
    await hooks.doAction('agent.result', { taskId: task.id, result });
  });
});

hooks.on('agent.register', async () => {
  hooks.on('agent.run.test-runner', async (task) => {
    const result = await runTests(task);
    await hooks.doAction('agent.result', { taskId: task.id, result });
  });
});

// Bootstrap: fire registration
await hooks.doAction('agent.register');

// Dispatch any agent by name
async function dispatch(agentType: string, task: Task) {
  await hooks.doAction(`agent.run.${agentType}`, task);
}

// Collect results globally
hooks.subscribeAll(async (event, payload) => {
  if (event === 'agent.result') {
    await store.save(payload);
  }
}, 90);
```

---

### Detached (Fire-and-Forget) Actions

Register a callback with `detach: true` and `doAction` will not await it.
Use for long-running side effects that must not block the calling code.

```typescript
hooks.on('task.created', async (task) => {
  // Heavy async work — runs in background, doAction returns immediately
  await indexTaskForSearch(task);
  await sendWebhooks(task);
}, 10, { detach: true });

// Returns immediately; the detached listener runs concurrently
await hooks.doAction('task.created', newTask);
console.log('task created — search indexing running in background');
```

---

### Namespace-Scoped Global Monitoring

`subscribeAll` with a namespace prefix lets you observe an entire subsystem
without registering on each individual hook.

```typescript
// Audit log for every task.* event
hooks.subscribeAll(async (eventName, ...args) => {
  await auditLog.write({ event: eventName, args, ts: Date.now() });
}, 90, 'task');

// Metrics for every agent.* event
hooks.subscribeAll(async (eventName) => {
  metrics.increment(`hooks.${eventName}`);
}, 90, 'agent');

// Now any doAction('task.created', ...) or doAction('task.completed', ...)
// automatically flows through the audit log.
```

---

### Execution Scopes

Scopes give callbacks implicit access to the current execution context
(request ID, job ID, etc.) without threading it through every argument.

```typescript
hooks.on('email.send', async (email) => {
  const scope = hooks.currentScope;
  const requestId = scope?.get('requestId') ?? 'unknown';

  logger.info(`[${requestId}] Sending email to ${email.to}`);
  await sendEmail(email);
});

// Wrap a request handler
async function handleRequest(req: Request) {
  await hooks.scope('http-request', { requestId: req.id, userId: req.user.id }).run(async () => {
    await hooks.doAction('request.before', req);
    const response = await processRequest(req);
    await hooks.doAction('request.after', req, response);
    return response;
  });
}
```

Nested scopes work; the inner scope exposes its parent:

```typescript
await hooks.scope('job', { jobId: 'j-1' }).run(async () => {
  await hooks.scope('task', { taskId: 't-1' }).run(async (scope) => {
    console.log(scope.parent?.get('jobId')); // 'j-1'
  });
});
```

Scopes are async-context-local — parallel Promise chains each see only their own scope:

```typescript
await Promise.all([
  hooks.scope('batch-a').run(async () => {
    await hooks.doAction('batch.process', itemsA); // sees scope 'batch-a'
  }),
  hooks.scope('batch-b').run(async () => {
    await hooks.doAction('batch.process', itemsB); // sees scope 'batch-b'
  }),
]);
```

---

### One-Shot Callbacks (Self-Removing)

A callback can remove itself during execution — the removal is deferred
until the hook finishes, so the rest of the chain is unaffected.

```typescript
let initId: string;

initId = hooks.on('app.init', async () => {
  await runOnce();
  hooks.removeAction('app.init', initId); // only fires once
});
```

---

### Priority Reference

Lower number = higher priority. Default is `10`.

| Priority | Typical use |
|---|---|
| `1` | Bootstrap / must-run-first |
| `5` | Early middleware |
| `10` | Default |
| `20–50` | Domain logic |
| `90` | Cleanup / audit / logging |
| `99` | Last resort |

Two callbacks at the same priority execute in registration order.

---

### Introspection

```typescript
// What hooks are registered?
hooks.registeredEvents();             // Set<string>
hooks.registeredEvents('task');       // only 'task.*' hooks

// Who's listening on a hook?
hooks.describe('task.created');       // HandlerInfo[]
hooks.describeAll();                  // all hooks, sorted by name
hooks.describeAll('task');            // namespaced

// Tear down a whole subsystem
hooks.removeNamespace('task');        // removes all task.* hooks
```

---

## TypeScript Notes

All callbacks accept `...args: any[]`. For stricter typing on individual
hooks, cast inside the callback:

```typescript
hooks.on('task.created', async (...args) => {
  const task = args[0] as Task;
  // ...
});
```

For payload validation at runtime, use `registerSchema` with any object that
has a `validate(value: unknown): unknown` method (Zod, Valibot, etc.):

```typescript
import { z } from 'zod';

const TaskSchema = z.object({ id: z.string(), name: z.string() });

hooks.registerSchema('task.created', {
  validate: (v) => TaskSchema.parse(v),
});

hooks.validatePayloads = true;
// Now doAction('task.created', badPayload) throws HookPayloadError
```
