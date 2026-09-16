import { useId, useMemo, useRef, useState } from 'react';
import {
  type Fetcher,
  type SubmitOptions,
  useActionData,
  useFetcher,
  useFetchers,
  useNavigation,
  useSubmit,
} from 'react-router';
import { defaultActionTransport } from './action-transport.js';
import type {
  ActionDefaults,
  RuntimeActionConfig,
  SubmissionState,
  UseActionsOptions,
} from './action-types.js';
import { isActionResult } from './action-types.js';

/** A recognized intent observed in native submitting or loading state. */
export type PendingAction = {
  intent: string;
  source: 'navigation' | 'fetcher';
  /** Native state, including json/formData/text for optimistic UI. */
  submission: ReturnType<typeof useNavigation> | Fetcher<unknown>;
  /** Present for owned/keyed fetchers; absent for navigation or an injected fetcher. */
  fetcherKey?: string;
};
const emptyOptions: UseActionsOptions = {};

// A no-body submit callback can be passed directly to onClick. React still gives it
// a SyntheticEvent; remove that event while preserving ordinary handler input.
function callbackBody(body: unknown): unknown {
  return typeof body === 'object' &&
    body !== null &&
    'nativeEvent' in body &&
    'preventDefault' in body &&
    typeof body.preventDefault === 'function'
    ? undefined
    : body;
}

export function useActionSubmission<TError>(
  config: Record<string, RuntimeActionConfig>,
  defaults: ActionDefaults<TError>,
  hookOptions: UseActionsOptions = emptyOptions
): SubmissionState {
  const suppliedFetcher = hookOptions.fetcher;
  const source = useId();
  const [selectedKey, setSelectedKey] = useState<string>();
  const defaultKey = hookOptions.fetcherKey ?? defaults.submit?.fetcherKey ?? source;
  const ownedKey = selectedKey ?? defaultKey;
  const routerSubmit = useSubmit();
  const navigation = useNavigation();
  // useFetchers observes active submissions; useFetcher also keeps the selected
  // per-call key subscribed so its completed data remains available after idle.
  const ownedFetcher = useFetcher<unknown>({ key: ownedKey });
  const fetcher = selectedKey === undefined && suppliedFetcher ? suppliedFetcher : ownedFetcher;
  const fetchers = useFetchers();
  const actionData = useActionData<unknown>();
  const sequence = useRef(0);
  const trackedKeys = useRef(new Set<string>());
  const lastSubmission = useRef<
    { source: 'navigation' | 'fetcher'; fetcherKey?: string } | undefined
  >(undefined);
  const transport = defaults.transport ?? defaultActionTransport;

  const submit = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(config).map(([intent, definition]) => {
          const { fetcher: _fetcher, ...hookSubmitOptions } = hookOptions;
          const {
            handler: _handler,
            redirect: _redirect,
            notification: _notification,
            ...definitionOptions
          } = definition;
          return [
            intent,
            async (body?: unknown, overrides?: SubmitOptions): Promise<void> => {
              const options: SubmitOptions = {
                method: 'POST',
                encType: 'application/json',
                ...defaults.submit,
                ...definitionOptions,
                ...hookSubmitOptions,
                ...overrides,
              };
              options.method ??= 'POST';
              options.encType ??= 'application/json';
              const payload = transport.encode(
                {
                  intent,
                  body: callbackBody(body),
                  submissionId: `${source}:${++sequence.current}`,
                },
                options.encType
              );
              if (options.navigate === false) {
                if (suppliedFetcher && options.fetcherKey === undefined) {
                  setSelectedKey(undefined);
                  lastSubmission.current = { source: 'fetcher' };
                  return suppliedFetcher.submit(payload, options);
                }
                const key = options.fetcherKey ?? defaultKey;
                setSelectedKey(key);
                trackedKeys.current.add(key);
                lastSubmission.current = { source: 'fetcher', fetcherKey: key };
                return routerSubmit(payload, { ...options, fetcherKey: key });
              }
              lastSubmission.current = { source: 'navigation' };
              return routerSubmit(payload, options);
            },
          ];
        })
      ),
    [
      config,
      defaults.submit,
      hookOptions,
      transport,
      source,
      defaultKey,
      suppliedFetcher,
      routerSubmit,
    ]
  );

  const pending: PendingAction[] = [];
  const navigationIntent = navigation.state !== 'idle' ? transport.inspect(navigation) : undefined;
  // An intent name alone cannot identify ownership: other routes may reuse it.
  if (
    navigationIntent?.submissionId?.startsWith(`${source}:`) &&
    Object.hasOwn(config, navigationIntent.intent)
  ) {
    pending.push({ intent: navigationIntent.intent, source: 'navigation', submission: navigation });
  }
  const observedFetchers: { key?: string; value: Fetcher<unknown> }[] = [
    { key: ownedKey, value: ownedFetcher },
    ...(suppliedFetcher ? [{ value: suppliedFetcher }] : []),
    ...fetchers
      .filter((entry) => trackedKeys.current.has(entry.key) && entry.key !== ownedKey)
      .map((entry) => ({ key: entry.key, value: entry })),
  ];
  for (const entry of observedFetchers) {
    const active = entry.value.state !== 'idle' ? transport.inspect(entry.value) : undefined;
    if (active && Object.hasOwn(config, active.intent)) {
      pending.push({
        intent: active.intent,
        source: 'fetcher',
        submission: entry.value,
        fetcherKey: entry.key,
      });
    }
  }

  const last = lastSubmission.current;
  const data: unknown =
    last?.source === 'fetcher'
      ? observedFetchers.find((entry) => entry.key === last.fetcherKey)?.value.data
      : last?.source === 'navigation'
        ? actionData
        : (fetcher.data ?? actionData);

  return {
    submit,
    result: isActionResult(data) && Object.hasOwn(config, data.intent) ? data : undefined,
    data,
    pending,
    navigation,
    fetcher,
    isSubmitting: (intent?: string): boolean =>
      pending.some((entry) => intent === undefined || entry.intent === intent),
  };
}
