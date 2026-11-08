import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import {
  type ActionFunctionArgs,
  createMemoryRouter,
  data,
  isRouteErrorResponse,
  RouterContextProvider,
  RouterProvider,
  useFetcher,
  useRouteError,
} from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { createActionFactory } from '../src/index.js';

const createActions = createActionFactory({});
const routers = new Set<ReturnType<typeof createMemoryRouter>>();

const mountRouter = (routes: Parameters<typeof createMemoryRouter>[0], initialEntries = ['/']) => {
  const router = createMemoryRouter(routes, { initialEntries });
  routers.add(router);
  render(<RouterProvider router={router} />);
  return router;
};

const requestFor = (intent = 'save', body: unknown = {}) =>
  new Request('http://localhost/groups/123', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent, body }),
  });

function actionArgs(
  request: Request,
  params: ActionFunctionArgs['params'] = {},
  context: ActionFunctionArgs['context'] = new RouterContextProvider()
): ActionFunctionArgs {
  return { request, params, context, url: new URL(request.url), pattern: '/groups/:id' };
}

function ErrorBoundary() {
  const error: unknown = useRouteError();
  return (
    <p role="alert">
      {isRouteErrorResponse(error)
        ? error.status
        : error instanceof Error
          ? error.message
          : 'Unknown error'}
    </p>
  );
}

afterEach(() => {
  cleanup();
  for (const router of routers) router.dispose();
  routers.clear();
});

it('preserves native data and the status received by shouldRevalidate', async () => {
  const nativeResult = data({ valid: false }, { status: 422, headers: { 'X-Action': 'save' } });
  const actions = createActions()({ save: { handler: () => nativeResult } });
  const statuses: Array<number | undefined> = [];
  function View() {
    const { submit, data: actionData, result } = actions.useActions();
    return (
      <>
        <button type="button" onClick={() => submit.save()}>
          Save
        </button>
        <output aria-label="Router data">{JSON.stringify(actionData)}</output>
        <output aria-label="Helper result">{result === undefined ? 'none' : 'present'}</output>
      </>
    );
  }
  mountRouter([
    {
      path: '/',
      loader: () => null,
      action: actions.action,
      element: <View />,
      hydrateFallbackElement: <p>Loading</p>,
      shouldRevalidate: ({ actionStatus, defaultShouldRevalidate }) => {
        statuses.push(actionStatus);
        return defaultShouldRevalidate;
      },
    },
  ]);

  await userEvent.setup().click(await screen.findByRole('button', { name: 'Save' }));

  await waitFor(() =>
    expect(screen.getByLabelText('Router data')).toHaveTextContent('{"valid":false}')
  );
  expect(screen.getByLabelText('Helper result')).toHaveTextContent('none');
  expect(statuses).toContain(422);
  await expect(actions.action(actionArgs(requestFor()))).resolves.toBe(nativeResult);
});

it.each([
  ['native error data', data({ missing: true }, { status: 404 }), '404'],
  ['unexpected programming error', new TypeError('Broken handler'), 'Broken handler'],
])('lets %s reach the route error boundary', async (_label, error, expected) => {
  const actions = createActions()({
    save: {
      handler: () => {
        throw error;
      },
    },
  });
  function View() {
    const { submit } = actions.useActions();
    return (
      <button type="button" onClick={() => submit.save()}>
        Save
      </button>
    );
  }
  mountRouter([
    { path: '/', action: actions.action, element: <View />, errorElement: <ErrorBoundary /> },
  ]);

  await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(expected);
});

it.each([true, false])(
  'exposes a native Response as router data without wrapping it (navigate: %s)',
  async (navigate) => {
    const actions = createActions()({
      save: { handler: () => Response.json({ saved: true }, { status: 201 }), navigate },
    });
    function View() {
      const { submit, data: actionData, result } = actions.useActions();
      return (
        <>
          <button type="button" onClick={() => submit.save()}>
            Save
          </button>
          <output aria-label="Router data">{JSON.stringify(actionData)}</output>
          <output aria-label="Helper result">{result === undefined ? 'none' : 'present'}</output>
        </>
      );
    }
    mountRouter([{ path: '/', action: actions.action, element: <View /> }]);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Router data')).toHaveTextContent('{"saved":true}')
    );
    expect(screen.getByLabelText('Helper result')).toHaveTextContent('none');
  }
);

