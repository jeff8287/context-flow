// A headless Chrome driven over its debugging port, with nothing but what Node has: enough to open a page, press,
// type, read what the page says and take a picture of it. demo/shots.ts takes the walk-through's pictures with it.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const USUAL = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];
/** The browser to drive: the one CONTEXT_FLOW_CHROME names, or the first of the usual places that has one. */
export function findChrome(): string | null {
  const named = process.env.CONTEXT_FLOW_CHROME;
  if (named) return existsSync(named) ? named : null;
  return USUAL.find((path) => existsSync(path)) ?? null;
}

/** A place on the page, in its own pixels. */
export type Spot = [number, number];

export interface Page {
  /** What the page itself complained of: errors thrown and errors written to its console. */
  errors: string[];
  send(method: string, params?: object): Promise<any>;
  goto(url: string): Promise<void>;
  /** The value of an expression in the page. A promise is waited for. */
  eval<T = unknown>(expression: string): Promise<T>;
  /** Waits until the expression is true in the page; what: said if it never is. */
  wait(expression: string, what: string, ms?: number): Promise<void>;
  /** The middle of the first thing a selector finds, where it is now; null if it finds nothing. */
  at(selector: string): Promise<Spot | null>;
  move(spot: Spot): Promise<void>;
  click(spot: Spot): Promise<void>;
  /** Pressed at one place, carried in steps to another and let go there. */
  drag(from: Spot, to: Spot): Promise<void>;
  /** Typed where the caret is (over what is selected there). */
  type(text: string): Promise<void>;
  key(key: string, code: number): Promise<void>;
  /** Gives files to a file input, as choosing them in its dialog does. */
  files(selector: string, paths: string[]): Promise<void>;
  shot(path: string): Promise<void>;
}

export async function launch(chrome: string, size: { width: number; height: number }): Promise<{ page: Page; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "context-flow-chrome-"));
  // port 0: Chrome takes a free one, and says which in a file in its folder
  const flags = ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + dir, "--no-first-run", "--no-default-browser-check", "--window-size=" + size.width + "," + size.height, "--hide-scrollbars"];
  // Chrome will not run as root with its sandbox, and root is what a container runs as; a container's /dev/shm is too
  // small for Chrome as well
  if (process.getuid?.() === 0) flags.push("--no-sandbox");
  if (process.platform === "linux") flags.push("--disable-dev-shm-usage");
  const child = spawn(chrome, [...flags, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  // what Chrome says of itself, kept to tell why it did not start
  let said = "";
  child.stderr.on("data", (chunk) => { said = (said + chunk).slice(-4000); });
  let ended = false;
  child.on("exit", () => { ended = true; });
  const quit = async () => {
    child.kill();
    await sleep(400);
    rmSync(dir, { recursive: true, force: true });
  };
  let address = "";
  for (let tries = 0; tries < 100 && !address && !ended; tries += 1) {
    await sleep(150);
    try {
      const port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]);
      const list = (await (await fetch("http://127.0.0.1:" + port + "/json")).json()) as { type: string; webSocketDebuggerUrl?: string }[];
      address = list.find((one) => one.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch { /* not up yet */ }
  }
  if (!address) {
    await quit();
    const last = said.trim().split("\n").filter(Boolean).slice(-3).join("\n");
    throw new Error("the browser did not start: " + chrome + (last ? "\n" + last : ""));
  }
  const socket = new WebSocket(address);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("the browser's debugging port did not answer"));
  });
  let last = 0;
  const asked = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const errors: string[] = [];
  socket.onmessage = (message) => {
    const got = JSON.parse(String(message.data));
    if (got.id) {
      const one = asked.get(got.id);
      asked.delete(got.id);
      if (got.error) one?.reject(new Error(got.error.message));
      else one?.resolve(got.result);
    } else if (got.method === "Runtime.exceptionThrown") errors.push(String(got.params.exceptionDetails.exception?.description ?? got.params.exceptionDetails.text));
    else if (got.method === "Runtime.consoleAPICalled" && got.params.type === "error") errors.push(got.params.args.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description).join(" "));
  };
  const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const id = ++last;
    asked.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }); // the page takes itself to be looked at
  const mouse = (type: string, [x, y]: Spot, held: boolean) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: held ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
  const page: Page = {
    errors,
    send,
    async goto(url) {
      await send("Page.navigate", { url });
      await sleep(800);
    },
    async eval<T>(expression: string) {
      const got = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (got.exceptionDetails) throw new Error(String(got.exceptionDetails.exception?.description ?? got.exceptionDetails.text));
      return got.result.value as T;
    },
    async wait(expression, what, ms = 15_000) {
      const end = Date.now() + ms;
      for (;;) {
        if (await page.eval(expression).catch(() => false)) return;
        if (Date.now() > end) throw new Error(what);
        await sleep(120);
      }
    },
    at: (selector) => page.eval<Spot | null>("(() => { const one = document.querySelector(" + JSON.stringify(selector) + "); if (!one) return null; const box = one.getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()"),
    async move(spot) {
      await mouse("mouseMoved", spot, false);
      await sleep(150);
    },
    async click(spot) {
      await mouse("mouseMoved", spot, false);
      await mouse("mousePressed", spot, true);
      await mouse("mouseReleased", spot, false);
      await sleep(250);
    },
    async drag(from, to) {
      await mouse("mouseMoved", from, false);
      await mouse("mousePressed", from, true);
      for (let step = 1; step <= 12; step += 1) {
        await mouse("mouseMoved", [from[0] + ((to[0] - from[0]) * step) / 12, from[1] + ((to[1] - from[1]) * step) / 12], true);
        await sleep(30);
      }
      await mouse("mouseReleased", to, false);
      await sleep(300);
    },
    async type(text) {
      await send("Input.insertText", { text });
      await sleep(120);
    },
    async key(key, code) {
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await sleep(150);
    },
    async files(selector, paths) {
      const { root } = await send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
      await send("DOM.setFileInputFiles", { nodeId, files: paths });
      await sleep(400);
    },
    async shot(path) {
      const got = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(got.data, "base64"));
    },
  };
  return {
    page,
    async close() {
      socket.close();
      await quit();
    },
  };
}
