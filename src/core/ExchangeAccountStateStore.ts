import {
  getBalanceKey,
  getFillKey,
  getOrderKey,
  getPositionKey,
  ordersShareIdentity,
} from './indexes.js';
import type {
  AccountScope,
  AccountView,
  AccountViewConfidence,
  AccountWatermarks,
  ChangeSet,
  ConfidenceState,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  PositionLifecycle,
  SnapshotCoverage,
  SnapshotInput,
  SnapshotSubject,
  StateSource,
  SubjectWatermark,
} from './types.js';
import { copyScope, createScopeKey, isSameScope } from './utils.js';

interface ScopeState {
  positions: Map<string, NormalizedPosition>;
  openOrders: Map<string, NormalizedOrder>;
  balances: Map<string, NormalizedBalance>;
  fills: Map<string, NormalizedFill>;
  lifecycles: PositionLifecycle[];
  confidence: AccountViewConfidence;
  watermarks: AccountWatermarks;
}

interface ReplacementResult {
  terminal: number;
  stale: number;
}

type Row =
  | NormalizedPosition
  | NormalizedOrder
  | NormalizedBalance
  | NormalizedFill;

/**
 * Pure in-memory reducer for normalized exchange account facts.
 *
 * This class intentionally does not know how to connect to an exchange. The
 * parent application owns REST/WebSocket/submission work and feeds normalized
 * snapshots into this reducer.
 */
export class ExchangeAccountStateStore {
  private readonly scopes = new Map<string, ScopeState>();

  /**
   * Apply a normalized batch from a source such as REST, replay, test data, or
   * synthetic local state. Replacement modes make absent covered rows meaningful:
   * a missing position is terminal, while an absent app/provisional order stays
   * visible as stale until later phases can reconcile it explicitly.
   */
  applySnapshot(input: SnapshotInput<unknown>): ChangeSet {
    const state = this.getOrCreateScopeState(input.scope);
    const changeSet = createEmptyChangeSet(input.scope);
    const confidenceBefore = state.confidence;

    switch (input.subject) {
      case 'positions':
        this.applyRows(
          state.positions,
          input.rows,
          input,
          isNormalizedPosition,
          getPositionKey,
          (row) => this.isPositionCovered(row, input),
          changeSet,
        );
        break;
      case 'openOrders':
        this.applyRows(
          state.openOrders,
          input.rows,
          input,
          isNormalizedOrder,
          getOrderKey,
          (row) => this.isOrderCovered(row, input),
          changeSet,
          (collection, row) => this.findExistingOrderKey(collection, row),
          this.handleMissingOpenOrder,
        );
        break;
      case 'balances':
        this.applyRows(
          state.balances,
          input.rows,
          input,
          isNormalizedBalance,
          getBalanceKey,
          (row) => this.isBalanceCovered(row, input),
          changeSet,
        );
        break;
      case 'fills':
        this.applyRows(
          state.fills,
          input.rows,
          input,
          isNormalizedFill,
          getFillKey,
          (row) => this.isFillCovered(row, input),
          changeSet,
        );
        break;
      case 'filters':
        break;
    }

    const watermarksBefore = state.watermarks;
    state.watermarks = {
      ...state.watermarks,
      [input.subject]: createWatermark(input),
    };
    state.confidence = {
      ...state.confidence,
      [confidenceKeyForSubject(input.subject)]:
        changeSet.rowsStale > 0 ? 'stale' : confidenceFromSource(input.source),
    };

    changeSet.confidenceChanged = !isSameConfidence(
      confidenceBefore,
      state.confidence,
    );
    changeSet.changed =
      changeSet.changed ||
      changeSet.confidenceChanged ||
      !isSameWatermark(
        watermarksBefore[input.subject],
        state.watermarks[input.subject],
      );

    return changeSet;
  }

  /**
   * Return the current best local belief for a scope.
   *
   * The returned rows are clones so callers can plan from the view without
   * accidentally mutating reducer state between fact applications.
   */
  getAccountView(scope: AccountScope): AccountView {
    const state = this.getScopeState(scope);
    const confidence = state?.confidence ?? createInitialConfidence();
    const positions = state ? Array.from(state.positions.values()) : [];
    const openOrders = state ? Array.from(state.openOrders.values()) : [];
    const balances = state ? Array.from(state.balances.values()) : [];
    const fills = state ? Array.from(state.fills.values()) : [];
    const hydrationReasons = getHydrationReasons(confidence, openOrders);

    return {
      scope: copyScope(scope),
      positions: positions.map(clonePosition),
      openOrders: openOrders.map(cloneOrder),
      balances: balances.map(cloneBalance),
      fills: fills.map(cloneFill),
      lifecycles: state ? state.lifecycles.map(cloneLifecycle) : [],
      confidence: { ...confidence },
      watermarks: cloneWatermarks(state?.watermarks ?? {}),
      needsHydration: hydrationReasons.length > 0,
      hydrationReasons,
    };
  }

