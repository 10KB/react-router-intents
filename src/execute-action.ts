import { type ActionFunctionArgs, redirect, data as routerData } from 'react-router';
import {
  type ActionPayload,
  ActionRequestError,
  defaultActionTransport,
} from './action-transport.js';
import type {
  ActionOptions,
  NativeData,
  NotificationMessage,
  RuntimeActionConfig,
} from './action-types.js';

// React Router has no public data() predicate. Use its public factory to obtain
// the constructor without depending on an UNSAFE export or duplicating its shape.
const DataResult = routerData(null).constructor;
const isNativeData = (value: unknown): value is NativeData => value instanceof DataResult;

// Keep request decoding and execution separate from hook state and type inference.
export function createRouteAction<TError>(
  config: Record<string, RuntimeActionConfig>,
  options: ActionOptions<TError>
) {
  const transport = options.transport ?? defaultActionTransport;
  const notify = (message: NotificationMessage | undefined, variant: 'success' | 'error') => {
    if (!options.notify || message === undefined) return;
    options.notify(typeof message === 'function' ? message() : message, variant);
  };
  const invalidRequest = (code: string, args: ActionFunctionArgs): never => {
    throw options.invalidRequest
      ? options.invalidRequest(code, args)
      : new Response(null, { status: 400 });
  };

  return async (args: ActionFunctionArgs): Promise<unknown> => {
    let payload: ActionPayload | undefined;
    try {
      // Decode a clone so handlers and native actions can still read the request.
      payload = await transport.decode(args.request.clone());
    } catch (error) {
      if (error instanceof ActionRequestError) return invalidRequest(error.code, args);
      throw error;
    }
    if (!payload) {
      if (options.fallback) return options.fallback(args);
      return invalidRequest('unsupported-request', args);
    }
    const { intent, body } = payload;
    const definition = Object.hasOwn(config, intent) ? config[intent] : undefined;
    if (!definition) return invalidRequest('unknown-intent', args);

    let value: unknown;
    try {
      value = await definition.handler(args.params, body, args.request, args);
    } catch (error) {
      if (error instanceof Response || isNativeData(error)) throw error;
      const errors = options.mapError?.(error, { ...args, intent });
      if (errors === undefined) throw error;
      notify(definition.notification?.error, 'error');
      return { type: 'action-result', intent, success: false, errors };
    }

    // Return before policy callbacks: native results own status, headers, and redirects.
    if (value instanceof Response || isNativeData(value)) return value;
    notify(definition.notification?.success, 'success');
    const target =
      typeof definition.redirect === 'function'
        ? definition.redirect(args.params, value, args.request)
        : definition.redirect;
    return target
      ? redirect(target)
      : { type: 'action-result', intent, success: true, data: value };
  };
}
