import type { Token } from '@/app/types/token';
import type { Locator, Page } from '@playwright/test';

import { ALL_WAGMI_CHAINS } from '@/app/config';
import { E2E_BRIDGE_SUCCESS_TIMEOUT_MS } from '@/app/constants/e2e';
import { STORAGE_KEYS } from '@/app/utils/storage';
import { expect } from '@playwright/test';

// Chain names shown by the from/to selectors come from config.json (via
// BridgeFromSection/BridgeToSection's chainOptions -> chain.name), so this
// looks the display name up by chainId rather than hardcoding it here --
// see assertChainPair below.
const getChainNameById = (chainId: number): string => {
  const chain = ALL_WAGMI_CHAINS.find((candidate) => candidate.id === chainId);
  if (!chain) {
    throw new Error(`E2E: chain ${chainId} is not configured in config.json's chains.`);
  }
  return chain.name;
};

class BridgePage {
  private readonly page: Page;
  readonly bridgeCard: Locator;
  readonly headerDesktop: Locator;
  readonly connectWalletButton: Locator;
  readonly walletConnectedBadge: Locator;
  readonly tokenSelectorTrigger: Locator;
  readonly tokenSelectorList: Locator;
  readonly amountInput: Locator;
  readonly bridgeCta: Locator;
  readonly transactionModal: Locator;
  readonly transactionModalHeadline: Locator;
  readonly bridgeSuccessView: Locator;
  readonly bridgeSuccessExplorerLink: Locator;
  readonly bridgeSuccessCta: Locator;
  readonly transactionsRefreshButton: Locator;
  readonly fromChainSelector: Locator;
  readonly toChainSelector: Locator;
  // Tracker UX (S6-S9 / S10 context pack): trackerDetail/closeModalButton are
  // page-scoped rather than row-scoped -- the details Modal renders via
  // createPortal(document.body) (modal.tsx), so it's not a DOM descendant of
  // the transaction row that triggers it.
  readonly trackerDetail: Locator;
  readonly closeModalButton: Locator;

  constructor({ page }: { page: Page }) {
    this.page = page;
    this.bridgeCard = page.getByTestId('bridge-card');
    this.headerDesktop = page.getByTestId('header-desktop');
    this.connectWalletButton = this.headerDesktop.getByTestId('connect-wallet');
    this.walletConnectedBadge = this.headerDesktop.getByTestId('wallet-connected');
    this.tokenSelectorTrigger = page.getByTestId('token-selector-trigger');
    this.tokenSelectorList = page.getByTestId('token-selector-list');
    this.amountInput = page.getByTestId('bridge-amount-input');
    this.bridgeCta = page.getByTestId('bridge-cta');
    this.transactionModal = page.getByTestId('bridge-transaction-modal');
    this.transactionModalHeadline = page.getByTestId('bridge-modal-headline');
    this.bridgeSuccessView = page.getByTestId('bridge-success-view');
    this.bridgeSuccessExplorerLink = page.getByTestId('bridge-success-explorer-link');
    this.bridgeSuccessCta = page.getByTestId('bridge-success-go-to-transactions');
    this.transactionsRefreshButton = page.getByTestId('transactions-refresh');
    this.fromChainSelector = page.getByTestId('from-chain-selector');
    this.toChainSelector = page.getByTestId('to-chain-selector');
    this.trackerDetail = page.getByTestId('tracker-detail');
    this.closeModalButton = page.getByRole('button', { name: 'Close modal' });
  }

  async navigate(): Promise<void> {
    await this.page.goto('/');
  }

  async connectWallet(): Promise<void> {
    await this.connectWalletButton.click();
    await this.walletConnectedBadge.waitFor();
  }

  async openTokenSelector(): Promise<void> {
    await this.tokenSelectorTrigger.click();
    await this.tokenSelectorList.waitFor();
  }

  async fillAmount(amount: string): Promise<void> {
    await this.amountInput.fill(amount);
  }

  async submitBridge(): Promise<void> {
    await this.bridgeCta.click();
  }

