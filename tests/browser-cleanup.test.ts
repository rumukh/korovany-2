import { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LaunchedBrowser } from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeAllPages, launchBrowser } from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeTestBrowser, launchTestBrowser } from './browser-cleanup';

vi.mock('../vendor/aegis-engine/packages/render-three/src/browser', () => ({
  closeAllPages: vi.fn(async () => undefined),
  launchBrowser: vi.fn(),
}));

class BrowserProcess extends ChildProcess {
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

type Behaviour = 'acknowledge' | 'close-before-acknowledging' | 'never-answer' | 'unreachable';
let behaviour: Behaviour;
let exitAfterClose: number | null;
let owned: BrowserProcess;
const connections: string[] = [];

class FakeSocket {
  readonly #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  constructor(url: string) {
    connections.push(url);
    setTimeout(() => this.#emit(behaviour === 'unreachable' ? 'error' : 'open', {}), 0);
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string };
    expect(request.method).toBe('Browser.close');
    if (behaviour === 'acknowledge') {
      setTimeout(() => {
        this.#emit('message', { data: JSON.stringify({ id: request.id, result: {} }) });
        if (exitAfterClose !== null) owned.exit(exitAfterClose);
      }, 0);
    } else if (behaviour === 'close-before-acknowledging') {
      setTimeout(() => {
        if (exitAfterClose !== null) owned.exit(exitAfterClose);
        this.#emit('close', {});
      }, 0);
    }
  }
  close(): void {}
  #emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function ownedBrowser(): Promise<LaunchedBrowser> {
  const profile = await mkdtemp(join(tmpdir(), 'korovany-cleanup-test-'));
  await writeFile(join(profile, 'DevToolsActivePort'), '45678\n/devtools/browser/owned-test\n');
  owned = new BrowserProcess();
  return { process: owned, port: 45678, profile };
}

beforeEach(() => {
  behaviour = 'acknowledge';
  exitAfterClose = 0;
  connections.length = 0;
  vi.mocked(closeAllPages).mockClear();
  vi.mocked(launchBrowser).mockReset();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('owned test browser teardown', () => {
  test('drains pages, closes through the browser endpoint from DevToolsActivePort and removes the profile', async () => {
    const browser = await ownedBrowser();
    const kill = vi.spyOn(owned, 'kill');
    await closeTestBrowser(browser);
    expect(closeAllPages).toHaveBeenCalledExactlyOnceWith(45678);
    expect(connections).toEqual(['ws://127.0.0.1:45678/devtools/browser/owned-test']);
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(browser.profile)).toBe(false);
    expect(owned.listenerCount('exit')).toBe(0);
  });

  test('accepts a connection that closes before the acknowledgement when the browser exits cleanly', async () => {
    behaviour = 'close-before-acknowledging';
    const browser = await ownedBrowser();
    await closeTestBrowser(browser);
    expect(owned.exitCode).toBe(0);
    expect(existsSync(browser.profile)).toBe(false);
  });

  test('accepts a browser that exits cleanly on its own while its endpoint is unreachable', async () => {
    behaviour = 'unreachable';
    const browser = await ownedBrowser();
    setTimeout(() => owned.exit(0), 20);
    await closeTestBrowser(browser);
    expect(existsSync(browser.profile)).toBe(false);
  });

  test('fails when the browser exits uncleanly after Browser.close', async () => {
    exitAfterClose = 1;
    const browser = await ownedBrowser();
    await expect(closeTestBrowser(browser)).rejects.toThrow('did not exit cleanly after Browser.close (acknowledged): code 1');
    expect(existsSync(browser.profile)).toBe(false);
  });

  test('kills a browser that does not exit in time and fails', async () => {
    behaviour = 'never-answer';
    const browser = await ownedBrowser();
    const kill = vi.spyOn(owned, 'kill').mockImplementation(() => {
      owned.exit(null, 'SIGKILL');
      return true;
    });
    await expect(closeTestBrowser(browser, 50)).rejects.toThrow('did not exit within 50 ms of Browser.close (no answer within');
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(existsSync(browser.profile)).toBe(false);
    expect(owned.listenerCount('exit')).toBe(0);
  });

  test('refuses a browser that had already crashed, without asking it to close', async () => {
    const browser = await ownedBrowser();
    owned.exit(2);
    await expect(closeTestBrowser(browser)).rejects.toThrow('Owned browser exited unexpectedly: code 2.');
    expect(closeAllPages).not.toHaveBeenCalled();
    expect(connections).toEqual([]);
    expect(existsSync(browser.profile)).toBe(false);
  });

  test('reports a failed page drain after still closing the browser', async () => {
    vi.mocked(closeAllPages).mockRejectedValueOnce(new Error('pages stayed open'));
    const browser = await ownedBrowser();
    await expect(closeTestBrowser(browser)).rejects.toThrow('pages stayed open');
    expect(owned.exitCode).toBe(0);
    expect(existsSync(browser.profile)).toBe(false);
  });
});

describe('owned test browser launch', () => {
  const launched = { process: new BrowserProcess(), port: 1, profile: 'unused' } satisfies LaunchedBrowser;

  test('launches once more when the first browser never published its DevTools port', async () => {
    vi.mocked(launchBrowser)
      .mockRejectedValueOnce(new Error('[aegis:render-three] browser never published a DevTools port.'))
      .mockResolvedValueOnce(launched);
    await expect(launchTestBrowser({ viewport: { width: 640, height: 480 } })).resolves.toBe(launched);
    expect(launchBrowser).toHaveBeenCalledTimes(2);
    expect(vi.mocked(launchBrowser).mock.calls).toEqual([
      [{ viewport: { width: 640, height: 480 } }], [{ viewport: { width: 640, height: 480 } }],
    ]);
  });

  test('fails when the second launch fails too', async () => {
    vi.mocked(launchBrowser).mockRejectedValue(new Error('[aegis:render-three] browser never published a DevTools port.'));
    await expect(launchTestBrowser()).rejects.toThrow('never published a DevTools port');
    expect(launchBrowser).toHaveBeenCalledTimes(2);
  });

  test('does not retry any other launch failure', async () => {
    vi.mocked(launchBrowser).mockRejectedValue(new Error('[aegis:render-three] no Chromium-family browser found.'));
    await expect(launchTestBrowser()).rejects.toThrow('no Chromium-family browser found');
    expect(launchBrowser).toHaveBeenCalledTimes(1);
  });
});