  /**
   * Shared snapshot reducer for all row types.
   *
   * It validates row shape and scope, upserts by row identity, then applies
   * replacement semantics only to rows covered by the snapshot input.
   */
  private applyRows<T extends Row>(
    collection: Map<string, T>,
    rows: unknown[],
    input: SnapshotInput<unknown>,
    isRow: (row: unknown) => row is T,
    getKey: (row: T) => string,
    isCovered: (row: T) => boolean,
    changeSet: ChangeSet,
    findExistingKey: (
      collection: Map<string, T>,
      row: T,
    ) => string | undefined = (targetCollection, row) => {
      const key = getKey(row);
      return targetCollection.has(key) ? key : undefined;
    },
    handleMissing: (
      collection: Map<string, T>,
      key: string,
      row: T,
    ) => 'terminal' | 'stale' = (targetCollection, key) => {
      targetCollection.delete(key);
      return 'terminal';
    },
  ): void {
    const seenKeys = new Set<string>();

    for (const row of rows) {
      if (!isRow(row)) {
        changeSet.warnings.push({
          name: 'snapshot_row_subject_mismatch',
          scope: input.scope,
          message: `Ignoring row that does not match ${input.subject} snapshot shape.`,
          context: { subject: input.subject, row },
        });
        continue;
      }

      if (!isSameScope(input.scope, row)) {
        changeSet.warnings.push({
          name: 'snapshot_row_scope_mismatch',
          scope: input.scope,
          message: 'Ignoring row with a different account scope.',
          context: { expectedScope: input.scope, rowScope: row },
        });
        continue;
      }

      const key = getKey(row);
      seenKeys.add(key);

      const existingKey = findExistingKey(collection, row);
      const existing = existingKey ? collection.get(existingKey) : undefined;
      if (!existing) {
        collection.set(key, cloneRow(row));
        changeSet.rowsInserted++;
        changeSet.changed = true;
        continue;
      }

      if (existingKey && existingKey !== key) {
        collection.delete(existingKey);
      }

      if (!areRowsEqual(existing, row)) {
        collection.set(key, cloneRow(row));
        changeSet.rowsUpdated++;
        changeSet.changed = true;
      } else if (existingKey !== key) {
        collection.set(key, cloneRow(row));
        changeSet.changed = true;
      }
    }

    if (input.mode === 'upsert-only') {
      return;
    }

    const replacementResult = replaceMissingRows(
      collection,
      seenKeys,
      (row) => isCovered(row),
      handleMissing,
    );

    if (replacementResult.terminal > 0 || replacementResult.stale > 0) {
      changeSet.changed = true;
      changeSet.rowsTerminal += replacementResult.terminal;
      changeSet.rowsStale += replacementResult.stale;
    }
  }

  /**
   * Decide whether an existing position is covered by this snapshot.
   *
   * Position-side coverage lets hedge-mode hydrations replace only LONG or
   * SHORT without deleting the opposite side for the same symbol.
   */
  private isPositionCovered(
    position: NormalizedPosition,
    input: SnapshotInput<unknown>,
  ): boolean {
    if (input.mode === 'replace-symbols' && !hasCoveredSymbol(input.coverage)) {
      return false;
    }

    return (
      isSymbolCovered(position.symbol, input.coverage) &&
      isPositionSideCovered(position.exchangePositionSide, input.coverage)
    );
  }

  /**
   * Decide whether an existing open order is covered by this snapshot.
   *
   * Order kind coverage keeps separate exchange feeds, such as regular orders
   * and algo/conditional orders, from terminating each other accidentally.
   */
  private isOrderCovered(
    order: NormalizedOrder,
    input: SnapshotInput<unknown>,
  ): boolean {
    if (input.mode === 'replace-symbols' && !hasCoveredSymbol(input.coverage)) {
      return false;
    }

    return (
      isSymbolCovered(order.symbol, input.coverage) &&
      isOrderKindCovered(order.kind, input.coverage)
    );
  }