  async waitForTransactionModal(): Promise<void> {
    await this.transactionModal.waitFor();
  }

  async waitForBridgeSuccess(timeoutMs: number = E2E_BRIDGE_SUCCESS_TIMEOUT_MS): Promise<void> {
    await expect(this.transactionModalHeadline).toContainText('Transaction successful', {
      timeout: timeoutMs
    });
    await this.bridgeSuccessView.waitFor();
  }

  async seedCustomToken(
    token: Pick<Token, 'chainId' | 'address' | 'decimals' | 'symbol' | 'name'>
  ): Promise<void> {
    await this.page.addInitScript(
      ({ key, chainId, address, symbol, name, decimals }) => {
        const existingRaw = window.localStorage.getItem(key);
        const existing = existingRaw
          ? (JSON.parse(existingRaw) as Array<Record<string, unknown>>)
          : [];
        const normalizedAddress = address.toLowerCase();
        const withoutCurrentToken = existing.filter(
          (item) =>
            !(typeof item.address === 'string' && item.address.toLowerCase() === normalizedAddress)
        );

        const seeded = [
          ...withoutCurrentToken,
          {
            chainId,
            address,
            decimals,
            symbol,
            name,
            logoURI: '',
            isCustom: true
          }
        ];
        window.localStorage.setItem(key, JSON.stringify(seeded));
      },
      { key: STORAGE_KEYS.CUSTOM_TOKENS, ...token }
    );
  }

  async selectToken(symbol: string): Promise<void> {
    const tokenRow = this.getTokenRow(symbol);
    await tokenRow.waitFor();
    await tokenRow.click();
  }

  getTokenRow(symbol: string) {
    return this.page.getByTestId(`token-item-${symbol.toLowerCase()}`);
  }

  getTokenBalance(symbol: string) {
    return this.page.getByTestId(`token-balance-${symbol.toLowerCase()}`);
  }

  getBridgeStep(step: 'approve' | 'bridge') {
    return this.page.getByTestId(`bridge-step-${step}`);
  }

  getTransactionRow(transactionHash: string) {
    return this.page.getByTestId(`transaction-row-${transactionHash}`);
  }

  async refreshActivity(): Promise<void> {
    await this.transactionsRefreshButton.click();
  }

  // The destination dropdown excludes the currently-selected source
  // (createChainOptions(chains, excludeChainId), bridgeCard.tsx) and
  // selectFromChain auto-swaps the to-chain if you pick the current to-chain
  // (useBridge.ts's selectFromChain) -- so callers must select the from-chain
  // before the to-chain, which selectChainPair below enforces.
  async selectFromChain(chainId: number): Promise<void> {
    await this.fromChainSelector.click();
    await this.page.getByTestId(`from-chain-selector-option-${chainId}`).click();
  }

  async selectToChain(chainId: number): Promise<void> {
    await this.toChainSelector.click();
    await this.page.getByTestId(`to-chain-selector-option-${chainId}`).click();
  }

  async assertChainPair(fromChainId: number, toChainId: number): Promise<void> {
    await expect(this.fromChainSelector).toContainText(getChainNameById(fromChainId));
    await expect(this.toChainSelector).toContainText(getChainNameById(toChainId));
  }

  async selectChainPair(fromChainId: number, toChainId: number): Promise<void> {
    await this.selectFromChain(fromChainId);
    await this.selectToChain(toChainId);
    await this.assertChainPair(fromChainId, toChainId);
  }

  getTransactionStatus(transactionHash: string): Locator {
    return this.getTransactionRow(transactionHash).getByTestId('transaction-status');
  }

  // trackerProgressBar.tsx: row-scoped -- renders nothing while all_steps is
  // null and nothing for CLAIMED rows (useBridgeTracking disables its query
  // there), so absence of this locator is itself meaningful (S7's chosen
  // "bar disappears on CLAIMED" behavior).
  getTrackerBar(transactionHash: string): Locator {
    return this.getTransactionRow(transactionHash).getByTestId('tracker-progress');
  }

