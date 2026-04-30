import { ExchangeAccountStateStore } from '../core/ExchangeAccountStateStore.js';
import type { AccountFact } from '../core/facts.js';
import type {
  AccountScope,
  AccountView,
  ChangeSet,
  InvariantViolation,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  PositionLifecycle,
  SyncRequest,
} from '../core/types.js';
import type {
  AccountStateFixture,
  FixtureExpectation,
  FixtureFailure,
  FixtureRunResult,
  RunAccountStateFixturesOptions,
} from './types.js';

export function createFixtureStore(): ExchangeAccountStateStore {
  return new ExchangeAccountStateStore();
}

export function runAccountStateFixtures(
  options: RunAccountStateFixturesOptions,
): FixtureRunResult[] {
  return options.fixtures.map((fixture) =>
    runAccountStateFixture(fixture, options.storeFactory),
  );
}

export function runAccountStateFixture(
  fixture: AccountStateFixture,
  storeFactory: RunAccountStateFixturesOptions['storeFactory'] = createFixtureStore,
): FixtureRunResult {
  const store = storeFactory(fixture);
  const failures: FixtureFailure[] = [];
  const changeSets: ChangeSet[] = [];

  try {
    for (const fact of fixture.initialFacts ?? []) {
      store.ingest(fact);
    }
    for (const fact of fixture.facts) {
      changeSets.push(store.ingest(fact));
    }

    const scope = inferFixtureScope(fixture);
    const account = store.getAccount(scope, fixture.accountOptions);
    const view = store.getAccountView(scope);
    const syncRequests = store.getSyncRequests(scope);
    const invariantViolations =
      fixture.invariantOptions === false
        ? []
        : store.checkInvariants(scope, fixture.invariantOptions);

    failures.push(
      ...evaluateExpectation(fixture.expect, {
        account,
        view,
        syncRequests,
        changeSets,
        invariantViolations,
      }),
    );

    return {
      fixture,
      passed: failures.length === 0,
      failures,
      changeSets,
      account,
      view,
      syncRequests,
      invariantViolations,
    };
  } catch (error) {
    failures.push({
      path: fixture.name,
      message: error instanceof Error ? error.message : String(error),
      actual: error,
    });

    return {
      fixture,
      passed: false,
      failures,
      changeSets,
    };
  }
}

function evaluateExpectation(
  expectation: FixtureExpectation,
  actual: {
    account: unknown;
    view: AccountView;
    syncRequests: SyncRequest[];
    changeSets: ChangeSet[];
    invariantViolations: InvariantViolation[];
  },
): FixtureFailure[] {
  const failures: FixtureFailure[] = [];

  if (expectation.account) {
    pushPartialFailure(
      failures,
      'account',
      actual.account,
      expectation.account,
    );
  }
  if (expectation.positions) {
    pushArrayFailures(
      failures,
      'positions',
      actual.view.positions,
      expectation.positions,
    );
  }
  if (expectation.openOrders) {
    pushArrayFailures(
      failures,
      'openOrders',
      actual.view.openOrders,
      expectation.openOrders,
    );
  }
  if (expectation.balances) {
    pushArrayFailures(
      failures,
      'balances',
      actual.view.balances,
      expectation.balances,
    );
  }
  if (expectation.fills) {
    pushArrayFailures(failures, 'fills', actual.view.fills, expectation.fills);
  }
  if (expectation.lifecycles) {
    pushArrayFailures(
      failures,
      'lifecycles',
      actual.view.lifecycles,
      expectation.lifecycles,
    );
  }
  if (expectation.confidence) {
    pushPartialFailure(
      failures,
      'confidence',
      actual.view.confidence,
      expectation.confidence,
    );
  }
  if (expectation.syncRequests) {
    pushArrayFailures(
      failures,
      'syncRequests',
      actual.syncRequests,
      expectation.syncRequests,
    );
  }
  if (expectation.changeSets) {
    pushArrayFailures(
      failures,
      'changeSets',
      actual.changeSets,
      expectation.changeSets,
    );
  }
  if (expectation.invariantViolations) {
    pushArrayFailures(
      failures,
      'invariantViolations',
      actual.invariantViolations,
      expectation.invariantViolations,
    );
  }

  return failures;
}

function pushPartialFailure(
  failures: FixtureFailure[],
  path: string,
  actual: unknown,
  expected: unknown,
): void {
  if (!matchesPartial(actual, expected)) {
    failures.push({
      path,
      message: 'Expected actual value to include the partial fixture shape.',
      expected,
      actual,
    });
  }
}

function pushArrayFailures<TActual, TExpected>(
  failures: FixtureFailure[],
  path: string,
  actual: TActual[],
  expected: TExpected[],
): void {
  if (actual.length !== expected.length) {
    failures.push({
      path,
      message: `Expected ${expected.length} row(s), received ${actual.length}.`,
      expected,
      actual,
    });
    return;
  }

  const unmatched = new Set(actual.map((_, index) => index));
  for (const [expectedIndex, expectedRow] of expected.entries()) {
    const matchIndex = Array.from(unmatched).find((actualIndex) =>
      matchesPartial(actual[actualIndex], expectedRow),
    );
    if (matchIndex === undefined) {
      failures.push({
        path: `${path}[${expectedIndex}]`,
        message: 'Expected row was not found in the actual result.',
        expected: expectedRow,
        actual,
      });
      continue;
    }
    unmatched.delete(matchIndex);
  }
}

function matchesPartial(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }
    return expected.every((expectedItem, index) =>
      matchesPartial(actual[index], expectedItem),
    );
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return false;
    }
    return Object.entries(expected).every(([key, expectedValue]) =>
      matchesPartial((actual as Record<string, unknown>)[key], expectedValue),
    );
  }

  return Object.is(actual, expected);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inferFixtureScope(fixture: AccountStateFixture): AccountScope {
  const firstFact = [...(fixture.initialFacts ?? []), ...fixture.facts][0];
  if (!firstFact) {
    throw new Error(`Fixture "${fixture.name}" has no facts to infer scope.`);
  }

  return firstFact.scope;
}

export type {
  AccountFact,
  AccountScope,
  ChangeSet,
  InvariantViolation,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  PositionLifecycle,
  SyncRequest,
};
