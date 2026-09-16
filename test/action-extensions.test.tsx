import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { ActionRequestError, type ActionTransport, createActions } from '../src/index.js';

afterEach(cleanup);

it('supports Date bodies and pending state through a custom transport', async () => {
  const completed = Promise.withResolvers<void>();
  const read = (value: unknown) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('intent' in value) ||
      typeof value.intent !== 'string' ||
      !('date' in value) ||
      typeof value.date !== 'string' ||
      !('submissionId' in value) ||
      typeof value.submissionId !== 'string'
    )
      throw new ActionRequestError();
    return { intent: value.intent, body: new Date(value.date), submissionId: value.submissionId };
  };
  const transport: ActionTransport = {
    encode({ intent, body, submissionId }) {
      if (!(body instanceof Date)) throw new ActionRequestError();
      return JSON.stringify({ intent, date: body.toISOString(), submissionId });
    },
    async decode(request) {
      return read(await request.json());
    },
    inspect(submission) {
      return submission.json ? read(submission.json) : undefined;
    },
  };
  const actions = createActions()(
    {
      schedule: {
        handler: async (_params, body: Date) => {
          await completed.promise;
          return body.toISOString();
        },
      },
    },
    { transport }
  );
  function Page() {
    const { submit, result, isSubmitting } = actions.useActions();
    return (
      <>
        <button
          type="button"
          disabled={isSubmitting('schedule')}
          onClick={() => submit.schedule(new Date('2026-09-16T12:00:00Z'))}
        >
          Schedule
        </button>
        <output aria-label="Result">{result?.success ? result.data : ''}</output>
      </>
    );
  }
  const router = createMemoryRouter([{ path: '/', action: actions.action, element: <Page /> }]);
  render(<RouterProvider router={router} />);
  await userEvent.setup().click(screen.getByRole('button'));
  expect(screen.getByRole('button')).toBeDisabled();
  await act(async () => completed.resolve());
  await waitFor(() =>
    expect(screen.getByLabelText('Result')).toHaveTextContent('2026-09-16T12:00:00.000Z')
  );
  expect(screen.getByRole('button')).toBeEnabled();
  router.dispose();
});

it('preserves an array body through the typed submit callback', async () => {
  const actions = createActions()({
    sum: { handler: (_params, values: number[]) => values.reduce((sum, value) => sum + value, 0) },
  });
  function Page() {
    const { submit, result } = actions.useActions();
    return (
      <>
        <button type="button" onClick={() => submit.sum([2, 3, 5])}>
          Add
        </button>
        <output aria-label="Sum">{result?.success ? result.data : ''}</output>
      </>
    );
  }
  const router = createMemoryRouter([{ path: '/', action: actions.action, element: <Page /> }]);
  render(<RouterProvider router={router} />);
  await userEvent.setup().click(screen.getByRole('button'));
  await waitFor(() => expect(screen.getByLabelText('Sum')).toHaveTextContent('10'));
  router.dispose();
});

it.each([true, false])(
  'lets React Router resolve the basename and index target (navigate: %s)',
  async (navigate) => {
    let parentCalls = 0;
    const actions = createActions()({
      save: {
        handler: (_params, _body: undefined, request) => new URL(request.url).pathname,
        navigate,
      },
    });
    function Page() {
      const { submit, result } = actions.useActions();
      return (
        <>
          <button type="button" onClick={() => submit.save(undefined)}>
            Save
          </button>
          <output aria-label="Destination">{result?.success ? result.data : ''}</output>
        </>
      );
    }
    const router = createMemoryRouter(
      [
        {
          path: '/groups',
          action: () => ++parentCalls,
          children: [{ index: true, action: actions.action, element: <Page /> }],
        },
      ],
      { basename: '/app', initialEntries: ['/app/groups'] }
    );
    render(<RouterProvider router={router} />);
    await userEvent.setup().click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getByLabelText('Destination')).toHaveTextContent('/app/groups')
    );
    expect(parentCalls).toBe(0);
    expect(router.state.location.pathname).toBe('/app/groups');
    router.dispose();
  }
);

it('passes an omitted optional body to the handler as undefined', async () => {
  const actions = createActions()({ save: { handler: (_params, value?: number) => value ?? 7 } });
  function Page() {
    const { submit, result } = actions.useActions();
    return (
      <>
        <button type="button" onClick={() => submit.save()}>
          Save
        </button>
        <output aria-label="Value">{result?.success ? result.data : ''}</output>
      </>
    );
  }
  const router = createMemoryRouter([{ path: '/', action: actions.action, element: <Page /> }]);
  render(<RouterProvider router={router} />);
  await userEvent.setup().click(screen.getByRole('button'));
  await waitFor(() => expect(screen.getByLabelText('Value')).toHaveTextContent('7'));
  router.dispose();
});

it('uses POST and JSON when optional submit options are undefined', async () => {
  const actions = createActions()({
    save: {
      handler: (_params, body: { name: string }, request) => ({ body, method: request.method }),
    },
  });
  function Page() {
    const { submit, result } = actions.useActions();
    return (
      <>
        <button
          type="button"
          onClick={() =>
            submit.save({ name: 'Preserved' }, { method: undefined, encType: undefined })
          }
        >
          Save
        </button>
        <output aria-label="Request">{result?.success ? JSON.stringify(result.data) : ''}</output>
      </>
    );
  }
  const router = createMemoryRouter([{ path: '/', action: actions.action, element: <Page /> }]);
  render(<RouterProvider router={router} />);
  await userEvent.setup().click(screen.getByRole('button'));
  await waitFor(() =>
    expect(JSON.parse(screen.getByLabelText('Request').textContent || '{}')).toEqual({
      body: { name: 'Preserved' },
      method: 'POST',
    })
  );
  router.dispose();
});
