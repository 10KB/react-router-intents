# react-router-intents

Typed action intents for React Router, with configurable defaults and access to the native router APIs.

Define a route's actions once. Get typed submission callbacks, discriminated results, and pending state while React Router continues to own navigation, redirects, cancellation, and loader revalidation.

- Built for React Router **Data Mode**, including client-only SPAs.
- Infers submission bodies and results from your handlers.
- Supports navigation and fetcher submissions, including shared or independent fetcher keys.
- Passes through native submit options, promises, `Response`, and `data()` results.
- Provides JSON and FormData transport, custom transports, and native action fallbacks.
- Keeps notifications, translation, logging, and error policy in your application.

## Installation

```sh
npm install react-router-intents react react-dom react-router@7
```

Requirements: React 19, React Router 7.18.3 or newer within v7, and a data router such as `createBrowserRouter`. This is an ESM package with TypeScript declarations. Development and CI use Node 22.12+, with a Node 22/24/26 matrix.

No router framework plugin, server rendering, or additional provider is required. Import everything from `react-router-intents`; internal modules are not public entrypoints.

## Quick start

```tsx
import { createActions } from 'react-router-intents';
import { updateProject, archiveProject } from './api.js';
import { ProjectEditor } from './project-editor.js';

type ProjectValues = { name: string };

const actions = createActions<{ projectId: string }>()({
  update: {
    handler: (params, values: ProjectValues, request) =>
      updateProject(params.projectId, values, { signal: request.signal }),
    redirect: '/projects',
  },
  archive: {
    handler: (params) => archiveProject(params.projectId),
    redirect: '/projects',
  },
});

export const action = actions.action;

export function Component() {
  const { submit, isSubmitting } = actions.useActions();

  return (
    <ProjectEditor
      onSave={submit.update}
      onArchive={submit.archive}
      saving={isSubmitting('update')}
      archiving={isSubmitting('archive')}
    />
  );
}
```

Attach `action` and `Component` to a normal data-router route:

```tsx
import { createBrowserRouter, RouterProvider } from 'react-router';
import { action, Component } from './project-route.js';

const router = createBrowserRouter([
  { path: '/projects/:projectId', action, Component },
  // Add your project list route here.
]);

export function App() {
  return <RouterProvider router={router} />;
}
```

A handler may be synchronous or asynchronous. Its arguments are `(params, body, request, args)`, where `args` is the original `ActionFunctionArgs`, including router context. The request body remains readable because decoding uses a clone. Parameter type declarations describe your route; validate parameters and input at your application boundary.

A redirect can also be a callback `(params, result, request) => string | undefined`. Annotate the result argument when using its properties; the library checks that it is compatible with the handler's result. Returning `undefined` keeps the action result.

## Configure application defaults

Use `createActionFactory` once to configure your application's policy:

```ts
import { createActionFactory } from 'react-router-intents';
import { ValidationError, translateIssues, showToast } from './application.js';

export const createActions = createActionFactory<string[]>({
  submit: { method: 'POST', encType: 'application/json' },
  mapError: (error, { intent, request }) => {
    if (!(error instanceof ValidationError)) return undefined;
    return translateIssues(error.issues);
  },
  notify: (message, variant) => showToast(message, { variant }),
});
```

Route definitions can then declare notifications:

```ts
const actions = createActions()({
  save: {
    handler: saveSettings,
    notification: {
      success: () => translate('settings.saved'),
      error: () => translate('settings.saveFailed'),
    },
  },
});
```

Messages can be strings or functions evaluated when the action completes. Without a `notify` callback, notification declarations have no side effects.

| Default | Behavior |
| --- | --- |
| `submit` | Native `SubmitOptions`; built-in defaults are POST and JSON. |
| `transport` | An `ActionTransport`; defaults to `defaultActionTransport`. |
| `mapError(error, context)` | Return your application's error value, or `undefined` to rethrow. Context contains the native action arguments and `intent`. |
| `notify(message, variant)` | Receives a resolved message and `'success'` or `'error'`. |
| `invalidRequest(code, args)` | Return the value to throw for an invalid transport request. Defaults to an empty 400 `Response`. |

