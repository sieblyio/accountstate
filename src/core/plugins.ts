import type {
  AccountView,
  InvariantViolation,
  ManagedOrderMetadata,
  NormalizedOrder,
} from './types.js';

export interface ManagedOrderParser {
  parse(order: NormalizedOrder): ManagedOrderMetadata | undefined;
}

export interface StateInvariant {
  name: string;
  severity: 'error' | 'warn';
  check(view: AccountView): InvariantViolation[];
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
