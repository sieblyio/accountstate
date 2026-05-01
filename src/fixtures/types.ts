import type { ExchangeAccountStateStore } from '../core/ExchangeAccountStateStore.js';
import type { AccountFact } from '../core/facts.js';
import type { CheckInvariantsOptions } from '../core/invariants.js';
import type {
  AccountView,
  AccountViewConfidence,
  ChangeSet,
  InvariantViolation,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  PositionLifecycle,
  StateCheck,
} from '../core/types.js';
import type {
  ExchangeAccount,
  ExchangeAccountReadinessOptions,
} from '../core/exchangeAccount.js';

export interface AccountStateFixture {
  name: string;
  description?: string;
  initialFacts?: AccountFact[];
  facts: AccountFact[];
  accountOptions?: ExchangeAccountReadinessOptions;
  invariantOptions?: CheckInvariantsOptions | false;
  expect: FixtureExpectation;
}

export interface FixtureExpectation {
  account?: FixturePartial<ExchangeAccount>;
  positions?: FixturePartial<NormalizedPosition>[];
  openOrders?: FixturePartial<NormalizedOrder>[];
  balances?: FixturePartial<NormalizedBalance>[];
  fills?: FixturePartial<NormalizedFill>[];
  lifecycles?: FixturePartial<PositionLifecycle>[];
  confidence?: FixturePartial<AccountViewConfidence>;
  stateChecks?: FixturePartial<StateCheck>[];
  changeSets?: FixturePartial<ChangeSet>[];
  invariantViolations?: FixturePartial<InvariantViolation>[];
}

export type FixturePartial<T> = T extends readonly (infer TItem)[]
  ? FixturePartial<TItem>[]
  : T extends object
    ? { [TKey in keyof T]?: FixturePartial<T[TKey]> }
    : T;

export interface FixtureFailure {
  path: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface FixtureRunResult {
  fixture: AccountStateFixture;
  passed: boolean;
  failures: FixtureFailure[];
  changeSets: ChangeSet[];
  account?: ExchangeAccount;
  view?: AccountView;
  stateChecks?: StateCheck[];
  invariantViolations?: InvariantViolation[];
}

export interface RunAccountStateFixturesOptions {
  fixtures: AccountStateFixture[];
  storeFactory?: (fixture: AccountStateFixture) => ExchangeAccountStateStore;
}
