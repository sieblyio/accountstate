import {
  cloneSyncRequest,
  confidenceFromSource,
  confidenceFromStreamHealth,
  confidenceKeyForSubject,
  createInitialConfidence,
  createStreamWatermark,
  createWatermark,
  getSyncRequestKey,
  getSyncRequestsForConfidence,
  getSyncReasons,
  getStreamHealthSyncRequests,
  getStreamHealthWarning,
  isSyncingSnapshotSource,
  isSameConfidence,
  isSameWatermark,
} from './confidence.js';
import {
  createOrderCancelledFact,
  createExchangeAccount,
  createOrderAcceptedFact,
  createOrderNotFoundFact,
  createOrderRejectedFact,
  createOrderStatusUnknownFact,
  createStreamHealthFact,
  createStreamUpdateSnapshotInput,
  createSyncSnapshotInput,
  createUnsupportedFactChangeSet,
} from './exchangeAccount.js';
import {
  getBalanceKey,
  getFillKey,
  getOrderKey,
  getPositionKey,
  orderMatchesIdentity,
  ordersShareIdentity,
} from './indexes.js';
import {
  applyManagedOrderParsers,
  lifecycleMatchesFilter,
  reconcilePositionLifecycles,
} from './lifecycle.js';
import {
  getBuiltInInvariantViolations,
  runCustomInvariants,
} from './invariants.js';
import type {
  AccountFact,
  LocalSubmissionAcceptedFact,
  LocalSubmissionRejectedFact,
  LocalSubmissionUnknownFact,
  NormalizedPrivateEvent,
  StreamHealthFact,
  TerminalEvidenceFact,
} from './facts.js';
import type {
  OrderCancelledInput,
  ExchangeAccount,
  ExchangeAccountReadinessOptions,
  FillFilter,
  OpenOrderFilter,
  OrderAcceptedInput,
  OrderNotFoundInput,
  OrderRejectedInput,
  OrderStatusUnknownInput,
  PositionFilter,
  PositionIdentity,
  StreamHealthOptions,
  StreamUpdateOptions,
  SyncRowsOptions,
} from './exchangeAccount.js';
import type {
  AccountScope,
  AccountChangeSubject,
  AccountView,
  AccountViewConfidence,
  AccountWatermarks,
  ChangeSet,
  SyncRequest,
  SyncSubject,
  InvariantViolation,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  OrderIdentity,
  PositionLifecycle,
  Provenance,
  SyncCoverage,
  SnapshotInput,
  TimestampMs,
} from './types.js';
import type { LifecycleFilter, LifecycleIdentity } from './lifecycle.js';
import type {
  CheckInvariantsOptions,
  InvariantRuntimeOptions,
} from './invariants.js';
import type { ManagedOrderParser, StateInvariant } from './plugins.js';
import { copyScope, createScopeKey, isSameScope } from './utils.js';

/**
 * Optional extension points for the exchange account store.
 */
export interface ExchangeAccountStateStoreOptions extends InvariantRuntimeOptions {
  /**
   * Parsers that extract project-owned order metadata from normalized orders,
   * usually from custom client order ids.
   */
  managedOrderParsers?: ManagedOrderParser[];
  /**
   * Project-specific health checks run by `checkInvariants`.
   */
  invariants?: StateInvariant[];
  /**
   * Clock used for deterministic tests and stale-order checks.
   */
  clock?: () => TimestampMs;
}

interface ScopeState {
  positions: Map<string, NormalizedPosition>;
  openOrders: Map<string, NormalizedOrder>;
  balances: Map<string, NormalizedBalance>;
  fills: Map<string, NormalizedFill>;
  lifecycles: PositionLifecycle[];
  confidence: AccountViewConfidence;
  watermarks: AccountWatermarks;
  syncRequests: Map<string, SyncRequest>;
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
  #scopes = new Map<string, ScopeState>();
  #managedOrderParsers: ManagedOrderParser[];
  #invariants: StateInvariant[];
  #clock: () => TimestampMs;
  #invariantOptions: InvariantRuntimeOptions;

