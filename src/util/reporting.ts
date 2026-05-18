import { AccountStateStore } from '../AccountStateStore.js';
import {
  getUnrealisedPnl,
  getUnrealsedPnlPct,
  getDepthPercentForAllPositions,
} from './position.math.js';
import { hasStatusCode, postDataToUrl } from './postDataToURL.js';
import { isNumber } from './type-guards.js';

export interface BalanceUpdateEventData {
  balance: number;
  balanceSymbol: string;
  upnlValue: number;
  upnlPercent: number;
  upnlBalance: number;
  depthPercent: number;
  leaderCount: number;
  hedgeCount: number;
}

interface BalanceUpdateEvent {
  updateData: BalanceUpdateEventData;
  accountKey: string;
  timestamp: number;
  /** Constraint we can use to restrict visibility to accounts in the dashboard */
  viewTags: string;
}

async function postBalanceToServer(
  API_URL: string,
  updateData: BalanceUpdateEventData,
  eventTime: number,
  accountDesc: string,
  viewTags = '',
): Promise<unknown> {
  const event: BalanceUpdateEvent = {
    updateData,
    accountKey: accountDesc,
    timestamp: eventTime,
    viewTags: viewTags,
  };

  return postDataToUrl(API_URL, event);
}

export async function reportBalanceToApi(
  API_URL: string,
  accountId: string,
  accountViewTags: string[],
  updateData: BalanceUpdateEventData,
  silent?: boolean,
): Promise<void> {
  try {
    if (!isNumber(updateData.balance)) {
      throw new Error(
        `Balance is not a number: ${
          updateData.balance
        } | ${typeof updateData.balance}`,
      );
    }

    const res = await postBalanceToServer(
      API_URL,
      updateData,
      Date.now(),
      accountId,
      accountViewTags.join(','),
    );

    if (!silent) {
      console.log(
        `reportBalanceToApi(): Submitted API balance update: ${res} + ${JSON.stringify(
          updateData,
        )}`,
      );
    }

    if (hasStatusCode(res) && res['statusCode'] !== 200) {
      throw new Error(`Balance API submission error: ${res}`);
    }
  } catch (e: any) {
    console.error(
      `reportBalanceToApi(): exception seen in reporting balance update: ${JSON.stringify(
        { error: e?.stack, updateData, accountId, accountViewTags },
        null,
        2,
      )}`,
    );
    throw e;
  }
}

/**
 * Small utility method to generate a report (summary) on account state and send that report to a URL via a POST request
 *
 * @param API_URL
 * @param accountId
 * @param accountViewTags
 * @param state
 * @param quoteBalanceAsset
 */
export async function reportBalanceToServer(
  API_URL: string,
  accountId: string,
  accountViewTags: string[],
  state: AccountStateStore,
  quoteBalanceAsset: string,
  silent?: boolean,
) {
  const totalPositions = state.getTotalActivePositions();
  const walletBalance = state.getWalletBalance();
  const positions = state.getAllPositions();

  const upnlValue = getUnrealisedPnl(positions);
  const upnlPercent = getUnrealsedPnlPct(positions, walletBalance);
  const depthPercent = getDepthPercentForAllPositions(
    positions,
    walletBalance,
    state.getSymbolLeverageCache(),
    quoteBalanceAsset,
  );

  const data: BalanceUpdateEventData = {
    balance: walletBalance,
    balanceSymbol: quoteBalanceAsset,
    leaderCount: totalPositions.total,
    hedgeCount: totalPositions.totalHedged,
    upnlBalance: walletBalance + upnlValue,
    depthPercent: depthPercent,
    upnlPercent: upnlPercent,
    upnlValue: upnlValue,
  };

  return reportBalanceToApi(API_URL, accountId, accountViewTags, data, silent);
}
