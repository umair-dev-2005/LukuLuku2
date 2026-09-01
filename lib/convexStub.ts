// Local stand-in for `convex/react` and `convex/_generated/api`.
// This project was exported without a Convex deployment, so the hooks
// resolve to no-ops: queries stay `undefined` (callers already treat that
// as "feature off") and mutations/actions reject if something tries to
// reach the missing backend.

type AnyFn = (...args: unknown[]) => unknown;

export function useQuery(_fn?: unknown, ..._args: unknown[]): undefined {
  return undefined;
}

export function useMutation(_fn?: unknown): AnyFn {
  return async () => {
    throw new Error('Convex backend is not configured in this build.');
  };
}

export function useAction(_fn?: unknown): AnyFn {
  return async () => {
    throw new Error('Convex backend is not configured in this build.');
  };
}

const anyRef: any = new Proxy(() => undefined, {
  get: () => anyRef,
  apply: () => undefined,
});

export const api: any = anyRef;
