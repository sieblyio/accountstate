import type {
  AccountScope,
  AccountView,
  InvariantViolation,
  ManagedOrderMetadata,
  NormalizedOrder,
} from './types.js';

export interface ManagedOrderParser {
  parse(order: NormalizedOrder): ManagedOrderMetadata | undefined;
}

/**
 * One custom invariant result. Missing name, severity, or scope values are
 * filled from the registered invariant and checked account view.
 */
export interface StateInvariantResult {
  message: string;
  name?: string;
  severity?: InvariantViolation['severity'];
  scope?: AccountScope;
  context?: Record<string, unknown>;
}

/**
 * Project-specific account-state health check.
 */
export interface StateInvariant {
  name: string;
  severity?: InvariantViolation['severity'];
  check(view: AccountView): StateInvariantResult[];
}

export interface ComparisonContext {
  decimalTolerance?: string;
  nowMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ComparisonResult {
  equivalent: boolean;
  reason?: string;
  differences?: string[];
}

export interface OrderComparisonPolicy {
  name: string;
  applies(desired: NormalizedOrder, active: NormalizedOrder): boolean;
  equivalent(
    desired: NormalizedOrder,
    active: NormalizedOrder,
    context: ComparisonContext,
  ): ComparisonResult;
}
