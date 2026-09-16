import type {
  ActionFunctionArgs,
  data,
  FetcherWithComponents,
  SubmitOptions,
  useNavigation,
} from 'react-router';
import type { ActionTransport } from './action-transport.js';

export type NativeData<T = unknown> = ReturnType<typeof data<T>>;
/** A notification string, or a synchronous callback evaluated when that notification is sent. */
export type NotificationMessage = string | (() => string);
/** Original React Router action arguments, extended with the intent whose handler failed. */
export type ActionContext = ActionFunctionArgs & { intent: string };

/** Shared defaults for a factory or route; notification and error callbacks are synchronous. */
export type ActionDefaults<TError> = {
  /**
   * Native submission defaults, applied after POST/JSON and before definition,
   * hook, and per-call options. Factory and route submission defaults are merged.
   */
  submit?: SubmitOptions;
  /** Encodes bodies and identifies intents. Defaults to defaultActionTransport. */
  transport?: ActionTransport;
  /**
   * Receives a resolved notification message. Without this callback, notification
   * declarations are ignored, including their message callbacks.
   */
  notify?: (message: string, variant: 'success' | 'error') => void;
  /**
   * Convert a handler exception into a failure result, or return undefined to rethrow it.
   * Native Response/data() exceptions and errors in policy callbacks bypass this mapper.
   * The returned value becomes result.errors; this callback does not set an HTTP status.
   */
  mapError?: (error: unknown, context: ActionContext) => TError | undefined;
  /**
   * Return the value to throw for an invalid, unknown, or unsupported request.
   * Codes are invalid-request, unknown-intent, or unsupported-request. The default
   * is an empty 400 Response. Encoding errors at submission time bypass this callback.
   */
  invalidRequest?: (code: string, args: ActionFunctionArgs) => unknown;
};

/** Route-specific defaults and an optional native action for requests outside the protocol. */
export type ActionOptions<TError> = ActionDefaults<TError> & {
  /**
   * Called only when transport.decode returns undefined. Receives the original
   * action arguments and readable request; its result and errors pass through unchanged.
   * Malformed requests and unknown intents do not reach this fallback.
   */
  fallback?: (args: ActionFunctionArgs) => unknown;
};

/**
 * Native submit options applied to every submission from this hook, overriding
 * definition options. A submit callback's per-call options take precedence.
 * Set navigate: false to submit through a fetcher.
 */
export type UseActionsOptions = SubmitOptions & {
  /**
   * Use this fetcher's submit method for non-navigation submissions without an
   * explicit fetcherKey. A merged fetcherKey selects a keyed fetcher instead.
   * Without an injected fetcher or shared key, each hook owns an independent fetcher.
   */
  fetcher?: FetcherWithComponents<unknown>;
};

// Method syntax makes the generic constraint accept handlers with narrower inputs.
// The concrete handler signature still determines its public body and result types.
export type ActionHandler<TParams, TBody, TResult> = {
  call(params: TParams, body: TBody, request: Request, args: ActionFunctionArgs): TResult;
}['call'];

/**
 * A named handler with native SubmitOptions, optional notifications, and a redirect.
 * Definition submit options override factory/route defaults and are overridden by
 * hook and per-call options.
 */
export type ActionHandlerConfig<TParams, TBody, TResult> = SubmitOptions & {
  /**
   * Receives route params, the decoded body, the original readable Request, and the
   * complete ActionFunctionArgs. May return a value or promise. Validate business
   * input here: transport validation only checks the intent envelope.
   */
  handler: ActionHandler<TParams, TBody, TResult>;
  /**
   * Sent through notify after an ordinary success or mapped handler failure.
   * Native Response/data() results bypass notifications and configured redirects.
   */
  notification?: { success?: NotificationMessage; error?: NotificationMessage };
  /**
   * Redirect after an ordinary success. A callback receives params, the awaited
   * handler result, and Request; return undefined to keep the wrapped result.
   * Annotate its result parameter when using fields; compatibility with the
   * handler result is checked. Native results bypass this option.
   */
  redirect?:
    | string
    | {
        call(params: TParams, result: Awaited<TResult>, request: Request): string | undefined;
      }['call'];
};

type HandlerArgs<T> = T extends { handler: (...args: infer A) => unknown } ? A : never;
export type InferBody<T> = HandlerArgs<T> extends { 1?: infer B } ? B : undefined;
export type InferResult<T> = T extends { handler: (...args: never[]) => infer R }
  ? Awaited<R>
  : never;

// Check redirect inputs after handler inference so callbacks cannot widen the handler result.
export type CheckedRedirects<TParams, TConfig> = {
  [K in keyof TConfig]: TConfig[K] extends { redirect?: infer R }
    ? [R] extends [
        | string
        | ((
            params: TParams,
            result: InferResult<TConfig[K]>,
            request: Request
          ) => string | undefined)
        | undefined,
      ]
      ? unknown
      : { redirect: never }
    : unknown;
};

/**
 * One callback per intent, with body requiredness inferred from its handler.
 * Each accepts native per-call SubmitOptions and returns the router's completion
 * Promise<void>; read the action result from router state, not the promise.
 */
export type SubmitHandlers<TConfig> = {
  [K in keyof TConfig]: HandlerArgs<TConfig[K]> extends [unknown, unknown, ...unknown[]]
    ? (body: InferBody<TConfig[K]>, options?: SubmitOptions) => Promise<void>
    : (body?: InferBody<TConfig[K]>, options?: SubmitOptions) => Promise<void>;
};

