import type { Page } from '@playwright/test';

class BridgePage {
  private readonly page: Page;

  constructor({ page }: { page: Page }) {
    this.page = page;
  }

  async navigate(): Promise<void> {
    await this.page.goto('/');
  }
}

export { BridgePage };