  /**
   * Decide whether an existing balance is covered by this snapshot.
   *
   * Balances are not symbol-scoped, so `replace-symbols` is intentionally a
   * no-op for deletions here.
   */
  private isBalanceCovered(
    balance: NormalizedBalance,
    input: SnapshotInput<unknown>,
  ): boolean {
    if (input.mode === 'replace-symbols') {
      return false;
    }

    return isAssetCovered(balance.asset, input.coverage);
  }

  /**
   * Decide whether an existing fill is covered by this snapshot.
   *
   * Fills are append-like in most integrations, but replacement support is kept
   * for replay/test data where a scoped history window may be authoritative.
   */
  private isFillCovered(
    fill: NormalizedFill,
    input: SnapshotInput<unknown>,
  ): boolean {
    if (input.mode === 'replace-symbols' && !hasCoveredSymbol(input.coverage)) {
      return false;
    }

    return isSymbolCovered(fill.symbol, input.coverage);
  }

  /**
   * Find an existing order using any shared exchange/client/algo identity.
   *
   * This allows a local client-id-only order to converge with a later REST row
   * that includes the exchange order id.
   */
  private findExistingOrderKey(
    collection: Map<string, NormalizedOrder>,
    row: NormalizedOrder,
  ): string | undefined {
    const key = getOrderKey(row);
    if (collection.has(key)) {
      return key;
    }

    for (const [existingKey, existingOrder] of collection.entries()) {
      if (ordersShareIdentity(existingOrder, row)) {
        return existingKey;
      }
    }

    return undefined;
  }

  /**
   * Apply the initial absent-from-open-orders policy.
   *
   * Manual/unknown orders can be removed when absent from an authoritative open
   * order snapshot. App-owned or provisional orders remain as stale so the
   * caller can hydrate or reconcile before planning more submissions.
   */
  private readonly handleMissingOpenOrder = (
    collection: Map<string, NormalizedOrder>,
    key: string,
    row: NormalizedOrder,
  ): 'terminal' | 'stale' => {
    if (row.owner === 'app' || row.status === 'provisional') {
      collection.set(key, {
        ...row,
        status: 'stale',
      });
      return 'stale';
    }

    collection.delete(key);
    return 'terminal';
  };

  /**
   * Look up state without creating it, used by reads so unknown scopes remain
   * unknown instead of becoming empty-but-hydrated.
   */
  private getScopeState(scope: AccountScope): ScopeState | undefined {
    return this.scopes.get(createScopeKey(scope));
  }

  /**
   * Create mutable reducer storage for a scope the first time a fact is applied.
   */
  private getOrCreateScopeState(scope: AccountScope): ScopeState {
    const key = createScopeKey(scope);
    const existing = this.scopes.get(key);
    if (existing) {
      return existing;
    }

    const created: ScopeState = {
      positions: new Map(),
      openOrders: new Map(),
      balances: new Map(),
      fills: new Map(),
      lifecycles: [],
      confidence: createInitialConfidence(),
      watermarks: {},
    };
    this.scopes.set(key, created);
    return created;
  }
}

/**
 * Remove or stale existing rows that were absent from a replacement snapshot.
 *
 * The `isCovered` predicate is the safety gate that prevents partial snapshots
 * from mutating unrelated symbols, order kinds, position sides, or assets.
 */
function replaceMissingRows<T extends Row>(
  collection: Map<string, T>,
  seenKeys: Set<string>,
  isCovered: (row: T) => boolean,
  handleMissing: (
    collection: Map<string, T>,
    key: string,
    row: T,
  ) => 'terminal' | 'stale',
): ReplacementResult {
  let terminal = 0;
  let stale = 0;

  for (const [key, row] of Array.from(collection.entries())) {
    if (seenKeys.has(key) || !isCovered(row)) {
      continue;
    }

    const result = handleMissing(collection, key, row);
    if (result === 'terminal') {
      terminal++;
    } else {
      stale++;
    }
  }

  return { terminal, stale };
}

/**
 * Build a neutral change set for one reducer application.
 */
function createEmptyChangeSet(scope: AccountScope): ChangeSet {
  return {
    scope: copyScope(scope),
    changed: false,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsTerminal: 0,
    rowsStale: 0,
    confidenceChanged: false,
    lifecycleChanges: [],
    warnings: [],
    invariantViolations: [],
  };
}

/**
 * New scopes start untrusted until the parent app supplies snapshots/events.
 */
function createInitialConfidence(): AccountViewConfidence {
  return {
    positions: 'unknown',
    openOrders: 'unknown',
    balances: 'unknown',
    fills: 'unknown',
  };
}

/**
 * Convert snapshot metadata into the compact watermark exposed on account views.
 */
