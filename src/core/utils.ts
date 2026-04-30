import type { AccountScope } from './types.js';

/**
 * Build the internal storage key for one account/product/environment scope.
 */
export function createScopeKey(scope: AccountScope): string {
  return [
    scope.exchange,
    scope.accountId,
    scope.product,
    scope.environment ?? '',
  ].join(':');
}

/**
 * Compare account scopes by the same fields used for reducer storage.
 */
export function isSameScope(a: AccountScope, b: AccountScope): boolean {
  return createScopeKey(a) === createScopeKey(b);
}

/**
 * Clone a scope before returning it from a view or change set.
 */
export function copyScope(scope: AccountScope): AccountScope {
  return { ...scope };
}