it('applies application error mapping and notification translation', async () => {
  const failure = { code: 'duplicate' };
  const notifications: Array<{ message: string; variant: string }> = [];
  const withPolicy = createActionFactory({
    mapError: (error) => (error === failure ? ['Already exists'] : undefined),
    notify: (message, variant) => notifications.push({ message, variant }),
  });
  const actions = withPolicy()({
    save: {
      handler: () => {
        throw failure;
      },
      notification: { error: () => 'Please choose another name' },
    },
  });

  await expect(actions.action(actionArgs(requestFor()))).resolves.toMatchObject({
    intent: 'save',
    success: false,
    errors: ['Already exists'],
  });
  expect(notifications).toEqual([{ message: 'Please choose another name', variant: 'error' }]);
});

it('propagates notification errors without applying the handler error mapper', async () => {
  const policyError = new Error('Broken notification');
  const withPolicy = createActionFactory({
    mapError: () => ['Recoverable error'],
    notify: () => {
      throw policyError;
    },
  });
  const actions = withPolicy()({
    save: { handler: () => ({ saved: true }), notification: { success: 'Saved' } },
  });

  await expect(actions.action(actionArgs(requestFor()))).rejects.toBe(policyError);
});

it('preserves thrown native data when an error mapper is configured', async () => {
  const nativeError = data({ missing: true }, { status: 404 });
  const withPolicy = createActionFactory({ mapError: () => ['Handled error'] });
  const actions = withPolicy()({
    save: {
      handler: () => {
        throw nativeError;
      },
    },
  });

  await expect(actions.action(actionArgs(requestFor()))).rejects.toBe(nativeError);
});

it('keeps the original Request readable and passes the full action context', async () => {
  const context = new RouterContextProvider();
  const request = requestFor('save', { name: 'Cardiology' });
  const actions = createActions<{ id: string }>()({
    save: {
      handler: async (params, body: { name: string }, handlerRequest, args) => ({
        id: params.id,
        name: body.name,
        sameRequest: handlerRequest === request && args.request === request,
        sameContext: args.context === context,
        originalBody: await handlerRequest.json(),
      }),
    },
  });

  await expect(actions.action(actionArgs(request, { id: '123' }, context))).resolves.toMatchObject({
    success: true,
    data: {
      id: '123',
      name: 'Cardiology',
      sameRequest: true,
      sameContext: true,
      originalBody: { intent: 'save', body: { name: 'Cardiology' } },
    },
  });
});

it('passes a native multipart request with a file unchanged to the fallback', async () => {
  const body = new FormData();
  body.append('name', 'Import');
  body.append('tag', 'first');
  body.append('tag', 'second');
  body.append('file', new File(['name\nCardiology'], 'groups.csv', { type: 'text/csv' }));
  const request = new Request('http://localhost/import', { method: 'POST', body });
  const actions = createActions()(
    { save: { handler: () => ({ saved: true }) } },
    {
      fallback: async (args) => {
        const form = await args.request.formData();
        const file = form.get('file');
        if (file === null || typeof file === 'string') throw new Error('Missing file');
        return data({
          sameRequest: args.request === request,
          name: form.get('name'),
          tags: form.getAll('tag'),
          fileName: file.name,
          fileContent: await file.text(),
        });
      },
    }
  );

  await expect(actions.action(actionArgs(request))).resolves.toMatchObject({
    data: {
      sameRequest: true,
      name: 'Import',
      tags: ['first', 'second'],
      fileName: 'groups.csv',
      fileContent: 'name\nCardiology',
    },
  });
});

