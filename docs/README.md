# Accountstate Docs

Start here if you are new to `accountstate`.

Most applications should read these in order:

1. [Exchange account store](./core/exchange-account-state-store.md) - the main
   API for new REST-plus-WebSocket integrations.
2. [Private event routing](./core/private-event-routing.md) - how adapter route
   helpers separate store updates from application workflow decisions.
3. [Position manager workflow](./workflows/position-manager.md) - the
   recommended flow for TP/SL/DCA managers and other apps that submit orders.

Then choose the exchange adapter you use:

- [Binance adapter](./adapters/binance.md)
- [Binance USD-M integration playbook](./adapters/binance-usdm-playbook.md)
- [Bybit adapter](./adapters/bybit.md)

Reference docs:

- [Pending confirmation lifecycle](./workflows/pending-confirmation-lifecycle.md)
- [Conformance fixtures](./testing/conformance.md)
- [Position manager conformance](./testing/position-manager-conformance.md)
- [Legacy lightweight store](./legacy/account-state-store.md)

## Folder Layout

- `core/`: exchange-agnostic store behavior and event routing.
- `workflows/`: application patterns that use the store.
- `adapters/`: exchange-specific adapter behavior and playbooks.
- `testing/`: fixture and conformance patterns.
- `legacy/`: the older direct-cache `AccountStateStore` API.
