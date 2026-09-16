import { data, type SubmitOptions, useActionData, useFetcher } from 'react-router';
import { createActionFactory, createActions as genericActions } from 'react-router-intents';
import { expectTypeOf } from 'vitest';

const createActions = createActionFactory<string[]>({});

const actions = createActions<{ groupId: string }>()({
  update: {
    handler: async (params, body: { name: string }, request) => {
      expectTypeOf(params).toEqualTypeOf<{ groupId: string }>();
      expectTypeOf(request).toEqualTypeOf<Request>();
      return { id: params.groupId, name: body.name };
    },
    redirect: (params, result: { id: string }, request) => {
      expectTypeOf(params).toEqualTypeOf<{ groupId: string }>();
      expectTypeOf(request).toEqualTypeOf<Request>();
      return `/groups/${result.id}`;
    },
  },
  archive: { handler: async (params) => ({ archivedId: params.groupId }) },
});

// These hooks are compile-time fixtures; tsc checks them without rendering React.
export function useActionTypeContract() {
  const { submit, result, isSubmitting } = actions.useActions();
  expectTypeOf(submit.update).toEqualTypeOf<
    (body: { name: string }, options?: SubmitOptions) => Promise<void>
  >();
  expectTypeOf(submit.archive).toEqualTypeOf<
    (body?: undefined, options?: SubmitOptions) => Promise<void>
  >();
  submit.update({ name: 'Cardiology' });
  submit.archive();
  isSubmitting();
  isSubmitting('update');

  // @ts-expect-error Update requires a body.
  submit.update();
  // @ts-expect-error The body must match the handler input.
  submit.update({ name: 123 });
  // @ts-expect-error Archive does not accept a body.
  submit.archive({ name: 'Cardiology' });
  // @ts-expect-error Only configured intents can be submitted.
  submit.remove();
  // @ts-expect-error Pending state only accepts configured intent names.
  isSubmitting('remove');

  if (result?.success && result.intent === 'update') {
    expectTypeOf(result.data).toEqualTypeOf<{ id: string; name: string }>();
    // @ts-expect-error Narrowing by intent excludes other handlers' result fields.
    result.data.archivedId;
  }
  if (result?.intent === 'archive' && result.success) {
    expectTypeOf(result.data).toEqualTypeOf<{ archivedId: string }>();
  }
  if (result && !result.success) {
    expectTypeOf(result.errors).toEqualTypeOf<string[]>();
    // @ts-expect-error Failure results expose errors, not success data.
    result.data;
  }
}

createActions()({
  create: {
    handler: async () => ({ id: '123' }),
    // @ts-expect-error A redirect cannot require fields absent from the handler result.
    redirect: (_params, result: { unrelated: number }) => `/groups/${result.unrelated}`,
  },
});

createActions()({
  create: {
    handler: async () => ({ id: '123' }),
    // @ts-expect-error Redirect fields must also match the handler result types.
    redirect: (_params, result: { id: number }) => `/groups/${result.id}`,
  },
});

createActions()({
  save: {
    handler: async () => undefined,
    action: 'edit',
  },
});

createActions()({
  save: {
    handler: async () => undefined,
    action: 'https://example.com/edit',
  },
});

const nativeDataActions = genericActions()({ save: { handler: () => data({ saved: true }, 201) } });
const responseActions = genericActions()({
  save: { handler: () => Response.json({ saved: true }) },
});
const fallbackActions = genericActions()(
  { save: { handler: () => 123 } },
  {
    fallback: (args) => {
      expectTypeOf(args.request).toEqualTypeOf<Request>();
      return { raw: true };
    },
  }
);
export function useNativeActionTypes() {
  const result = useActionData<typeof actions.action>();
  if (result?.success && result.intent === 'update') {
    expectTypeOf(result.data).toEqualTypeOf<{ id: string; name: string }>();
  }
  const fetcher = useFetcher<typeof actions.action>();
  if (fetcher.data?.success && fetcher.data.intent === 'archive') {
    expectTypeOf(fetcher.data.data).toEqualTypeOf<{ archivedId: string }>();
  }
  const native = useActionData<typeof nativeDataActions.action>();
  if (native && 'saved' in native) expectTypeOf(native.saved).toEqualTypeOf<boolean>();
  expectTypeOf(useActionData<typeof responseActions.action>()).toEqualTypeOf<unknown>();
  const fallback = useActionData<typeof fallbackActions.action>();
  if (fallback && 'raw' in fallback) expectTypeOf(fallback.raw).toEqualTypeOf<boolean>();
  const state = actions.useActions();
  state.submit.update(
    { name: 'Nephrology' },
    { method: 'PATCH', replace: true, action: '../edit', preventScrollReset: true }
  );
  state.submit.archive(undefined, { navigate: false, fetcherKey: 'archive' });
  expectTypeOf(state.data).toEqualTypeOf<unknown>();
  expectTypeOf(state.fetcher.data).toEqualTypeOf<unknown>();
  // @ts-expect-error Submit options do not relax body type checking.
  state.submit.update({ wrong: true }, { method: 'PATCH' });
}

const bodyActions = genericActions<{ groupId?: string }>()({
  arbitrary: { handler: (_params, body: unknown) => body },
  optional: { handler: (_params, body?: { name: string }) => body?.name },
  upload: {
    handler: (_params, body: FormData, request, args) => {
      expectTypeOf(args.request).toEqualTypeOf<Request>();
      expectTypeOf(request).toEqualTypeOf<Request>();
      expectTypeOf(_params.groupId).toEqualTypeOf<string | undefined>();
      return body.get('file');
    },
  },
});
const responseFallback = genericActions()(
  { save: { handler: () => 1 } },
  {
    fallback: () => Response.json({ native: true }),
  }
);
const unknownResult = genericActions()({ save: { handler: (): unknown => Response.json(123) } });
export function useAdditionalActionTypes() {
  const { submit } = bodyActions.useActions();
  submit.arbitrary({ anything: true });
  // @ts-expect-error An explicit body parameter remains required even when its type is unknown.
  submit.arbitrary();
  submit.optional();
  submit.optional({ name: 'New name' });
  submit.upload(new FormData(), { encType: 'multipart/form-data' });
  expectTypeOf(useActionData<typeof responseFallback.action>()).toEqualTypeOf<unknown>();
  expectTypeOf(useActionData<typeof unknownResult.action>()).toEqualTypeOf<unknown>();
  expectTypeOf(useActionData<typeof nativeDataActions.action>()).toEqualTypeOf<
    { saved: boolean } | undefined
  >();
}