it('forwards per-call submit options and preserves completion and pending state', async () => {
  const saved = Promise.withResolvers<{ method: string; url: string }>();
  let received: { method: string; url: string } | undefined;
  const actions = createActions()({
    save: {
      handler: (_params, _body: { name: string }, request) => {
        received = { method: request.method, url: request.url };
        return saved.promise;
      },
      method: 'POST',
      action: '/unused',
    },
  });
  function View() {
    const { submit, pending, navigation, isSubmitting } = actions.useActions({ method: 'PUT' });
    const [completed, setCompleted] = useState(false);
    return (
      <>
        <button
          type="button"
          disabled={isSubmitting('save')}
          onClick={async () => {
            await submit.save(
              { name: 'Cardiology' },
              {
                method: 'PATCH',
                action: '/first?source=call',
                replace: true,
                state: { source: 'call' },
                preventScrollReset: true,
              }
            );
            setCompleted(true);
          }}
        >
          Save
        </button>
        <output aria-label="Pending method">{pending[0]?.submission.formMethod}</output>
        <output aria-label="Navigation state">{navigation.state}</output>
        <output aria-label="Completed">{String(completed)}</output>
      </>
    );
  }
  const router = mountRouter(
    [
      { path: '/first', action: actions.action, element: <View /> },
      { path: '/previous', element: <p>Previous page</p> },
    ],
    ['/previous', '/first']
  );

  await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));

  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByLabelText('Pending method')).toHaveTextContent('PATCH');
  expect(screen.getByLabelText('Navigation state')).toHaveTextContent('submitting');
  expect(screen.getByLabelText('Completed')).toHaveTextContent('false');
  await waitFor(() =>
    expect(received).toEqual({ method: 'PATCH', url: 'http://localhost/first?source=call' })
  );
  await act(async () => saved.resolve({ method: 'PATCH', url: '/first?source=call' }));
  await waitFor(() => expect(screen.getByLabelText('Completed')).toHaveTextContent('true'));
  expect(router.state.location.state).toEqual({ source: 'call' });
  expect(router.state.preventScrollReset).toBe(true);
  await act(async () => router.navigate(-1));
  expect(router.state.location.pathname).toBe('/previous');
});

it('keeps pending state and results independent across hook fetchers', async () => {
  const first = Promise.withResolvers<{ id: string }>();
  const second = Promise.withResolvers<{ id: string }>();
  const responses = { first, second };
  const actions = createActions()({
    save: {
      handler: (_params, body: { id: keyof typeof responses }) => responses[body.id].promise,
    },
  });
  function Row({ id }: { id: keyof typeof responses }) {
    const { submit, isSubmitting, result } = actions.useActions({ navigate: false });
    return (
      <>
        <button type="button" disabled={isSubmitting('save')} onClick={() => submit.save({ id })}>
          {id}
        </button>
        <output aria-label={`${id} result`}>{result?.success ? result.data.id : ''}</output>
      </>
    );
  }
  mountRouter([
    {
      path: '/',
      action: actions.action,
      element: (
        <>
          <Row id="first" />
          <Row id="second" />
        </>
      ),
    },
  ]);
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'first' }));
  expect(screen.getByRole('button', { name: 'second' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'second' }));
  expect(screen.getByRole('button', { name: 'first' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'second' })).toBeDisabled();
  await act(async () => first.resolve({ id: 'first' }));
  expect(screen.getByRole('button', { name: 'first' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'second' })).toBeDisabled();
  expect(screen.getByLabelText('first result')).toHaveTextContent('first');
  expect(screen.getByLabelText('second result')).toBeEmptyDOMElement();
  await act(async () => second.resolve({ id: 'second' }));
  expect(screen.getByLabelText('second result')).toHaveTextContent('second');
});

