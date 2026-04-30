import type { AccountScope } from './types.js';

export function createScopeKey(scope: AccountScope): string {
  return [
    scope.exchange,
    scope.accountId,
    scope.product,
    scope.environment ?? '',
  ].join(':');
}

export function isSameScope(a: AccountScope, b: AccountScope): boolean {
  return createScopeKey(a) === createScopeKey(b);
}

export function copyScope(scope: AccountScope): AccountScope {
  return { ...scope };
}