  /**
   * Create an empty in-memory account store.
   *
   * The store owns no network clients; parent applications feed it normalized
   * REST snapshots, private-stream updates, and order-submission outcomes.
   */
  constructor(options: ExchangeAccountStateStoreOptions = {}) {
    this.#managedOrderParsers = [...(options.managedOrderParsers ?? [])];
    this.#invariants = [...(options.invariants ?? [])];
    this.#clock = options.clock ?? Date.now;
    this.#invariantOptions = {
      provisionalOrderStaleMs: options.provisionalOrderStaleMs,
      validateDecimalStrings: options.validateDecimalStrings,
    };
  }

  /**
   * Register a parser that can read project-owned order metadata from normalized
   * order rows, usually from client order ids.
   */
  registerManagedOrderParser(parser: ManagedOrderParser): this {
    this.#managedOrderParsers.push(parser);
    return this;
  }

  /**
   * Register a project-specific account-state invariant.
   */
  registerInvariant(invariant: StateInvariant): this {
    this.#invariants.push(invariant);
    return this;
  }

  /**
   * Sync a REST-style position snapshot. By default, absent positions in the
   * covered scope are treated as closed.
   */
  syncPositions(
    scope: AccountScope,
    rows: NormalizedPosition[],
    options?: SyncRowsOptions,
  ): ChangeSet {
    return this.#applySnapshot(
      createSyncSnapshotInput(
        scope,
        'positions',
        rows,
        { mode: 'replace-scope', source: 'rest' },
        options,
      ),
    );
  }

  /**
   * Sync a REST-style open-order snapshot. Use `coverage` with `replace-symbols`
   * when the exchange response only covers part of the account.
   */
  syncOpenOrders(
    scope: AccountScope,
    rows: NormalizedOrder[],
    options?: SyncRowsOptions,
  ): ChangeSet {
    return this.#applySnapshot(
      createSyncSnapshotInput(
        scope,
        'openOrders',
        rows,
        { mode: 'replace-scope', source: 'rest' },
        options,
      ),
    );
  }

  /**
   * Sync a REST-style balance snapshot for the account scope.
   */
  syncBalances(
    scope: AccountScope,
    rows: NormalizedBalance[],
    options?: SyncRowsOptions,
  ): ChangeSet {
    return this.#applySnapshot(
      createSyncSnapshotInput(
        scope,
        'balances',
        rows,
        { mode: 'replace-scope', source: 'rest' },
        options,
      ),
    );
  }

  /**
   * Sync fills/trades. Fills are append-like for most exchange APIs, so this
   * defaults to upsert-only.
   */
  syncFills(
    scope: AccountScope,
    rows: NormalizedFill[],
    options?: SyncRowsOptions,
  ): ChangeSet {
    return this.#applySnapshot(
      createSyncSnapshotInput(
        scope,
        'fills',
        rows,
        { mode: 'upsert-only', source: 'rest' },
        options,
      ),
    );
  }

  /**
   * Apply one private-stream position update.
   */
  onPositionUpdate(
    scope: AccountScope,
    row: NormalizedPosition,
    options?: StreamUpdateOptions,
  ): ChangeSet {
    return this.#applySnapshot(
      createStreamUpdateSnapshotInput(scope, 'positions', row, options),
    );
  }

  /**
   * Apply one private-stream order update.
   */
  onOrderUpdate(
    scope: AccountScope,
    row: NormalizedOrder,
    options?: StreamUpdateOptions,
  ): ChangeSet {
    return this.#applySnapshot(
      createStreamUpdateSnapshotInput(scope, 'openOrders', row, options),
    );
  }

  /**
   * Apply one private-stream balance update.
   */
  onBalanceUpdate(
    scope: AccountScope,
    row: NormalizedBalance,
    options?: StreamUpdateOptions,
  ): ChangeSet {
    return this.#applySnapshot(
      createStreamUpdateSnapshotInput(scope, 'balances', row, options),
    );
  }

  /**
   * Apply one private-stream fill/trade update.
   */
  onFill(
    scope: AccountScope,
    row: NormalizedFill,
    options?: StreamUpdateOptions,
  ): ChangeSet {
    return this.#applySnapshot(
      createStreamUpdateSnapshotInput(scope, 'fills', row, options),
    );
  }

  /**
   * Mark the private stream connected.
   */
  streamConnected(
    scope: AccountScope,
    options?: StreamHealthOptions,
  ): ChangeSet {
    return this.#applyStreamHealthFact(
      createStreamHealthFact(scope, 'connected', options),
    );
  }

  /**
   * Mark the private stream reconnected and request account sync.
   */
  streamReconnected(
    scope: AccountScope,
    options?: StreamHealthOptions,
  ): ChangeSet {
    return this.#applyStreamHealthFact(
      createStreamHealthFact(scope, 'reconnected', options),
    );
  }

  /**
   * Mark the private stream disconnected and request account sync.
   */
  streamDisconnected(
    scope: AccountScope,
    options?: StreamHealthOptions,
  ): ChangeSet {
    return this.#applyStreamHealthFact(
      createStreamHealthFact(scope, 'disconnected', options),
    );
  }

  /**
   * Mark a known private-stream gap and request account sync.
   */
  streamGap(scope: AccountScope, options?: StreamHealthOptions): ChangeSet {
    return this.#applyStreamHealthFact(
      createStreamHealthFact(scope, 'gap', options),
    );
  }

  /**
   * Record that the exchange accepted an order submission.
   */
  orderAccepted(input: OrderAcceptedInput): ChangeSet {
    return this.#applyLocalSubmissionAccepted(createOrderAcceptedFact(input));
  }

  /**
   * Record that the exchange rejected an order submission.
   */
  orderRejected(input: OrderRejectedInput): ChangeSet {
    return this.#applyLocalSubmissionRejected(createOrderRejectedFact(input));
  }

  /**
   * Record that the submit call timed out or returned an indeterminate result.
   */
  orderStatusUnknown(input: OrderStatusUnknownInput): ChangeSet {
    return this.#applyLocalSubmissionUnknown(
      createOrderStatusUnknownFact(input),
    );
  }

  /**
   * Record a cancel response that proves the target order is no longer open.
   */
  orderCancelled(input: OrderCancelledInput): ChangeSet {
    return this.#markOrderTerminal(createOrderCancelledFact(input));
  }

  /**
   * Record exchange evidence that an order is no longer open.
   */
  orderNotFound(input: OrderNotFoundInput): ChangeSet {
    return this.#markOrderTerminal(createOrderNotFoundFact(input));
  }

  /**
   * Return the account view most app code should use for planning decisions.
   */
  getAccount(
    scope: AccountScope,
    options?: ExchangeAccountReadinessOptions,
  ): ExchangeAccount {
    const view = this.getAccountView(scope);
    return createExchangeAccount(view, this.getSyncRequests(scope), options);
  }

  /**
   * Return current positions, optionally filtered by symbol or side.
   */
  getPositions(
    scope: AccountScope,
    filter: PositionFilter = {},
  ): NormalizedPosition[] {
    return this.getAccount(scope).positions.filter((position) =>
      positionMatchesFilter(position, filter),
    );
  }

  /**
   * Return one position. If only a symbol is supplied and hedge-mode data has
   * multiple sides for that symbol, this returns `undefined` instead of guessing.
   */
  getPosition(
    scope: AccountScope,
    identity: PositionIdentity,
  ): NormalizedPosition | undefined {
    const matches = this.getPositions(scope, identity);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Return current open orders, optionally filtered by common exchange fields.
   */
  getOpenOrders(
    scope: AccountScope,
    filter: OpenOrderFilter = {},
  ): NormalizedOrder[] {
    return this.getAccount(scope).openOrders.filter((order) =>
      openOrderMatchesFilter(order, filter),
    );
  }

  /**
   * Return one open order by any known exchange/custom identity.
   */
  getOrder(
    scope: AccountScope,
    identity: OrderIdentity,
  ): NormalizedOrder | undefined {
    return this.getOpenOrders(scope).find((order) =>
      orderMatchesIdentity(order, identity),
    );
  }

  /**
   * Return current balances.
   */
  getBalances(scope: AccountScope): NormalizedBalance[] {
    return this.getAccount(scope).balances;
  }

  /**
   * Return one balance by asset symbol, such as `USDT`.
   */
  getBalance(
    scope: AccountScope,
    asset: string,
  ): NormalizedBalance | undefined {
    return this.getBalances(scope).find((balance) => balance.asset === asset);
  }

  /**
   * Return current fills/trades, optionally filtered by symbol or order identity.
   */
  getFills(scope: AccountScope, filter: FillFilter = {}): NormalizedFill[] {
    return this.getAccount(scope).fills.filter((fill) =>
      fillMatchesFilter(fill, filter),
    );
  }

  /**
   * Return current position lifecycles, optionally filtered by symbol, side, or
   * lifecycle status.
   */
  getLifecycles(
    scope: AccountScope,
    filter: LifecycleFilter = {},
  ): PositionLifecycle[] {
    return this.getAccount(scope).lifecycles.filter((lifecycle) =>
      lifecycleMatchesFilter(lifecycle, filter),
    );
  }

  /**
   * Return one lifecycle. If only a symbol is supplied and multiple hedge-mode
   * sides match, this returns `undefined` instead of guessing.
   */
  getLifecycle(
    scope: AccountScope,
    identity: LifecycleIdentity,
  ): PositionLifecycle | undefined {
    const matches = this.getLifecycles(scope, identity);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Apply one normalized adapter/replay fact.
   *
   * For typical integrations, prefer methods such as `syncOpenOrders`,
   * `onOrderUpdate`, and `orderAccepted`.
   */
  ingest(input: AccountFact): ChangeSet;
  /**
   * Apply normalized adapter/replay facts in order.
   *
   * For typical integrations, prefer methods such as `syncOpenOrders`,
   * `onOrderUpdate`, and `orderAccepted`.
   */
  ingest(inputs: AccountFact[]): ChangeSet[];
  /**
   * Apply normalized adapter/replay facts.
   *
   * For typical integrations, prefer methods such as `syncOpenOrders`,
   * `onOrderUpdate`, and `orderAccepted`.
   */
  ingest(input: AccountFact | AccountFact[]): ChangeSet | ChangeSet[] {
    return Array.isArray(input)
      ? input.map((fact) => this.#applyFact(fact))
      : this.#applyFact(input);
  }

  /**
   * Run built-in and registered project invariants for one account scope.
   *
   * This is a read-only health check. It does not throw, mutate state, or
   * require callers to understand reducer internals.
   */
  checkInvariants(
    scope: AccountScope,
    options: CheckInvariantsOptions = {},
  ): InvariantViolation[] {
    const view = this.getAccountView(scope);
    const invariantOptions: CheckInvariantsOptions = {
      ...this.#invariantOptions,
      ...options,
      nowMs: options.nowMs ?? this.#clock(),
    };

    return [
      ...getBuiltInInvariantViolations(view, invariantOptions),
      ...runCustomInvariants(view, this.#invariants),
    ];
  }

  /**
   * Apply a normalized batch from a source such as REST, replay, test data, or
   * synthetic local state. Replacement modes make absent covered rows meaningful:
   * a missing position is terminal, while an absent app/provisional order stays
   * visible as stale until later phases can reconcile it explicitly.
   */
  #applySnapshot(input: SnapshotInput<unknown>): ChangeSet {
    const state = this.#getOrCreateScopeState(input.scope);
    const changeSet = createEmptyChangeSet(input.scope);
    const confidenceBefore = state.confidence;
    const changedBeforeRows = changeSet.changed;
    const countsBefore = getChangedItemCount(changeSet);

    switch (input.subject) {
      case 'positions':
        this.#applyRows(
          state.positions,
          input.rows,
          input,
          isNormalizedPosition,
          getPositionKey,
          (row) => this.#isPositionCovered(row, input),
          changeSet,
        );
        break;
      case 'openOrders':
        this.#applyRows(
          state.openOrders,
          this.#prepareOpenOrderRows(input.rows),
          input,
          isNormalizedOrder,
          getOrderKey,
          (row) => this.#isOrderCovered(row, input),
          changeSet,
          (collection, row) => this.#findExistingOrderKey(collection, row),
          this.#handleMissingOpenOrder,
        );
        break;
      case 'balances':
        this.#applyRows(
          state.balances,
          input.rows,
          input,
          isNormalizedBalance,
          getBalanceKey,
          (row) => this.#isBalanceCovered(row, input),
          changeSet,
        );
        break;
      case 'fills':
        this.#applyRows(
          state.fills,
          input.rows,
          input,
          isNormalizedFill,
          getFillKey,
          (row) => this.#isFillCovered(row, input),
          changeSet,
        );
        break;
      case 'filters':
        break;
    }

    if (
      changeSet.changed !== changedBeforeRows ||
      getChangedItemCount(changeSet) > countsBefore
    ) {
      addChangedSubject(changeSet, input.subject);
    }

    const watermarksBefore = state.watermarks;
    state.watermarks = {
      ...state.watermarks,
      [input.subject]: createWatermark(input),
    };
    state.confidence = {
      ...state.confidence,
      [confidenceKeyForSubject(input.subject)]:
        changeSet.itemsMarkedStale > 0
          ? 'stale'
          : confidenceFromSource(input.source),
    };
    const syncRequestsCleared = isSyncingSnapshotSource(input.source)
      ? clearSyncRequestsForSubject(state, input.subject)
      : 0;

    changeSet.confidenceChanged = !isSameConfidence(
      confidenceBefore,
      state.confidence,
    );
    const syncChanged =
      changeSet.confidenceChanged ||
      !isSameWatermark(
        watermarksBefore[input.subject],
        state.watermarks[input.subject],
      ) ||
      syncRequestsCleared > 0;
    changeSet.changed =
      changeSet.changed ||
      syncChanged;
    if (syncChanged) {
      addChangedSubject(changeSet, 'sync');
    }

    if (input.subject === 'positions' || input.subject === 'openOrders') {
      this.#reconcileLifecycles(state, input.scope, changeSet);
    }

    return changeSet;
  }

  /**
   * Record private-stream health without owning the stream connection itself.
   *
   * Gaps, reconnects, and disconnects mark account subjects stale and request
   * sync. A clean connection only updates stream confidence/watermark.
   */
  #applyStreamHealthFact(input: StreamHealthFact): ChangeSet {
    const state = this.#getOrCreateScopeState(input.scope);
    const changeSet = createEmptyChangeSet(input.scope);
    const confidenceBefore = state.confidence;
    const watermarksBefore = state.watermarks;

    state.confidence = confidenceFromStreamHealth(
      state.confidence,
      input.status,
    );
    state.watermarks = {
      ...state.watermarks,
      stream: createStreamWatermark(input),
    };

    let syncRequestsChanged = false;
    for (const request of getStreamHealthSyncRequests(input)) {
      syncRequestsChanged =
        addSyncRequest(state, request) || syncRequestsChanged;
    }

    const warning = getStreamHealthWarning(input);
    if (warning) {
      changeSet.warnings.push(warning);
    }

    changeSet.confidenceChanged = !isSameConfidence(
      confidenceBefore,
      state.confidence,
    );
    const syncChanged =
      changeSet.confidenceChanged ||
      !isSameWatermark(watermarksBefore.stream, state.watermarks.stream) ||
      syncRequestsChanged;
    changeSet.changed =
      syncChanged || changeSet.warnings.length > 0;
    if (syncChanged) {
      addChangedSubject(changeSet, 'sync');
    }

    return changeSet;
  }

  /**
   * Record that a locally submitted order was accepted by the parent exchange
   * client before stream or REST confirmation has arrived.
   *
   * The order is kept visible as `provisional`, keyed by whatever identity is
   * available, so a planner cannot accidentally submit the same client id twice
   * during the confirmation window.
   */
  #applyLocalSubmissionAccepted(input: LocalSubmissionAcceptedFact): ChangeSet {
    const state = this.#getOrCreateScopeState(input.scope);
    const changeSet = createEmptyChangeSet(input.scope);
    const confidenceBefore = state.confidence;

    const order = this.#prepareOpenOrder(input.order);
    if (!isSameScope(input.scope, order)) {
      changeSet.warnings.push({
        name: 'local_submission_order_scope_mismatch',
        scope: input.scope,
        message:
          'Ignoring accepted local submission with mismatched order scope.',
        context: { orderScope: order },
      });
      changeSet.changed = true;
      return changeSet;
    }

    const provisionalOrder = createProvisionalOrder({ ...input, order });
    const existingKey = this.#findExistingOrderKey(
      state.openOrders,
      provisionalOrder,
    );
    const duplicate = findDuplicateActiveClientOrder(
      state.openOrders,
      provisionalOrder,
      existingKey,
    );
    const existing = existingKey
      ? state.openOrders.get(existingKey)
      : undefined;
    if (
      duplicate ||
      (existing &&
        existing.customClientOrderId === provisionalOrder.customClientOrderId &&
        isActiveOrProvisionalOrder(existing))
    ) {
      changeSet.warnings.push({
        name: 'duplicate_active_custom_client_order_id',
        scope: input.scope,
        message:
          'Accepted local submission shares a custom client order id with another active order.',
        context: {
          customClientOrderId: provisionalOrder.customClientOrderId,
          duplicate,
        },
      });
    }

    const key = getOrderKey(provisionalOrder);
    if (!existing) {
      state.openOrders.set(key, cloneOrder(provisionalOrder));
      changeSet.itemsAdded++;
      changeSet.changed = true;
      addChangedSubject(changeSet, 'openOrders');
    } else {
      if (existingKey && existingKey !== key) {
        state.openOrders.delete(existingKey);
      }
      if (!areRowsEqual(existing, provisionalOrder) || existingKey !== key) {
        state.openOrders.set(key, cloneOrder(provisionalOrder));
        changeSet.itemsUpdated++;
        changeSet.changed = true;
        addChangedSubject(changeSet, 'openOrders');
      }
    }

    state.confidence = {
      ...state.confidence,
      openOrders: 'local_only',
    };
    changeSet.confidenceChanged = !isSameConfidence(
      confidenceBefore,
      state.confidence,
    );
    changeSet.changed =
      changeSet.changed ||
      changeSet.confidenceChanged ||
      changeSet.warnings.length > 0;
    if (changeSet.confidenceChanged) {
      addChangedSubject(changeSet, 'sync');
    }

    this.#reconcileLifecycles(state, input.scope, changeSet);

    return changeSet;
  }

  /**
   * Record that a local submission was rejected.
   *
   * Any matching provisional/open order is removed, and an explicit sync
   * request is stored so the parent app can reconcile open orders before planning.
   */
  #applyLocalSubmissionRejected(input: LocalSubmissionRejectedFact): ChangeSet {
    const state = this.#getOrCreateScopeState(input.scope);
    const changeSet = createEmptyChangeSet(input.scope);
    const confidenceBefore = state.confidence;
    const identity = identityFromClientId(input.clientId);
    const terminalRows = identity
      ? this.#removeOrderByIdentity(state.openOrders, identity)
      : 0;

    changeSet.itemsRemoved += terminalRows;
    if (terminalRows > 0) {
      addChangedSubject(changeSet, 'openOrders');
    }
    changeSet.warnings.push({
      name: 'local_submission_rejected',
      scope: input.scope,
      message: 'Local submission was rejected by the exchange client.',
      context: {
        intentId: input.intentId,
        clientId: input.clientId,
        error: input.error,
      },
    });
    addSyncRequest(state, {
      scope: input.scope,
      subject: 'openOrders',
      reason: 'conflicting_state',
      priority: 'soon',
      requestedAtMs: input.rejectedAtMs,
    });
    state.confidence = {
      ...state.confidence,
      openOrders: 'stale',
    };

    changeSet.confidenceChanged = !isSameConfidence(
      confidenceBefore,
      state.confidence,
    );
    changeSet.changed = true;
    addChangedSubject(changeSet, 'sync');

    this.#reconcileLifecycles(state, input.scope, changeSet);

    return changeSet;
  }

  /**
   * Record an indeterminate local submission result.
   *
   * Existing provisional rows are deliberately left in place. The parent app can
   * use `getSyncRequests()` to schedule an immediate open-order sync.
   */
  #applyLocalSubmissionUnknown(input: LocalSubmissionUnknownFact): ChangeSet {
    const state = this.#getOrCreateScopeState(input.scope);
    const changeSet = createEmptyChangeSet(input.scope);
    const confidenceBefore = state.confidence;

    changeSet.warnings.push({
      name: 'local_submission_unknown',
      scope: input.scope,
      message:
        'Local submission result is unknown; open orders need exchange sync.',
      context: {
        intentId: input.intentId,
        clientId: input.clientId,
        error: input.error,
      },
    });
    addSyncRequest(state, {
      scope: input.scope,
      subject: 'openOrders',
      reason: 'submission_unknown',
      priority: 'immediate',
      requestedAtMs: input.atMs,
    });
    state.confidence = {
      ...state.confidence,
      openOrders: 'stale',
    };

    changeSet.confidenceChanged = !isSameConfidence(
      confidenceBefore,
      state.confidence,
    );
    changeSet.changed = true;
    addChangedSubject(changeSet, 'sync');

    this.#reconcileLifecycles(state, input.scope, changeSet);

    return changeSet;
  }

  /**
   * Apply explicit terminal evidence for a known order identity.
   *
   * This is the escape hatch for facts such as "unknown order on cancel" or a
   * later authoritative lookup proving an order is no longer open.
   */
  #markOrderTerminal(input: TerminalEvidenceFact): ChangeSet {
    const state = this.#getOrCreateScopeState(input.scope);
    const changeSet = createEmptyChangeSet(input.scope);
    const itemsRemoved = this.#removeOrderByIdentity(
      state.openOrders,
      input.identity,
    );

    changeSet.itemsRemoved = itemsRemoved;
    if (itemsRemoved > 0) {
      addChangedSubject(changeSet, 'openOrders');
    }
    if (itemsRemoved === 0) {
      changeSet.warnings.push({
        name: 'terminal_order_not_found',
        scope: input.scope,
        message: 'Terminal evidence did not match any active open order.',
        context: {
          identity: input.identity,
          reason: input.reason,
        },
      });
    }
    changeSet.changed = itemsRemoved > 0 || changeSet.warnings.length > 0;

    this.#reconcileLifecycles(state, input.scope, changeSet);

    return changeSet;
  }

  #applyFact(input: AccountFact): ChangeSet {
    switch (input.type) {
      case 'rest_snapshot':
        return this.#applySnapshot(input);
      case 'position_updated':
      case 'order_updated':
      case 'trade_executed':
      case 'balance_updated':
      case 'stream_gap':
        return this.#applyPrivateStreamEvent(input);
      case 'local_submission_accepted':
        return this.#applyLocalSubmissionAccepted(input);
      case 'local_submission_rejected':
        return this.#applyLocalSubmissionRejected(input);
      case 'local_submission_unknown':
        return this.#applyLocalSubmissionUnknown(input);
      case 'local_order_cancelled':
        if (!input.target) {
          return createUnsupportedFactChangeSet(input.scope, input.type);
        }
        return this.orderCancelled({
          scope: input.scope,
          intentId: input.intentId,
          identity: input.target,
          cancelledAtMs: input.cancelledAtMs,
          responseSummary: input.responseSummary,
        });
      case 'terminal_evidence':
        return this.#markOrderTerminal(input);
      case 'stream_health':
        return this.#applyStreamHealthFact(input);
      case 'sync_gap':
      case 'operator_state':
        return createUnsupportedFactChangeSet(input.scope, input.type);
    }
  }

  /**
   * Return explicit sync requests recorded by local submission and stream
   * health facts. The parent application still owns scheduling and networking.
   *
   * Most application code can read the same requests from
   * `getAccount(scope).syncRequests`.
   */
  getSyncRequests(scope: AccountScope): SyncRequest[] {
    const state = this.#getScopeState(scope);
    return getSyncRequestsForConfidence(
      scope,
      state?.confidence ?? createInitialConfidence(),
      state ? Array.from(state.syncRequests.values()) : [],
    );
  }

  /**
   * Return the current best local belief for a scope.
   *
   * The returned rows are clones so callers can plan from the view without
   * accidentally mutating reducer state between fact applications.
   *
   * Most application code should prefer `getAccount(scope)`, which includes
   * readiness booleans and sync requests.
   */
  getAccountView(scope: AccountScope): AccountView {
    const state = this.#getScopeState(scope);
    const confidence = state?.confidence ?? createInitialConfidence();
    const positions = state ? Array.from(state.positions.values()) : [];
    const openOrders = state ? Array.from(state.openOrders.values()) : [];
    const balances = state ? Array.from(state.balances.values()) : [];
    const fills = state ? Array.from(state.fills.values()) : [];
    const syncReasons = getSyncReasons(
      confidence,
      openOrders,
      state ? Array.from(state.syncRequests.values()) : [],
    );

    return {
      scope: copyScope(scope),
      positions: positions.map(clonePosition),
      openOrders: openOrders.map(cloneOrder),
      balances: balances.map(cloneBalance),
      fills: fills.map(cloneFill),
      lifecycles: state ? state.lifecycles.map(cloneLifecycle) : [],
      confidence: { ...confidence },
      watermarks: cloneWatermarks(state?.watermarks ?? {}),
      needsSync: syncReasons.length > 0,
      syncReasons,
    };
  }

  /**
   * Translate normalized private stream events into the same row reducers used by
   * snapshots so stream and REST paths cannot drift.
   */
  #applyPrivateStreamEvent(input: NormalizedPrivateEvent): ChangeSet {
    switch (input.type) {
      case 'position_updated':
        return this.#applySnapshot({
          scope: input.scope,
          subject: 'positions',
          mode: 'upsert-only',
          rows: [input.position],
          source: input.provenance.source,
          asOfMs: getProvenanceAsOfMs(input.provenance),
          provenance: input.provenance,
        });
      case 'order_updated':
        return this.#applySnapshot({
          scope: input.scope,
          subject: 'openOrders',
          mode: 'upsert-only',
          rows: [input.order],
          source: input.provenance.source,
          asOfMs: getProvenanceAsOfMs(input.provenance),
          provenance: input.provenance,
        });
      case 'trade_executed':
        return this.#applySnapshot({
          scope: input.scope,
          subject: 'fills',
          mode: 'upsert-only',
          rows: [input.fill],
          source: input.provenance.source,
          asOfMs: getProvenanceAsOfMs(input.provenance),
          provenance: input.provenance,
        });
      case 'balance_updated':
        return this.#applySnapshot({
          scope: input.scope,
          subject: 'balances',
          mode: 'upsert-only',
          rows: [input.balance],
          source: input.provenance.source,
          asOfMs: getProvenanceAsOfMs(input.provenance),
          provenance: input.provenance,
        });
      case 'stream_gap':
        return this.#applyStreamHealthFact({
          type: 'stream_health',
          scope: input.scope,
          status: 'gap',
          reason: input.reason,
          atMs: input.provenance.receivedAtMs,
          provenance: input.provenance,
        });
    }
  }

  /**
   * Shared snapshot reducer for all row types.
   *
   * It validates row shape and scope, upserts by row identity, then applies
   * replacement semantics only to rows covered by the snapshot input.
   */
  #applyRows<T extends Row>(
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

      if (input.subject === 'positions' && isTerminalPosition(row)) {
        if (collection.delete(key)) {
          changeSet.itemsRemoved++;
          changeSet.changed = true;
        }
        continue;
      }

      const existingKey = findExistingKey(collection, row);
      const existing = existingKey ? collection.get(existingKey) : undefined;
      if (!existing) {
        collection.set(key, cloneRow(row));
        changeSet.itemsAdded++;
        changeSet.changed = true;
        continue;
      }

      if (existingKey && existingKey !== key) {
        collection.delete(existingKey);
      }

      if (!areRowsEqual(existing, row)) {
        collection.set(key, cloneRow(row));
        changeSet.itemsUpdated++;
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
      changeSet.itemsRemoved += replacementResult.terminal;
      changeSet.itemsMarkedStale += replacementResult.stale;
    }
  }

  /**
   * Decide whether an existing position is covered by this snapshot.
   *
   * Position-side coverage lets hedge-mode syncs replace only LONG or
   * SHORT without deleting the opposite side for the same symbol.
   */
  #isPositionCovered(
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
   * and trigger/conditional orders, from terminating each other accidentally.
   */
  #isOrderCovered(
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
  #isBalanceCovered(
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
  #isFillCovered(fill: NormalizedFill, input: SnapshotInput<unknown>): boolean {
    if (input.mode === 'replace-symbols' && !hasCoveredSymbol(input.coverage)) {
      return false;
    }

    return isSymbolCovered(fill.symbol, input.coverage);
  }

  /**
   * Find an existing order using any shared exchange/custom identity.
   *
   * This allows a local client-id-only order to converge with a later REST row
   * that includes the exchange order id.
   */
  #findExistingOrderKey(
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
   * caller can sync or reconcile before planning more submissions.
   */
  #handleMissingOpenOrder = (
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
   * Enrich normalized app-owned order rows with metadata from registered
   * parsers before identity/lifecycle logic sees them.
   */
  #prepareOpenOrderRows(rows: unknown[]): unknown[] {
    return rows.map((row) =>
      isNormalizedOrder(row) ? this.#prepareOpenOrder(row) : row,
    );
  }

  /**
   * Apply managed order parsers to a single normalized order row.
   */
  #prepareOpenOrder(order: NormalizedOrder): NormalizedOrder {
    return applyManagedOrderParsers(order, this.#managedOrderParsers);
  }

  /**
   * Keep lifecycle state derived from the current position/open-order view.
   */
  #reconcileLifecycles(
    state: ScopeState,
    scope: AccountScope,
    changeSet: ChangeSet,
  ): void {
    const { lifecycles, changes } = reconcilePositionLifecycles({
      scope,
      lifecycles: state.lifecycles,
      positions: Array.from(state.positions.values()),
      openOrders: Array.from(state.openOrders.values()),
    });

    if (changes.length === 0) {
      return;
    }

    state.lifecycles = lifecycles;
    changeSet.lifecycleChanges.push(...changes);
    changeSet.changed = true;
    addChangedSubject(changeSet, 'lifecycles');
  }

  /**
   * Look up state without creating it, used by reads so unknown scopes remain
   * unknown instead of becoming empty-but-synced.
   */
  #getScopeState(scope: AccountScope): ScopeState | undefined {
    return this.#scopes.get(createScopeKey(scope));
  }

  /**
   * Create mutable reducer storage for a scope the first time a fact is applied.
   */
  #getOrCreateScopeState(scope: AccountScope): ScopeState {
    const key = createScopeKey(scope);
    const existing = this.#scopes.get(key);
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
      syncRequests: new Map(),
    };
    this.#scopes.set(key, created);
    return created;
  }

  /**
   * Remove an open order by any supplied identity fields.
   */
  #removeOrderByIdentity(
    collection: Map<string, NormalizedOrder>,
    identity: OrderIdentity,
  ): number {
    let terminalRows = 0;
    for (const [key, order] of Array.from(collection.entries())) {
      if (orderMatchesIdentity(order, identity)) {
        collection.delete(key);
        terminalRows++;
      }
    }

    return terminalRows;
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
 * Normalize a locally accepted submission into the provisional open-order row
 * the planner should see before exchange confirmation arrives.
 */
function createProvisionalOrder(
  input: LocalSubmissionAcceptedFact,
): NormalizedOrder {
  const order = cloneOrder(input.order);
  return {
    ...order,
    customClientOrderId: order.customClientOrderId ?? input.clientId,
    status: 'provisional',
    source: 'local',
    acceptedAtMs: input.acceptedAtMs,
    updatedAtMs: input.acceptedAtMs,
  };
}

/**
 * Build an order identity from a local client id, if one is available.
 */
function identityFromClientId(
  clientId: string | undefined,
): OrderIdentity | undefined {
  return clientId ? { customClientOrderId: clientId } : undefined;
}

/**
 * Store a sync request by subject/reason so repeated unknown results update
 * the request instead of creating duplicate scheduler work.
 */
function addSyncRequest(state: ScopeState, request: SyncRequest): boolean {
  const key = getSyncRequestKey(request);
  const cloned = cloneSyncRequest(request);
  const existing = state.syncRequests.get(key);
  state.syncRequests.set(key, cloned);

  return JSON.stringify(existing) !== JSON.stringify(cloned);
}

/**
 * Clear explicit sync requests after an authoritative snapshot has satisfied
 * that subject's pending scheduler work.
 */
function clearSyncRequestsForSubject(
  state: ScopeState,
  subject: SyncSubject,
): number {
  let cleared = 0;
  for (const [key, request] of Array.from(state.syncRequests.entries())) {
    if (request.subject === subject) {
      state.syncRequests.delete(key);
      cleared++;
    }
  }

  return cleared;
}

/**
 * Locate another active order with the same custom client id.
 */
function findDuplicateActiveClientOrder(
  collection: Map<string, NormalizedOrder>,
  candidate: NormalizedOrder,
  candidateExistingKey: string | undefined,
): NormalizedOrder | undefined {
  if (!candidate.customClientOrderId) {
    return undefined;
  }

  for (const [key, existing] of collection.entries()) {
    if (key === candidateExistingKey) {
      continue;
    }
    if (
      existing.customClientOrderId === candidate.customClientOrderId &&
      isActiveOrProvisionalOrder(existing)
    ) {
      return cloneOrder(existing);
    }
  }

  return undefined;
}

/**
 * Return true for order states that should block reusing a custom client id.
 */
function isActiveOrProvisionalOrder(order: NormalizedOrder): boolean {
  return (
    order.status === 'new' ||
    order.status === 'partially_filled' ||
    order.status === 'pending_cancel' ||
    order.status === 'provisional'
  );
}

function isTerminalPosition(row: Row): row is NormalizedPosition {
  return (
    isNormalizedPosition(row) &&
    (row.strategySide === 'FLAT' || isZeroDecimalString(row.quantity))
  );
}

function isZeroDecimalString(value: string): boolean {
  return Number(value) === 0;
}

/**
 * Build a neutral change set for one state operation.
 */
function createEmptyChangeSet(scope: AccountScope): ChangeSet {
  return {
    scope: copyScope(scope),
    changed: false,
    changedSubjects: [],
    itemsAdded: 0,
    itemsUpdated: 0,
    itemsRemoved: 0,
    itemsMarkedStale: 0,
    confidenceChanged: false,
    lifecycleChanges: [],
    warnings: [],
  };
}

function addChangedSubject(
  changeSet: ChangeSet,
  subject: AccountChangeSubject,
): void {
  if (!changeSet.changedSubjects.includes(subject)) {
    changeSet.changedSubjects.push(subject);
  }
}

function getChangedItemCount(changeSet: ChangeSet): number {
  return (
    changeSet.itemsAdded +
    changeSet.itemsUpdated +
    changeSet.itemsRemoved +
    changeSet.itemsMarkedStale
  );
}

/**
 * Prefer exchange event time for stream-derived watermarks, then local receipt.
 */
function getProvenanceAsOfMs(provenance: Provenance): number {
  return provenance.exchangeEventTimeMs ?? provenance.receivedAtMs;
}

/**
 * Match position query helpers without collapsing hedge-mode sides.
 */
function positionMatchesFilter(
  position: NormalizedPosition,
  filter: PositionFilter,
): boolean {
  return (
    matchesOptional(position.symbol, filter.symbol) &&
    matchesOptional(
      position.exchangePositionSide,
      filter.exchangePositionSide,
    ) &&
    matchesOptional(position.strategySide, filter.strategySide)
  );
}

/**
 * Match open-order query helpers by common exchange-facing fields.
 */
function openOrderMatchesFilter(
  order: NormalizedOrder,
  filter: OpenOrderFilter,
): boolean {
  return (
    matchesOptional(order.symbol, filter.symbol) &&
    matchesOptional(order.kind, filter.kind) &&
    matchesOptional(order.status, filter.status) &&
    matchesOptional(order.owner, filter.owner) &&
    matchesOptional(order.exchangeOrderId, filter.exchangeOrderId) &&
    matchesOptional(order.customClientOrderId, filter.customClientOrderId) &&
    matchesOptional(order.customTriggerOrderId, filter.customTriggerOrderId) &&
    matchesOptional(order.exchangeTriggerOrderId, filter.exchangeTriggerOrderId)
  );
}

/**
 * Match fills by symbol, trade id, or order identity.
 */
function fillMatchesFilter(fill: NormalizedFill, filter: FillFilter): boolean {
  return (
    matchesOptional(fill.symbol, filter.symbol) &&
    matchesOptional(fill.exchangeTradeId, filter.exchangeTradeId) &&
    matchesOptional(fill.exchangeOrderId, filter.exchangeOrderId) &&
    matchesOptional(fill.customClientOrderId, filter.customClientOrderId) &&
    matchesOptional(fill.customTriggerOrderId, filter.customTriggerOrderId)
  );
}

function matchesOptional<T>(
  value: T | undefined,
  expected: T | undefined,
): boolean {
  return expected === undefined || value === expected;
}

/**
 * `replace-symbols` requires explicit symbol coverage before any existing row
 * can be considered absent.
 */
function hasCoveredSymbol(coverage: SyncCoverage | undefined): boolean {
  return Boolean(coverage?.symbols?.length);
}

/**
 * Check whether a symbol is inside the snapshot coverage. Missing coverage means
 * full-scope coverage for modes that allow it.
 */
function isSymbolCovered(
  symbol: string,
  coverage: SyncCoverage | undefined,
): boolean {
  return !coverage?.symbols || coverage.symbols.includes(symbol);
}

/**
 * Check whether a row's order kind is inside a partial open-order snapshot.
 */
function isOrderKindCovered(
  kind: NormalizedOrder['kind'],
  coverage: SyncCoverage | undefined,
): boolean {
  return !coverage?.orderKinds || coverage.orderKinds.includes(kind);
}

/**
 * Check whether a position slot is inside a partial position snapshot.
 */
function isPositionSideCovered(
  positionSide: string,
  coverage: SyncCoverage | undefined,
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
  coverage: SyncCoverage | undefined,
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
 * internal reducer state after a snapshot is applied.
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
