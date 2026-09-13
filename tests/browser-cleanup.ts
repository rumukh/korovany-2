import { rm } from 'node:fs/promises';
import { closeAllPages, type LaunchedBrowser } from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeOwnedBrowser } from '../vendor/aegis-engine/packages/render-three/src/testing/browser-lifecycle';

export async function closeTestBrowser(browser: LaunchedBrowser): Promise<void> {
  try {
    if (browser.process.exitCode === null && browser.process.signalCode === null) {
      await closeAllPages(browser.port);
    }
  } finally {
    try {
      await closeOwnedBrowser(browser);
    } finally {
      if (browser.process.exitCode !== null || browser.process.signalCode !== null) {
        await rm(browser.profile, { recursive: true, force: true });
      }
    }
  }
}