it('shares pending state and results across hooks with the same fetcher key', async () => {
  const saved = Promise.withResolvers<{ id: string }>();
  const actions = createActions()({ save: { handler: () => saved.promise } });
  function Row({ name }: { name: string }) {
    const { submit, isSubmitting, result } = actions.useActions({
      fetcherKey: 'shared-action',
      navigate: false,
    });
    return (
      <>
        <button type="button" disabled={isSubmitting('save')} onClick={() => submit.save()}>
          {name}
        </button>
        <output aria-label={`${name} result`}>{result?.success ? result.data.id : ''}</output>
      </>
    );
  }
  mountRouter([
    {
      path: '/',
      action: actions.action,
      element: (
        <>
          <Row name="First" />
          <Row name="Second" />
        </>
      ),
    },
  ]);

  await userEvent.setup().click(screen.getByRole('button', { name: 'First' }));

  expect(screen.getByRole('button', { name: 'First' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Second' })).toBeDisabled();
  await act(async () => saved.resolve({ id: '123' }));
  expect(screen.getByLabelText('First result')).toHaveTextContent('123');
  expect(screen.getByLabelText('Second result')).toHaveTextContent('123');
});

it('uses an injected native fetcher and preserves its reset behavior', async () => {
  const actions = createActions()({ save: { handler: () => ({ id: '123' }) } });
  function View() {
    const fetcher = useFetcher<unknown>();
    const { submit, result } = actions.useActions({ fetcher, navigate: false });
    return (
      <>
        <button type="button" onClick={() => submit.save()}>
          Save
        </button>
        <button type="button" onClick={() => fetcher.reset()}>
          Reset
        </button>
        <output aria-label="Helper result">{result?.success ? result.data.id : ''}</output>
        <output aria-label="Native data">{JSON.stringify(fetcher.data ?? undefined)}</output>
      </>
    );
  }
  mountRouter([{ path: '/', action: actions.action, element: <View /> }]);
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(screen.getByLabelText('Helper result')).toHaveTextContent('123'));
  expect(screen.getByLabelText('Native data')).toHaveTextContent('123');
  await user.click(screen.getByRole('button', { name: 'Reset' }));
  expect(screen.getByLabelText('Helper result')).toBeEmptyDOMElement();
  expect(screen.getByLabelText('Native data')).toBeEmptyDOMElement();
});

it('retains the result of a per-call fetcher key after the fetcher becomes idle', async () => {
  const saved = Promise.withResolvers<{ id: string }>();
  const actions = createActions()({ save: { handler: () => saved.promise } });
  function View() {
    const { submit, result, data: actionData, fetcher, isSubmitting } = actions.useActions();
    return (
      <>
        <button
          type="button"
          disabled={isSubmitting('save')}
          onClick={() => submit.save(undefined, { navigate: false, fetcherKey: 'per-call-save' })}
        >
          Save
        </button>
        <output aria-label="Helper result">{result?.success ? result.data.id : ''}</output>
        <output aria-label="Router data">{JSON.stringify(actionData)}</output>
        <output aria-label="Fetcher state">{fetcher.state}</output>
      </>
    );
  }
  const router = mountRouter([{ path: '/', action: actions.action, element: <View /> }]);

  await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));

  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await act(async () => saved.resolve({ id: '123' }));
  await waitFor(() => expect(screen.getByLabelText('Helper result')).toHaveTextContent('123'));
  expect(screen.getByLabelText('Router data')).toHaveTextContent('"id":"123"');
  expect(screen.getByLabelText('Fetcher state')).toHaveTextContent('idle');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(router.state.location.pathname).toBe('/');
});

