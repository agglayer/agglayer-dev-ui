import type { Page } from '@playwright/test';

class BridgePage {
  private readonly page: Page;

  constructor({ page }: { page: Page }) {
    this.page = page;
  }

  async navigate(): Promise<void> {
    await this.page.goto('/');
  }

  async connectWallet(): Promise<void> {
    const header = this.page.getByTestId('header-desktop');
    await header.getByTestId('connect-wallet').click();
    await header.getByTestId('wallet-connected').waitFor();
  }

  async openTokenSelector(): Promise<void> {
    await this.page.getByTestId('token-selector-trigger').click();
    await this.page.getByTestId('token-selector-list').waitFor();
  }

  getTokenRow(symbol: string) {
    return this.page.getByTestId(`token-item-${symbol.toLowerCase()}`);
  }

  getTokenBalance(symbol: string) {
    return this.page.getByTestId(`token-balance-${symbol.toLowerCase()}`);
  }
}

export { BridgePage };
