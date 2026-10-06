import type { ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  closeAllPages, launchBrowser, type LaunchedBrowser, type LaunchOptions,
} from '../vendor/aegis-engine/packages/render-three/src/browser';

/** How long an owned browser may take to answer `Browser.close` and exit before it is killed and the suite fails. */
export const BROWSER_CLOSE_TIMEOUT_MS = 20_000;
const KILL_TIMEOUT_MS = 5_000;
const SLOW_TEARDOWN_MS = 5_000;
const launchFailure = /never published a DevTools port|did not expose a DevTools endpoint/;

/**
 * Launch an owned test browser. A launch whose process never publishes its DevTools endpoint is retried once with a
 * fresh profile; no test has run at that point, and a second failure still fails the suite.
 */
export async function launchTestBrowser(options?: LaunchOptions): Promise<LaunchedBrowser> {
  try {
    return await launchBrowser(options);
  } catch (error) {
    if (!(error instanceof Error) || !launchFailure.test(error.message)) throw error;
    console.warn(`[browser-cleanup] browser launch failed, launching once more: ${error.message}`);
    return launchBrowser(options);
  }
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
const describeExit = (child: ChildProcess): string =>
  child.signalCode !== null ? `signal ${child.signalCode}` : `code ${child.exitCode}`;

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), Math.max(0, timeoutMs));
    child.once('exit', onExit);
  });
}

/**
 * The browser-level DevTools endpoint. Chrome writes its path on the second line of `DevToolsActivePort`, so no HTTP
 * request has to reach a browser that may still be busy tearing its pages down.
 */
async function browserEndpoint(browser: LaunchedBrowser, timeoutMs: number): Promise<string> {
  try {
    const path = (await readFile(join(browser.profile, 'DevToolsActivePort'), 'utf8')).split('\n')[1]?.trim();
    if (path?.startsWith('/devtools/browser/')) return `ws://127.0.0.1:${browser.port}${path}`;
  } catch {
    // Fall back to the version endpoint below.
  }
  const response = await fetch(`http://127.0.0.1:${browser.port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  const version = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof version.webSocketDebuggerUrl !== 'string') {
    throw new Error('Owned browser did not provide its browser-level debugger endpoint.');
  }
  return version.webSocketDebuggerUrl;
}

/**
 * Ask the browser to close. Chrome may exit before its acknowledgement leaves the socket, so a connection that closes
 * after the request is an answer as well; whether the browser really exited cleanly is decided by its process.
 */
function requestClose(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const socket = new WebSocket(url);
    const finish = (outcome: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish(`no answer within ${timeoutMs} ms`), timeoutMs);
    socket.addEventListener('open', () => {
      opened = true;
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    });
    socket.addEventListener('message', (event) => {
      let reply: { id?: unknown; error?: { message?: string } };
      try {
        reply = JSON.parse(String(event.data)) as typeof reply;
      } catch {
        return;
      }
      if (reply.id === 1) finish(reply.error ? `refused (${reply.error.message ?? 'no message'})` : 'acknowledged');
    });
    const closed = (): void => finish(opened ? 'connection closed before an acknowledgement' : 'endpoint unreachable');
    socket.addEventListener('close', closed);
    socket.addEventListener('error', closed);
  });
}

/**
 * End a test's owned browser: drain its pages, request a browser-level close and require the process to exit with
 * code 0. A browser that had already exited, exits uncleanly or has to be killed fails the suite. The profile is
 * removed once the process is gone, retrying while Chrome's helper processes finish writing into it.
 */
export async function closeTestBrowser(browser: LaunchedBrowser, timeoutMs = BROWSER_CLOSE_TIMEOUT_MS): Promise<void> {
  const started = Date.now();
  const child = browser.process;
  const failures: unknown[] = [];
  const steps: string[] = [];
  const step = (label: string): void => {
    steps.push(`${label} at ${Date.now() - started} ms`);
  };
  if (hasExited(child)) {
    if (child.exitCode !== 0) failures.push(new Error(`Owned browser exited unexpectedly: ${describeExit(child)}.`));
  } else {
    try {
      await closeAllPages(browser.port);
      step('pages closed');
    } catch (error) {
      failures.push(error);
      step('page drain failed');
    }
    const deadline = Date.now() + timeoutMs;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    let outcome: string;
    try {
      outcome = await requestClose(await browserEndpoint(browser, remaining()), remaining());
    } catch (error) {
      outcome = `endpoint unavailable (${error instanceof Error ? error.message : String(error)})`;
    }
    step(`Browser.close ${outcome}`);
    if (await waitForExit(child, deadline - Date.now())) {
      step(`exited with ${describeExit(child)}`);
      if (child.exitCode !== 0) {
        failures.push(new Error(`Owned browser did not exit cleanly after Browser.close (${outcome}): ${describeExit(child)}.`));
      }
    } else {
      child.kill('SIGKILL');
      const stopped = await waitForExit(child, KILL_TIMEOUT_MS);
      step(stopped ? 'killed' : 'kill failed');
      failures.push(new Error(
        `Owned browser did not exit within ${timeoutMs} ms of Browser.close (${outcome}); ` +
          (stopped ? 'it was killed.' : 'killing it failed.'),
      ));
    }
  }
  if (hasExited(child)) {
    try {
      await rm(browser.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      failures.push(error);
    }
  }
  const elapsed = Date.now() - started;
  if (elapsed > SLOW_TEARDOWN_MS || failures.length > 0) {
    console.warn(`[browser-cleanup] teardown took ${elapsed} ms: ${steps.join('; ') || 'browser had already exited'}`);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Owned browser teardown failed.');
}
