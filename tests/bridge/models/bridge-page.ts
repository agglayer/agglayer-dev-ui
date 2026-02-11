import { expect, type Locator, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '@/app/utils/storage';
import type { Token } from '@/app/types/token';

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

  async waitForBridgeSuccess(): Promise<void> {
    await expect(this.transactionModalHeadline).toContainText('Transaction successful', { timeout: 120_000 });
    await this.bridgeSuccessView.waitFor();
  }

  async seedCustomToken(token: Pick<Token, 'chainId' | 'address' | 'decimals' | 'symbol' | 'name'>): Promise<void> {
    await this.page.addInitScript(
      ({ key, chainId, address, symbol, name, decimals }) => {
        const existingRaw = window.localStorage.getItem(key);
        const existing = existingRaw ? (JSON.parse(existingRaw) as Array<Record<string, unknown>>) : [];
        const normalizedAddress = address.toLowerCase();
        const withoutCurrentToken = existing.filter(
          (item) => !(typeof item.address === 'string' && item.address.toLowerCase() === normalizedAddress),
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
            isCustom: true,
          },
        ];
        window.localStorage.setItem(key, JSON.stringify(seeded));
      },
      { key: STORAGE_KEYS.CUSTOM_TOKENS, ...token },
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
}

export { BridgePage };