/** An ordinary handler return value, tagged with its intent for result narrowing. */
export type ActionSuccess<TIntent, TData> = {
  type: 'action-result';
  intent: TIntent;
  success: true;
  data: TData;
};
/** A handler exception converted by mapError; errors has the configured application type. */
export type ActionFailure<TIntent, TError> = {
  type: 'action-result';
  intent: TIntent;
  success: false;
  errors: TError;
};
type WrappedSuccess<K, T> = [Exclude<T, Response | NativeData>] extends [never]
  ? never
  : ActionSuccess<K, Exclude<T, Response | NativeData>>;
/** Union of wrapped successes and mapped failures. Native Response/data() values are excluded. */
export type ActionResult<TConfig, TError> = {
  [K in keyof TConfig]:
    | WrappedSuccess<K, InferResult<TConfig[K]>>
    | ([TError] extends [never] ? never : ActionFailure<K, TError>);
}[keyof TConfig];

// React Router serialization erases Response from unions. An arbitrary response
// can contain any payload, so expose unknown; data() keeps its inferred payload type.
type NativeResult<T> = unknown extends T
  ? unknown
  : T extends Response
    ? unknown
    : Extract<T, NativeData>;
type FallbackResult<T> = T extends Response ? unknown : T;
/**
 * Return type of the generated route action, including native and fallback results.
 * Returning an arbitrary Response makes native action-data inference unknown;
 * use data() when the response payload should retain its TypeScript type.
 */
export type RouteActionResult<TConfig, TError, TOptions> =
  | Response
  | ActionResult<TConfig, TError>
  | NativeResult<InferResult<TConfig[keyof TConfig]>>
  | (TOptions extends { fallback: (...args: never[]) => infer R }
      ? FallbackResult<Awaited<R>>
      : never);

export type RuntimeActionConfig = ActionHandlerConfig<
  ActionFunctionArgs['params'],
  unknown,
  unknown
>;
export type RuntimeActionResult<TError = unknown> =
  | ActionSuccess<string, unknown>
  | ActionFailure<string, TError>;

export function isActionResult(value: unknown): value is RuntimeActionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'action-result' &&
    'intent' in value &&
    typeof value.intent === 'string' &&
    'success' in value &&
    (value.success === true
      ? Object.hasOwn(value, 'data')
      : value.success === false && Object.hasOwn(value, 'errors'))
  );
}

// Explicit return types keep declaration emission from expanding the router hook types.
export type SubmissionState = {
  submit: Record<string, (body?: unknown, options?: SubmitOptions) => Promise<void>>;
  result: RuntimeActionResult | undefined;
  /** Raw selected router data, including native results, loader data, or another route's output. */
  data: unknown;
  /**
   * Recognized intents in submitting or loading state. Includes this hook's
   * navigations and observed fetchers; a native Form without submission metadata
   * is visible through navigation instead.
   */
  pending: import('./use-action-submission.js').PendingAction[];
  /** The unmodified useNavigation() result, including navigations outside this helper. */
  navigation: ReturnType<typeof useNavigation>;
  /**
   * The selected native fetcher, with Form, submit, load, reset, and data.
   * Read fetcher.data directly after using its native methods or Form.
   */
  fetcher: FetcherWithComponents<unknown>;
  isSubmitting: (intent?: string) => boolean;
};
/** Typed submissions and results alongside the native state exposed by useActions(). */
export type ActionState<TConfig, TError> = Omit<
  SubmissionState,
  'submit' | 'result' | 'isSubmitting'
> & {
  /** Submit a configured intent; use the second argument for per-call native options. */
  submit: SubmitHandlers<TConfig>;
  /**
   * Wrapped result from the latest helper submission's source. Before any helper
   * submission, prefers fetcher data over route action data. Native values are
   * excluded; this is a convenience selection, not a history of completed mutations.
   */
  result: ActionResult<TConfig, TError> | undefined;
  /** True during submission and subsequent loading; omit intent to check all pending intents. */
  isSubmitting: (intent?: keyof TConfig & string) => boolean;
};
/** The route action and its companion hook, created from a single set of intent definitions. */
export type RouteActions<TConfig, TError, TOptions> = {
  /** Register on a data-router route. Dispatches the decoded intent to its handler. */
  action: (args: ActionFunctionArgs) => Promise<RouteActionResult<TConfig, TError, TOptions>>;
  /**
   * Call within this data-router route to submit intents and observe their results.
   * Submissions navigate by default; use navigate: false for fetcher submissions.
   * Fetchers sharing a key also share state and React Router cancellation behavior.
   */
  useActions: (options?: UseActionsOptions) => ActionState<TConfig, TError>;
};

/** Infer handlers from named definitions and apply optional route-specific defaults. */
export type ActionBuilder<TParams, TError> = <
  TConfig extends Record<string, ActionHandlerConfig<TParams, unknown, unknown>>,
  TOptions extends ActionOptions<TError> = Record<never, never>,
>(
  config: TConfig & CheckedRedirects<TParams, NoInfer<TConfig>>,
  overrides?: TOptions & ActionOptions<TError>
) => RouteActions<TConfig, TError, TOptions>;

/**
 * Select route parameter types, then define intents: createActions<TParams>()(definitions).
 * TParams describes the route but performs no runtime validation of params or bodies.
 */
export type ActionFactory<TError> = <
  TParams extends ActionFunctionArgs['params'] = ActionFunctionArgs['params'],
>() => ActionBuilder<TParams, TError>;
