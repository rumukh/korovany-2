import type { CdpSession } from "../vendor/aegis-engine/packages/render-three/src/browser";

type PageConnection = Pick<CdpSession, "send">;
interface FrameTree { frameTree: { frame: { id: string; loaderId: string } } }
interface Evaluation {
  result: { value?: boolean };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

const replacedContext = /^(Inspected target navigated or closed|Cannot find context with specified id|Execution context was destroyed(?:\.|,.*)?)$/;

async function changeDocument(
  cdp: PageConnection, url: string | null, ready: string, timeoutMs: number,
): Promise<void> {
  const before = (await cdp.send<FrameTree>("Page.getFrameTree")).frameTree.frame;
  if (url === null) await cdp.send("Page.reload", { loaderId: before.loaderId });
  else {
    const navigation = await cdp.send<{ errorText?: string }>("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`Navigation to ${url} failed: ${navigation.errorText}`);
  }
  const deadline = Date.now() + timeoutMs;
  let loaderId = before.loaderId;
  let replacements = 0;
  while (Date.now() < deadline) {
    loaderId = (await cdp.send<FrameTree>("Page.getFrameTree")).frameTree.frame.loaderId;
    if (loaderId !== before.loaderId) {
      let evaluated: Evaluation | undefined;
      try {
        evaluated = await cdp.send<Evaluation>("Runtime.evaluate", {
          expression: `Boolean(${ready})`, returnByValue: true, awaitPromise: false,
        });
      } catch (error) {
        // Only document replacement during this requested navigation is retryable.
        if (!(error instanceof Error) || !replacedContext.test(error.message)) throw error;
        replacements++;
        console.warn(`Browser navigation replaced its execution context (${replacements}): ${error.message}`);
      }
      if (evaluated?.exceptionDetails) {
        throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
      }
      if (evaluated?.result.value === true) return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Navigation did not reach ${ready} within ${timeoutMs}ms; loader ${before.loaderId} -> ${loaderId}, context replacements ${replacements}.`);
}

export function reloadTestPage(
  cdp: PageConnection,
  ready = "window.korovany && window.korovany.inspect().overlay === 'menu'",
  timeoutMs = 30_000,
): Promise<void> {
  return changeDocument(cdp, null, ready, timeoutMs);
}

export function navigateTestPage(cdp: PageConnection, url: string, ready: string, timeoutMs = 30_000): Promise<void> {
  return changeDocument(cdp, url, ready, timeoutMs);
}
