# Entity Events

Small examples that print entity changes returned by `accountstate`.

## Position Changes

`position-entity-changes.ts` feeds synthetic position updates into
`ExchangeAccountStateStore` and logs each returned position change:

- `position_opened`
- `position_quantity_increased`
- `position_quantity_decreased`
- `position_updated`
- `position_closed`

For the workflow and event shape, see
[Position entity events](../../docs/entityEvents/positionEntityEvents.md).

Run it from the repo root:

```bash
npm run build
cd examples
npx ts-node --esm entityEvents/position-entity-changes.ts
```