Policy callbacks are synchronous. The core has no notification library, logger, or user-facing error copy. Unmapped errors reach React Router's error boundary. Only handler errors are mapped; exceptions in notification or redirect callbacks also reach the boundary.

Pass route-specific overrides as the second argument to `createActions()(definitions, options)`. There is no global configuration or context provider.

## Submit options and completion

```ts
const { submit } = actions.useActions();

await submit.update(values, {
  method: 'PATCH',
  replace: true,
  preventScrollReset: true,
  state: { from: 'overview' },
});

await submit.archive(undefined, {
  navigate: false,
  fetcherKey: 'archive-dialog',
});
```

Submission options are React Router's own `SubmitOptions`. Precedence, from lowest to highest:

1. Built-in POST/JSON defaults.
2. Factory and route `submit` defaults.
3. Options on the individual action definition.
4. Options passed to `useActions`.
5. Options passed to the submission callback.

The router resolves action paths, relative targets, index routes, basenames, history, and revalidation. The library does not implement its own URL resolver or work around limitations in the installed router version.

The returned `Promise<void>` follows native submit completion. Read the handler result from router state; the promise does not return it. For GET requests, use a native loader, `fetcher.load`, or `useSubmit` as appropriate.

## Results and error handling

Ordinary handler values produce a discriminated result:

```ts
const { result } = actions.useActions();

if (result?.success && result.intent === 'update') {
  // result.data is inferred from the update handler.
}

if (result && !result.success) {
  // result.errors has the error type configured in createActionFactory.
}
```

The result shapes are:

```ts
{ type: 'action-result', intent, success: true, data }
{ type: 'action-result', intent, success: false, errors }
```

Only errors recognized by `mapError` become failure results. Native returned or thrown `Response` and `data(...)` values pass through unchanged. They preserve status codes, headers, redirects, error boundaries, and revalidation behavior, and bypass configured notifications and redirects.

`useActionData<typeof action>` and `useFetcher<typeof action>` retain the inferred types of ordinary values and `data(...)`. Arbitrary `Response` bodies have no statically known type, so the native action-data type becomes `unknown` when a handler or fallback can return one.

## Pending state and fetcher ownership

```ts
const state = actions.useActions({
  navigate: false,
  fetcherKey: `project-${projectId}`,
});

state.isSubmitting('update'); // Includes submission and subsequent loading.
state.pending;               // Every observed pending intent and native submission.
state.navigation;            // The real useNavigation() result.
state.fetcher;               // The real fetcher, including Form, submit, load, reset, data.
```

Each hook gets its own fetcher by default. The same key shares state across hooks; different keys allow independent submissions. Multiple intents using one fetcher share its cancellation behavior. To supply an existing fetcher:

```ts
const fetcher = useFetcher<unknown>();
const state = actions.useActions({ navigate: false, fetcher });
```

An explicit per-call `fetcherKey` selects that fetcher and retains its data after it becomes idle. Without an explicit key, an injected fetcher uses its own native `submit` method.

`pending` entries expose `intent`, `source`, `submission`, and an optional `fetcherKey`. Use the native submission's `json`, `formData`, `text`, and `state` for optimistic UI. A helper navigation is recognized by submission metadata. A native `<Form>` without that metadata remains observable through `navigation.state`; a native `fetcher.Form` is also recognized through its owning fetcher.

`result` is a convenience value for the source selected by the latest helper submission. It is not a history of all mutations. When using native `fetcher.Form`, `fetcher.submit`, or `fetcher.load` directly, read `fetcher.data`. The separate `data` property exposes the selected raw router data as `unknown`, because a native fetcher may call any loader or action.

## FormData and file uploads

