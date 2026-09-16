import type { ActionFunctionArgs } from 'react-router';
import type {
  ActionBuilder,
  ActionDefaults,
  ActionFactory,
  ActionHandlerConfig,
  ActionOptions,
  ActionResult,
  ActionState,
  CheckedRedirects,
  RouteActionResult,
  RouteActions,
  SubmitHandlers,
  UseActionsOptions,
} from './action-types.js';
import { createRouteAction } from './execute-action.js';
import { useActionSubmission } from './use-action-submission.js';

export type { ActionDefaults, ActionHandlerConfig, UseActionsOptions } from './action-types.js';

/**
 * Create a reusable action builder with shared submission, error, and notification defaults.
 *
 * Call the returned function as `createActions<TParams>()(definitions, overrides?)`.
 * Each definition's key becomes an intent; its handler determines the submission body
 * and result types. The result contains a React Router `action` and a `useActions` hook
 * for typed submissions, results, pending state, and access to the native router APIs.
 *
 * Route overrides replace factory defaults; their `submit` options are merged.
 * With no defaults configured, submissions use POST/JSON, notifications have no side effects,
 * and handler errors reach the route error boundary. Returned or thrown `Response`
 * and `data()` values keep their native behavior and bypass error mapping,
 * notifications, and configured redirects.
 *
 * @typeParam TError - The failure value returned by `mapError`. Defaults to `never`:
 * no typed failure result is produced unless an error mapper handles the error.
 * @param defaults - Shared options captured by this factory, without global state.
 * @returns A builder that can define actions for any number of routes.
 *
 * @example
 * const createActions = createActionFactory<string[]>({
 *   mapError: (error) => error instanceof RangeError ? [error.message] : undefined,
 * });
 * const actions = createActions<{ projectId: string }>()({
 *   rename: {
 *     handler: (params, body: { name: string }) => ({
 *       id: params.projectId,
 *       name: body.name,
 *     }),
 *   },
 * });
 * // Register actions.action on the route; call actions.useActions() in its component.
 */
export function createActionFactory<TError = never>(
  defaults: ActionDefaults<TError> = {}
): ActionFactory<TError> {
  return function createActions<
    TParams extends ActionFunctionArgs['params'] = ActionFunctionArgs['params'],
  >(): ActionBuilder<TParams, TError> {
    const define = <
      TConfig extends Record<string, ActionHandlerConfig<TParams, unknown, unknown>>,
      TOptions extends ActionOptions<TError> = Record<never, never>,
    >(
      config: TConfig & CheckedRedirects<TParams, NoInfer<TConfig>>,
      overrides?: TOptions & ActionOptions<TError>
    ): RouteActions<TConfig, TError, TOptions> => {
      const options = {
        ...defaults,
        ...overrides,
        submit: { ...defaults.submit, ...overrides?.submit },
      };
      // Runtime dispatch uses string keys and unknown values. Restore the relationship
      // between each intent and its inferred result, including native/fallback values.
      const action = createRouteAction(config, options) as (
        args: ActionFunctionArgs
      ) => Promise<RouteActionResult<TConfig, TError, TOptions>>;

      function useActions(hookOptions?: UseActionsOptions): ActionState<TConfig, TError> {
        const state = useActionSubmission(config, options, hookOptions);
        return {
          ...state,
          submit: state.submit as SubmitHandlers<TConfig>,
          result: state.result as ActionResult<TConfig, TError> | undefined,
          isSubmitting: state.isSubmitting as (intent?: keyof TConfig & string) => boolean,
        };
      }
      return { action, useActions };
    };
    // Re-inferring TConfig here also infers CheckedRedirects as configuration.
    // Keep the declared signature, whose redirect compatibility is checked at the call site.
    return define as ActionBuilder<TParams, TError>;
  };
}

/**
 * Define named actions for a data-router route using POST/JSON submission defaults.
 *
 * Call as `createActions<TParams>()(definitions, options?)`. Register the returned
 * `action` on the route and call `useActions()` in a component within that route.
 * Handler signatures infer the bodies accepted by `submit.<intent>` and the
 * discriminated `result` type. Parameter types do not validate runtime input.
 *
 * Errors propagate to React Router by default. Use {@link createActionFactory}
 * to configure a typed error mapper or share defaults across routes.
 *
 * @example
 * const actions = createActions<{ id: string }>()({
 *   rename: { handler: (params, body: { name: string }) => ({ id: params.id, ...body }) },
 *   archive: { handler: (params) => ({ archivedId: params.id }) },
 * });
 * // In the route component: const { submit, result, isSubmitting } = actions.useActions();
 */
export const createActions: ActionFactory<never> = createActionFactory();
