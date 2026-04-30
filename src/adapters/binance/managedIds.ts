import type { ManagedOrderParser } from '../../core/plugins.js';
import type {
  ManagedOrderMetadata,
  NormalizedOrder,
} from '../../core/types.js';

export type BinanceManagedClientIdParser = (
  clientId: string,
  order: NormalizedOrder,
) => ManagedOrderMetadata | undefined;

/**
 * Build a store parser for app-specific metadata encoded in Binance regular
 * `clientOrderId` and trigger-order `clientAlgoId` values.
 */
export function createBinanceManagedOrderParser(
  parseClientId: BinanceManagedClientIdParser,
): ManagedOrderParser {
  return {
    parse(order: NormalizedOrder): ManagedOrderMetadata | undefined {
      const clientId = order.customClientOrderId ?? order.customTriggerOrderId;
      return clientId ? parseClientId(clientId, order) : undefined;
    },
  };
}