function createWatermark(input: SnapshotInput<unknown>): SubjectWatermark {
  const watermark: SubjectWatermark = {
    source: input.source,
    asOfMs: input.asOfMs,
  };

  if (input.provenance?.receivedAtMs !== undefined) {
    watermark.receivedAtMs = input.provenance.receivedAtMs;
  }
  if (input.provenance?.snapshotId !== undefined) {
    watermark.snapshotId = input.provenance.snapshotId;
  }
  if (input.provenance?.eventId !== undefined) {
    watermark.eventId = input.provenance.eventId;
  }
  if (input.provenance?.sequence !== undefined) {
    watermark.sequence = input.provenance.sequence;
  }

  return watermark;
}

/**
 * Map snapshot subjects onto the corresponding confidence slot.
 */
function confidenceKeyForSubject(
  subject: SnapshotSubject,
): keyof AccountViewConfidence {
  switch (subject) {
    case 'positions':
      return 'positions';
    case 'openOrders':
      return 'openOrders';
    case 'balances':
      return 'balances';
    case 'fills':
      return 'fills';
    case 'filters':
      return 'filters';
  }
}

/**
 * Initial confidence derived from source type. Later phases will refine this
 * with stream/REST combination rules, TTLs, and conflict handling.
 */
function confidenceFromSource(source: StateSource): ConfidenceState {
  switch (source) {
    case 'ws':
      return 'stream_only';
    case 'local':
    case 'manual':
      return 'local_only';
    case 'rest':
    case 'replay':
    case 'test':
      return 'rest_hydrated';
  }
}

/**
 * Produce coarse hydration reasons from current confidence and stale rows.
 *
 * This is deliberately simple in Phase 2; it gives callers a useful signal
 * without implementing the full hydration scheduler planned for later phases.
 */
function getHydrationReasons(
  confidence: AccountViewConfidence,
  openOrders: NormalizedOrder[],
): string[] {
  const reasons: string[] = [];
  for (const subject of [
    'positions',
    'openOrders',
    'balances',
    'fills',
  ] as const) {
    const value = confidence[subject];
    if (value === 'unknown') {
      reasons.push(`${subject}_unknown`);
    } else if (value === 'stale') {
      reasons.push(`${subject}_stale`);
    } else if (value === 'conflicted') {
      reasons.push(`${subject}_conflicted`);
    } else if (value === 'paused') {
      reasons.push(`${subject}_paused`);
    }
  }

  if (openOrders.some((order) => order.status === 'stale')) {
    reasons.push('openOrders_stale');
  }

  return Array.from(new Set(reasons));
}

/**
 * Compare confidence slots structurally without caring about object identity.
 */
function isSameConfidence(
  a: AccountViewConfidence,
  b: AccountViewConfidence,
): boolean {
  return (
    a.positions === b.positions &&
    a.openOrders === b.openOrders &&
    a.balances === b.balances &&
    a.fills === b.fills &&
    a.filters === b.filters &&
    a.stream === b.stream
  );
}

/**
 * Compare watermarks by value so repeated identical snapshots can be no-op
 * change sets.
 */