it('handles a native multipart fetcher.Form with files and repeated fields', async () => {
  const finished = Promise.withResolvers<void>();
  const actions = createActions()({
    upload: {
      handler: async (_params, body: FormData) => {
        await finished.promise;
        const file = body.get('file');
        if (file === null || typeof file === 'string') throw new Error('Missing file');
        return {
          fileName: file.name,
          fileContent: await file.text(),
          tags: body.getAll('tag'),
          name: body.get('name'),
        };
      },
    },
  });
  function View() {
    const { fetcher, result, pending, isSubmitting } = actions.useActions();
    return (
      <fetcher.Form method="post" encType="multipart/form-data">
        <input type="hidden" name="__action_intent" value="upload" />
        <input type="hidden" name="tag" value="first" />
        <input type="hidden" name="tag" value="second" />
        <label>
          Name
          <input name="name" defaultValue="Groups" />
        </label>
        <label>
          File
          <input type="file" name="file" />
        </label>
        <button type="submit" disabled={isSubmitting('upload')}>
          Upload
        </button>
        <output aria-label="Pending source">{pending[0]?.source}</output>
        <output aria-label="Upload result">
          {result?.success ? JSON.stringify(result.data) : ''}
        </output>
      </fetcher.Form>
    );
  }
  mountRouter([{ path: '/', action: actions.action, element: <View /> }]);
  const user = userEvent.setup();

  // Happy DOM reads the native FileList when constructing FormData(form), while
  // userEvent.upload only replaces the public getter. Assign files via DataTransfer
  // so the submitted form contains the selected file.
  const upload = new DataTransfer();
  upload.items.add(new File(['name\nCardiology'], 'groups.csv', { type: 'text/csv' }));
  const input = screen.getByLabelText<HTMLInputElement>('File');
  input.files = upload.files;
  await user.click(screen.getByRole('button', { name: 'Upload' }));

  expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  expect(screen.getByLabelText('Pending source')).toHaveTextContent('fetcher');
  await act(async () => finished.resolve());
  await waitFor(() =>
    expect(screen.getByLabelText('Upload result')).toHaveTextContent(
      JSON.stringify({
        fileName: 'groups.csv',
        fileContent: 'name\nCardiology',
        tags: ['first', 'second'],
        name: 'Groups',
      })
    )
  );
  expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
});

it('runs two per-call fetcher keys concurrently and selects the latest submission result', async () => {
  const first = Promise.withResolvers<{ id: string }>();
  const second = Promise.withResolvers<{ id: string }>();
  const responses = { A: first, B: second };
  const signals: Partial<Record<keyof typeof responses, AbortSignal>> = {};
  const actions = createActions()({
    save: {
      handler: (_params, body: { id: keyof typeof responses }, request) => {
        signals[body.id] = request.signal;
        return responses[body.id].promise;
      },
    },
  });
  function View() {
    const { submit, pending, result } = actions.useActions();
    return (
      <>
        <button
          type="button"
          onClick={() => submit.save({ id: 'A' }, { navigate: false, fetcherKey: 'call-A' })}
        >
          Save first
        </button>
        <button
          type="button"
          onClick={() => submit.save({ id: 'B' }, { navigate: false, fetcherKey: 'call-B' })}
        >
          Save second
        </button>
        <output aria-label="Pending actions">
          {pending
            .map((entry) => entry.fetcherKey)
            .sort()
            .join(',')}
        </output>
        <output aria-label="Latest result">{result?.success ? result.data.id : ''}</output>
      </>
    );
  }
  mountRouter([{ path: '/', action: actions.action, element: <View /> }]);
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Save first' }));
  await user.click(screen.getByRole('button', { name: 'Save second' }));

  expect(screen.getByLabelText('Pending actions')).toHaveTextContent('call-A,call-B');
  await waitFor(() => expect(signals.A?.aborted).toBe(false));
  await waitFor(() => expect(signals.B?.aborted).toBe(false));
  await act(async () => second.resolve({ id: 'B' }));
  expect(screen.getByLabelText('Latest result')).toHaveTextContent('B');
  expect(screen.getByLabelText('Pending actions')).toHaveTextContent('call-A');
  expect(signals.A?.aborted).toBe(false);
  await act(async () => first.resolve({ id: 'A' }));
  expect(screen.getByLabelText('Pending actions')).toBeEmptyDOMElement();
  expect(screen.getByLabelText('Latest result')).toHaveTextContent('B');
});
