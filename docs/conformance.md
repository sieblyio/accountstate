# Conformance Fixtures

The conformance helpers are for adapter authors and test suites. They run
fixture-defined account-state facts through `ExchangeAccountStateStore` and
compare the resulting account state with expected output.

They are not required for normal application usage.

## Run The Default Fixtures

```typescript
import {
  defaultAccountStateFixtures,
  runAccountStateFixtures,
} from 'accountstate/conformance';

const results = runAccountStateFixtures({
  fixtures: defaultAccountStateFixtures,
});

for (const result of results) {
  if (!result.passed) {
    console.error(result.fixture.name, result.failures);
  }
}
```

## Run Binance Fixtures

```typescript
import { binanceAccountStateFixtures } from 'accountstate/binance';
import { runAccountStateFixtures } from 'accountstate/conformance';

const results = runAccountStateFixtures({
  fixtures: binanceAccountStateFixtures,
});
```

## Fixture Shape

```typescript
import type { AccountStateFixture } from 'accountstate/conformance';

const fixture: AccountStateFixture = {
  name: 'example-open-order',
  facts: [
    // Usually adapter output, such as binance.rest.openOrders(scope, rows).
  ],
  expect: {
    openOrders: [
      {
        symbol: 'BTCUSDT',
        status: 'new',
      },
    ],
  },
};
```

Expectations are partial. You only need to assert the fields that matter for the
behavior under test.

## When To Use This

Use conformance fixtures when:

- writing a new exchange adapter
- adding coverage for a newly observed exchange event
- checking replay behavior
- protecting subtle account-state rules during refactors

For normal application code, use `ExchangeAccountStateStore` directly.