```ts
const actions = createActions()({
  upload: {
    handler: (_params, form: FormData, request) =>
      uploadDocument(form, { signal: request.signal }),
    navigate: false,
    encType: 'multipart/form-data',
  },
});

await submit.upload(formData);
```

The default form transport preserves files and repeated fields. Native forms can select an intent using a hidden field:

```tsx
<fetcher.Form method="post" encType="multipart/form-data">
  <input type="hidden" name="__action_intent" value="upload" />
  <input type="file" name="document" />
  <button type="submit">Upload</button>
</fetcher.Form>
```

`__action_intent` and `__action_submission` are reserved fields. The handler receives a FormData copy without them. Use a handler accepting `FormData`; there is no implicit conversion to a plain object or `URLSearchParams`.

## Transport and serialization

| Encoding | Default representation |
| --- | --- |
| `application/json` | `{ intent, body?, submissionId? }`, with a JSON-compatible body. |
| `text/plain` | The same envelope encoded as text, not an arbitrary text protocol. |
| `multipart/form-data` | FormData with reserved intent/submission fields; files supported. |
| `application/x-www-form-urlencoded` | FormData containing text fields. |

A missing JSON body remains `undefined`. Object properties with `undefined` follow normal JSON omission. Arrays, primitives, and `null` retain their values. Dates, class instances, files in JSON, functions, non-finite numbers, cycles, and undefined array entries are rejected; prepare them explicitly or provide a custom transport. Empty form submissions use an empty FormData body.

`ActionTransport` connects three functions:

- `encode(payload, encType)` creates a native React Router submission target.
- `decode(request)` returns `{ intent, body, submissionId? }`, or `undefined` for a request outside the protocol.
- `inspect(submission)` identifies a pending submission without consuming its body.

Keep `submissionId` in custom encoding and inspection to preserve navigation ownership. Throw `ActionRequestError` for malformed protocol requests. The transport validates the envelope, not your business input.

```ts
import type { ActionTransport } from 'react-router-intents';

const transport: ActionTransport = {
  encode: encodeSubmission,
  decode: decodeRequest,
  inspect: inspectSubmission,
};

const actions = createActions()(definitions, { transport });
```

## Native action fallback

A route can keep a native action for requests outside its intent protocol:

```ts
const actions = createActions()(definitions, {
  fallback: async ({ request, context }) => {
    const form = await request.formData();
    return nativeUpload(form, context);
  },
});
```

The fallback receives the original action arguments and readable request. With the default transport, an ordinary form without an intent or an unsupported content type can reach it. Unknown intents and malformed envelopes remain errors. Arbitrary JSON or text needs a custom decoder that distinguishes your protocols, or an ordinary native action composed around `actions.action`.

Native actions, resource routes, forms, and hooks can be used alongside this library.

## Testing an application with Vitest

If Vitest reports `useSubmit must be used within a data router` despite a valid router provider, its module runner may have loaded different React Router instances for your tests and the external package. In Vitest 4, inline this package so both use the same module resolution:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    server: { deps: { inline: ['react-router-intents'] } },
  },
});
```

See Vitest's [dependency inlining documentation](https://vitest.dev/config/server.html#deps-inline). This setting is only for the test runner.

## Development

```sh
npm ci
npm run verify
```

`npm ci` builds the package through `prepare`. `verify` checks formatting, builds JavaScript and declarations, typechecks source and tests, runs Vitest, and installs an actual tarball into an isolated consumer to check runtime exports and published types.

Additional commands:

```sh
npm run dev         # Watch the TypeScript build
npm run test:watch  # Watch Vitest tests
npm pack            # Build and produce the publishable tarball
```

The repository's GitHub Actions workflow runs verification on Node 22, 24, and 26. Releases use the unscoped npm name `react-router-intents`; `npm publish` runs verification first. There is no automatic publishing workflow.

## License

MIT, maintained by [10KB](https://github.com/10KB).
