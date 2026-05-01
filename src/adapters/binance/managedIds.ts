import type { ManagedOrderParser } from '../../core/plugins.js';
import type {
  ManagedOrderMetadata,
  NormalizedOrder,
} from '../../core/types.js';

export type BinanceManagedOrderIdParser = (
  customId: string,
  order: NormalizedOrder,
) => ManagedOrderMetadata | undefined;

/**
 * Build a store parser for app-specific metadata encoded in Binance regular
 * `clientOrderId` and trigger-order `clientAlgoId` values.
 */
export function createBinanceManagedOrderParser(
  parseCustomId: BinanceManagedOrderIdParser,
): ManagedOrderParser {
  return {
    parse(order: NormalizedOrder): ManagedOrderMetadata | undefined {
      const customId = order.customOrderId ?? order.customTriggerOrderId;
      return customId ? parseCustomId(customId, order) : undefined;
    },
  };
}