function isSameWatermark(
  a: SubjectWatermark | undefined,
  b: SubjectWatermark | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `replace-symbols` requires explicit symbol coverage before any existing row
 * can be considered absent.
 */
function hasCoveredSymbol(coverage: SnapshotCoverage | undefined): boolean {
  return Boolean(coverage?.symbols?.length);
}

/**
 * Check whether a symbol is inside the snapshot coverage. Missing coverage means
 * full-scope coverage for modes that allow it.
 */
function isSymbolCovered(
  symbol: string,
  coverage: SnapshotCoverage | undefined,
): boolean {
  return !coverage?.symbols || coverage.symbols.includes(symbol);
}

/**
 * Check whether a row's order kind is inside a partial open-order snapshot.
 */
function isOrderKindCovered(
  kind: NormalizedOrder['kind'],
  coverage: SnapshotCoverage | undefined,
): boolean {
  return !coverage?.orderKinds || coverage.orderKinds.includes(kind);
}

/**
 * Check whether a position slot is inside a partial position snapshot.
 */
function isPositionSideCovered(
  positionSide: string,
  coverage: SnapshotCoverage | undefined,
): boolean {
  return (
    !coverage?.positionSides || coverage.positionSides.includes(positionSide)
  );
}

/**
 * Check whether a balance asset is inside a partial balance snapshot.
 */
function isAssetCovered(
  asset: string,
  coverage: SnapshotCoverage | undefined,
): boolean {
  return !coverage?.assets || coverage.assets.includes(asset);
}

/**
 * Runtime guard for position snapshots.
 *
 * The checks intentionally include fields that distinguish positions from
 * order/fill rows, because normalized facts share common symbol/side fields.
 */
function isNormalizedPosition(row: unknown): row is NormalizedPosition {
  return (
    isObject(row) &&
    row['kind'] === undefined &&
    typeof row['symbol'] === 'string' &&
    typeof row['exchangePositionSide'] === 'string' &&
    typeof row['strategySide'] === 'string' &&
    typeof row['quantity'] === 'string' &&
    typeof row['updatedAtMs'] === 'number' &&
    typeof row['source'] === 'string'
  );
}

/**
 * Runtime guard for order snapshots.
 */
function isNormalizedOrder(row: unknown): row is NormalizedOrder {
  return (
    isObject(row) &&
    typeof row['symbol'] === 'string' &&
    typeof row['kind'] === 'string' &&
    typeof row['side'] === 'string' &&
    typeof row['type'] === 'string' &&
    typeof row['status'] === 'string' &&
    typeof row['updatedAtMs'] === 'number' &&
    typeof row['source'] === 'string'
  );
}

/**
 * Runtime guard for balance snapshots.
 */
function isNormalizedBalance(row: unknown): row is NormalizedBalance {
  return (
    isObject(row) &&
    typeof row['asset'] === 'string' &&
    typeof row['updatedAtMs'] === 'number' &&
    typeof row['source'] === 'string'
  );
}

/**
 * Runtime guard for fill snapshots.
 *
 * It excludes order-shaped rows and requires execution timestamps so an order
 * snapshot cannot be misread as a fill snapshot.
 */
function isNormalizedFill(row: unknown): row is NormalizedFill {
  return (
    isObject(row) &&
    row['kind'] === undefined &&
    typeof row['symbol'] === 'string' &&
    typeof row['side'] === 'string' &&
    typeof row['price'] === 'string' &&
    typeof row['quantity'] === 'string' &&
    typeof row['executedAtMs'] === 'number' &&
    typeof row['updatedAtMs'] === 'number' &&
    typeof row['source'] === 'string'
  );
}

/**
 * Narrow unknown snapshot rows to object-like values for shape guards.
 */
function isObject(row: unknown): row is Record<string, unknown> {
  return typeof row === 'object' && row !== null;
}

/**
 * Clone incoming rows before storing them so caller-owned objects cannot mutate
 * internal reducer state after `applySnapshot` returns.
 */
function cloneRow<T extends Row>(row: T): T {
  return { ...row };
}

/**
 * Clone a position row for account views.
 */
function clonePosition(position: NormalizedPosition): NormalizedPosition {
  return { ...position };
}

/**
 * Clone an order row for account views, including a shallow metadata copy.
 */
function cloneOrder(order: NormalizedOrder): NormalizedOrder {
  const cloned = { ...order };
  if (order.metadata) {
    cloned.metadata = { ...order.metadata };
  }

  return cloned;
}

/**
 * Clone a balance row for account views.
 */
function cloneBalance(balance: NormalizedBalance): NormalizedBalance {
  return { ...balance };
}

/**
 * Clone a fill row for account views.
 */
function cloneFill(fill: NormalizedFill): NormalizedFill {
  return { ...fill };
}

/**
 * Clone lifecycle state for account views.
 */
function cloneLifecycle(lifecycle: PositionLifecycle): PositionLifecycle {
  return { ...lifecycle };
}

/**
 * Clone optional watermark slots without materializing absent slots as
 * `undefined` properties.
 */
function cloneWatermarks(watermarks: AccountWatermarks): AccountWatermarks {
  const cloned: AccountWatermarks = {};
  if (watermarks.positions) {
    cloned.positions = { ...watermarks.positions };
  }
  if (watermarks.openOrders) {
    cloned.openOrders = { ...watermarks.openOrders };
  }
  if (watermarks.balances) {
    cloned.balances = { ...watermarks.balances };
  }
  if (watermarks.fills) {
    cloned.fills = { ...watermarks.fills };
  }
  if (watermarks.filters) {
    cloned.filters = { ...watermarks.filters };
  }
  if (watermarks.stream) {
    cloned.stream = { ...watermarks.stream };
  }

  return cloned;
}

/**
 * Compare normalized rows by value for Phase 2.
 *
 * This is acceptable while rows are plain data. If future rows gain richer
 * nested structures or unordered metadata, this should become subject-specific.
 */
function areRowsEqual(a: Row, b: Row): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
