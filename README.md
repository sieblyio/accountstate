# TypeScript Account State Store for Trading Applications

[![Build & Test](https://github.com/tiagosiebler/accountstate/actions/workflows/test.yml/badge.svg)](https://github.com/tiagosiebler/accountstate/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/accountstate)][1]
[![npm size](https://img.shields.io/bundlephobia/min/accountstate/latest)][1]
[![npm downloads](https://img.shields.io/npm/dt/accountstate)][1]
[![last commit](https://img.shields.io/github/last-commit/tiagosiebler/accountstate)][1]
[![Telegram](https://img.shields.io/badge/chat-on%20telegram-blue.svg)](https://t.me/nodetraders)

[1]: https://www.npmjs.com/package/accountstate

A TypeScript in-memory account state store for crypto exchange applications.
Feed it the REST snapshots and private WebSocket account events your app already
receives, then query one current account view for positions, open orders,
balances, fills, readiness, and state checks.

## Table of Contents

- [What It Tracks](#what-it-tracks)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Using Exchange Adapters](#using-exchange-adapters)
- [Core Concepts](#core-concepts)
- [Advanced Usage](#advanced-usage)
- [Docs](#docs)
- [Legacy Lightweight Store](#legacy-lightweight-store)
- [Running Examples](#running-examples)
- [Contributions & Thanks](#contributions--thanks)
- [License](#license)

## What It Tracks

`accountstate` keeps one in-memory view of the exchange account state you feed
into it:

- **Positions** from REST snapshots and private WebSocket position updates.
- **Open orders** from REST open-order snapshots, live order updates, accepted
  submissions, cancel responses, and unknown-order evidence.
- **Balances** from REST balance snapshots and private WebSocket balance
  updates.
- **Fills/trades** from REST trade history or private WebSocket execution
  events.
- **Readiness** through `readyToTrade`, trust flags, and actionable
  `stateChecks`.
- **Exchange adapter payloads** through subpaths such as `accountstate/binance`
  and `accountstate/bybit`, so raw REST responses and private WebSocket events
  can be passed into the store.
- **Advanced ownership metadata** when your app registers a parser for its own
  custom order IDs.

The store is intentionally exchange-client agnostic. You can map exchange data
yourself, or use an exchange-specific adapter to pass raw REST responses and
private WebSocket events into the store as your client receives them.
`accountstate` keeps the current account view coherent either way.

## Installation

```bash
npm install accountstate
# or
yarn add accountstate
```

Exchange adapter subpaths may have optional peer dependencies. Install the SDK
for the adapter you import, if you haven't already:

```bash
# Binance
npm install accountstate binance

# Bybit
npm install accountstate bybit-api
```

## Quick Start

Most exchange applications already have two feeds into account state:

- REST responses for the latest account snapshot.
- Private WebSocket account events for live changes.

`ExchangeAccountStateStore` is designed around that shape. Your app owns the
REST clients, WebSocket clients, API keys, reconnects, retries, and scheduling.
`accountstate` only stores and reconciles account-state data you give it.

```typescript
import { ExchangeAccountStateStore, type AccountScope } from 'accountstate';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'mainnet',
};

const state = new ExchangeAccountStateStore();

// Initial and periodic REST snapshots.
state.setPositions(scope, normalizedPositions);
state.setOpenOrders(scope, normalizedOpenOrders);
state.setBalances(scope, normalizedBalances);

// Private WebSocket updates.
state.applyOrderUpdate(scope, normalizedOrderUpdate);
state.applyPositionUpdate(scope, normalizedPositionUpdate);
state.applyBalanceUpdate(scope, normalizedBalanceUpdate);

// Reconnects or known stream gaps mark state that should be checked via REST.
state.recordStreamReconnected(scope, {
  reason: 'private WebSocket stream restarted',
});

const account = state.getAccount(scope); // current account view

if (!account.readyToTrade) {
  for (const check of account.stateChecks) {
    await checkStateFromRest(check);
  }
  return;
}

planner.plan(account);
```

The common query methods are intentionally direct:

```typescript
const positions = state.getPositions(scope);
const openOrders = state.getOpenOrders(scope, { symbol: 'BTCUSDT' });
const order = state.getOrder(scope, { customOrderId: 'my-order-id' });
const balance = state.getBalance(scope, 'USDT');
```

Positions, open orders, and balances are required for `readyToTrade`. Fills are
refreshed in the background unless you call
`getAccount(scope, { requireFills: true })`.

## Using Exchange Adapters

Adapters let you pass raw exchange SDK/API objects directly into the store. The
adapter normalizes the exchange-specific shape; `ingest()` applies the resulting
updates in order. Your app can still map normalized rows itself, or use one of
the exchange-specific adapters as the place where raw REST responses and private
WebSocket events are passed in as your client receives them.

```typescript
import { ExchangeAccountStateStore, type AccountScope } from 'accountstate';
import { binance } from 'accountstate/binance';

const state = new ExchangeAccountStateStore();
const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'mainnet',
};

state.ingest(binance.rest.positions(scope, rawPositionRows));
state.ingest(binance.rest.openOrders(scope, rawOpenOrderRows));
state.ingest(binance.rest.openAlgoOrders(scope, rawOpenAlgoOrderRows));
state.ingest(binance.rest.accountBalances(scope, rawAccountAssetRows));
state.ingest(binance.rest.accountTrades(scope, rawTradeRows));
state.ingest(binance.ws.privateEvent(scope, rawPrivateWebSocketEvent));

const account = state.getAccount(scope);
```

The Bybit V5 linear adapter follows the same shape:

```typescript
import { bybit } from 'accountstate/bybit';

state.ingest(bybit.rest.positions(scope, positionResponse.result.list));
state.ingest(bybit.rest.activeOrders(scope, activeOrdersResponse.result.list));
state.ingest(bybit.rest.walletBalances(scope, walletResponse.result.list));
state.ingest(bybit.ws.privateEvent(scope, rawPrivateEvent));
```

For Binance USD-M private WebSocket events, `binance.ws.privateEvent()` handles
`ACCOUNT_UPDATE` balance/position updates, `ORDER_TRADE_UPDATE` order/fill
updates, Algo updates, and lightweight trade events. When an Algo order
triggers, Binance emits normal order updates for the generated order; the
adapter keeps that regular order separate from the terminal Algo row.

Adapters also expose `ws.summarizePrivateEvent(event)` when you want a small
pure summary for logging or event coalescing before ingesting the event. It
returns affected subjects, symbols, assets, and order IDs, but it does not
schedule work or make recovery decisions.

Adapters are pure: they do not create REST clients, WebSocket clients, timers,
retries, API keys, or stream sessions. They only accept objects you already
received from the exchange SDK/API and return account-state updates.
Submission outcome helpers follow the same rule: they translate responses or
errors your app already received, but never submit, cancel, retry, or call the
exchange.

REST balance responses are exchange-specific. Binance USD-M and Bybit V5 linear
have adapter helpers for their common account balance responses. If an adapter
does not expose a helper for the balance endpoint you use, map the response into
`NormalizedBalance[]` and call `setBalances()`.

## Core Concepts

- `setPositions`, `setOpenOrders`, `setBalances`, and `setFills` write
  current-state snapshots, usually from REST.
- `applyPositionUpdate`, `applyOrderUpdate`, `applyBalanceUpdate`, and
  `applyFill` apply private WebSocket updates.
- `recordStreamConnected`, `recordStreamReconnected`,
  `recordStreamDisconnected`, and `recordStreamGap` record private WebSocket
  stream health; reconnects, disconnects, and gaps add REST-backed state checks.
- `recordOrderAccepted`, `recordOrderRejected`, `recordOrderStatusUnknown`,
  `recordOrderCancelled`, and `recordOrderNotFound` record order submission
  outcomes.
- `getAccount(scope)` returns the normal app read model: current state,
  `readyToTrade`, and actionable `stateChecks`.

Method names follow the data flow: `set*` writes a current snapshot, `apply*`
applies a WebSocket update already received by your app, `record*` records an
observed fact or outcome, and `get*` reads the store.

If your custom order IDs include strategy ownership metadata, register a small
parser once:

```typescript
state.registerManagedOrderParser({
  parse(order) {
    const customId = order.customOrderId ?? order.customTriggerOrderId;
    return customId ? parseMyManagedOrderId(customId) : undefined;
  },
});
```

For simple in-memory managers, keep exchange-visible custom order IDs as app
ownership and slot tags only. Do not encode lifecycle or replacement state into
those IDs unless your application also persists that strategy state and has
restart tests proving that adoption path.

## Advanced Usage

Most applications should not need reducer facts or snapshot internals. For
adapter authors, replay tools, fixture runners, and debugging lower-level state
transitions:

- `ingest()` accepts adapter/conformance facts.
- `getAccountView()` returns the detailed reducer view.
- `getStateChecks()` returns REST-backed state checks without the simplified
  account read model.
- `accountstate/core` exports fact and reducer types.
- `accountstate/conformance` exports generic fixture runners.

```typescript
import {
  defaultAccountStateFixtures,
  runAccountStateFixtures,
} from 'accountstate/conformance';

const results = runAccountStateFixtures({
  fixtures: defaultAccountStateFixtures,
});
```

Use invariants as a read-only health check in tests, startup checks, or before
trading logic runs:

```typescript
const violations = state.checkInvariants(scope);
if (violations.some((violation) => violation.severity === 'error')) {
  throw new Error('Account state is not ready for trading decisions');
}
```

## Docs

- [Exchange account store](./docs/exchange-account-state-store.md)
- [Position manager workflow pattern](./docs/position-manager-workflow.md)
- [Binance adapter](./docs/adapters/binance.md)
- [Bybit adapter](./docs/adapters/bybit.md)
- [Binance USD-M integration playbook](./docs/integration-playbook-binance-usdm.md)
- [Conformance fixtures](./docs/conformance.md)
- [Legacy lightweight store](./docs/legacy-account-state-store.md)

## Legacy Lightweight Store

The original `AccountStateStore` direct-cache API remains available from the
package root for existing integrations. It has direct setters/getters for
wallet balance, positions, orders, leverage, price updates, and per-symbol
metadata.

For new REST-plus-WebSocket exchange integrations, prefer
`ExchangeAccountStateStore`. See
[Legacy lightweight store](./docs/legacy-account-state-store.md) when
maintaining an older integration or using the metadata persistence helpers.

## Running Examples

The recommended examples for new exchange integrations use
`ExchangeAccountStateStore`. The exchange-account API is documented in
[Exchange account store](./docs/exchange-account-state-store.md). For live
TP/SL/DCA or position-management applications, start with the
[position manager workflow pattern](./docs/position-manager-workflow.md).
Adapter docs are available for [Binance](./docs/adapters/binance.md) and
[Bybit](./docs/adapters/bybit.md). The Binance startup, WebSocket, and reconnect
workflow is documented in
[Binance USD-M integration playbook](./docs/integration-playbook-binance-usdm.md).

### Binance Futures

1. Create `.env` file:

   ```
   BINANCE_API_KEY=your_api_key
   BINANCE_API_SECRET=your_api_secret
   ```

2. Run example:
   ```bash
   tsx examples/binance-usdm-exchange-account-state.ts
   ```

The older `examples/binance-futures-usdm.ts` file demonstrates the legacy
`AccountStateStore` API. Use the exchange-account example above for new
exchange integrations.

### Bybit Futures

1. Create `.env` file:

   ```
   BYBIT_API_KEY=your_api_key
   BYBIT_API_SECRET=your_api_secret
   ```

2. Run example:
   ```bash
   tsx examples/bybit-v5-linear-exchange-account-state.ts
   ```

The older `examples/bybit-futures.ts` file demonstrates the legacy
`AccountStateStore` API. Use the exchange-account example above for new
Bybit integrations.

The modern exchange-account examples demonstrate:

- Loading current account state from REST.
- Applying private WebSocket account events.
- Recording reconnects and checking stale state through REST.
- Querying one current account view for planner/UI decisions.
- Showing where observed submit/cancel outcomes enter the store.

<!-- template_contributions -->

## Contributions & Thanks

Have my projects helped you? Share the love, there are many ways you can show your thanks:

- Star & share my projects.
- Are my projects useful? Sponsor me on Github and support my effort to maintain & improve them: https://github.com/sponsors/tiagosiebler
- Have an interesting project? Get in touch & invite me to it.
- Or buy me all the coffee:
  - ETH(ERC20): `0xA3Bda8BecaB4DCdA539Dc16F9C54a592553Be06C` <!-- metamask -->

<!-- template_contributions_end -->

### Contributions & Pull Requests

Contributions are encouraged, I will review any incoming pull requests. See the issues tab for todo items.

<!-- template_related_projects -->

## Related projects

Check out my related JavaScript/TypeScript/Node.js projects:

- Try my REST API & WebSocket SDKs:
  - [Bybit-api Node.js SDK](https://www.npmjs.com/package/bybit-api)
  - [Okx-api Node.js SDK](https://www.npmjs.com/package/okx-api)
  - [Binance Node.js SDK](https://www.npmjs.com/package/binance)
  - [Gateio-api Node.js SDK](https://www.npmjs.com/package/gateio-api)
  - [Bitget-api Node.js SDK](https://www.npmjs.com/package/bitget-api)
  - [Kucoin-api Node.js SDK](https://www.npmjs.com/package/kucoin-api)
  - [Coinbase-api Node.js SDK](https://www.npmjs.com/package/coinbase-api)
  - [Bitmart-api Node.js SDK](https://www.npmjs.com/package/bitmart-api)
- Try my misc utilities:
  - [OrderBooks Node.js](https://www.npmjs.com/package/orderbooks)
  - [Crypto Exchange Account State Cache](https://www.npmjs.com/package/accountstate)
- Check out my examples:
  - [awesome-crypto-examples Node.js](https://github.com/tiagosiebler/awesome-crypto-examples)
  <!-- template_related_projects_end -->

<!-- template_star_history -->

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=tiagosiebler/bybit-api,tiagosiebler/okx-api,tiagosiebler/binance,tiagosiebler/bitget-api,tiagosiebler/bitmart-api,tiagosiebler/gateio-api,tiagosiebler/kucoin-api,tiagosiebler/coinbase-api,tiagosiebler/orderbooks,tiagosiebler/accountstate,tiagosiebler/awesome-crypto-examples&type=Date)](https://star-history.com/#tiagosiebler/bybit-api&tiagosiebler/okx-api&tiagosiebler/binance&tiagosiebler/bitget-api&tiagosiebler/bitmart-api&tiagosiebler/gateio-api&tiagosiebler/kucoin-api&tiagosiebler/coinbase-api&tiagosiebler/orderbooks&tiagosiebler/accountstate&tiagosiebler/awesome-crypto-examples&Date)

<!-- template_star_history_end -->

## License

MIT License - see LICENSE file for details.
