/**
 * Browser lifecycle — the single place Playwright is launched. Fixed 1280x800
 * viewport at deviceScaleFactor 1 so screenshots are exactly viewport-sized
 * pixels (a Retina host would otherwise double them and break coordinate math).
 * Headless by default; the harness may run headed for local debugging.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

export const VIEWPORT = { width: 1280, height: 800 } as const;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export interface LaunchOptions {
  headless?: boolean;
}

export async function launchBrowser(opts: LaunchOptions = {}): Promise<BrowserSession> {
  const headless = opts.headless ?? true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const close = async (): Promise<void> => {
    await context.close();
    await browser.close();
  };

  return { browser, context, page, close };
}