  getTrackerStep(transactionHash: string, index: number): Locator {
    return this.getTrackerBar(transactionHash).getByTestId(`tracker-step-${index}`);
  }

  // transactionDetailsModal.tsx's TrackerDetail mounts only while
  // tx.status !== 'CLAIMED' -- opening the modal after a row completes will
  // never show `trackerDetail`. `transaction-status` is a plain span with no
  // click stopPropagation (unlike the claim/external-link buttons elsewhere
  // in the row), so clicking it reliably reaches the row's own onSelect.
  async openTransactionDetails(transactionHash: string): Promise<void> {
    await this.getTransactionStatus(transactionHash).click();
  }

  async closeTransactionDetailsModal(): Promise<void> {
    await this.closeModalButton.click();
  }

  getTrackerDetailStep(index: number): Locator {
    return this.trackerDetail.getByTestId(`tracker-detail-step-${index}`);
  }

  getClaimButton(transactionHash: string): Locator {
    return this.getTransactionRow(transactionHash).getByTestId('claim-tokens-button');
  }

  getClaimManuallyNowButton(transactionHash: string): Locator {
    return this.getTransactionRow(transactionHash).getByTestId('claim-manually-now-button');
  }

  async clickClaim(transactionHash: string): Promise<void> {
    await this.getClaimButton(transactionHash).click();
  }

  /**
   * Bridges L1 -> L2 and waits for the deposit to autoclaim, crediting the
   * destination L2's per-origin `LocalBalanceTree` by `amount`.
   *
   * Any spec whose subject is an L2-SOURCED transfer of a token that did not
   * originate on that L2 (native ETH originates on L1, network 0) must call
   * this first. `bridgeAsset` decrements `AgglayerBridgeL2`'s
   * `LocalBalanceTree[originNetwork][token]` before releasing funds
   * (`contracts/sovereignChains/AgglayerBridgeL2.sol`
   * `_decreaseLocalBalanceTree`), and that tree is credited ONLY by a *claimed*
   * inbound deposit (`_increaseLocalBalanceTree`) -- never by the L2's genesis
   * native allocation, which bypasses the bridge entirely. Without a credit the
   * transfer reverts `LocalBalanceTreeUnderflow(originNetwork, originToken,
   * amount, available)` inside `eth_estimateGas`, which surfaces only as a
   * `waitForBridgeSuccess` timeout rather than a legible error.
   *
   * Funding the credit here, rather than inheriting one from whichever spec
   * happened to run earlier, is what makes such a spec independent of suite
   * order, of sharding, of `-g` filters and of accumulated enclave state.
   *
   * Leaves the browser on the transactions route; callers driving a further
   * chain-pair selection must `navigate()` + `connectWallet()` again.
   */
  async fundLocalBalanceTree({
    fromChainId,
    toChainId,
    amount,
    claimTimeoutMs
  }: {
    fromChainId: number;
    toChainId: number;
    amount: string;
    claimTimeoutMs: number;
  }): Promise<void> {
    await this.selectChainPair(fromChainId, toChainId);
    await this.fillAmount(amount);
    await this.submitBridge();
    await this.waitForTransactionModal();
    await this.waitForBridgeSuccess();

    const explorerHref = await this.bridgeSuccessExplorerLink.getAttribute('href');
    const transactionHash = explorerHref?.match(/0x[a-fA-F0-9]{64}$/)?.[0];
    if (!transactionHash) {
      throw new Error(
        'E2E: could not read the top-up deposit transaction hash from the success view'
      );
    }

    await this.bridgeSuccessCta.click();

    const row = this.getTransactionRow(transactionHash);
    await expect(row).toBeVisible();

    await expect
      .poll(
        async () => {
          await this.refreshActivity();
          return row
            .getByText('Completed')
            .isVisible()
            .catch(() => false);
        },
        {
          message: `Waiting for the ${fromChainId}->${toChainId} top-up deposit to reach Completed (CLAIMED)`,
          timeout: claimTimeoutMs,
          intervals: [5_000]
        }
      )
      .toBe(true);
  }
}

export { BridgePage };
