import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { ensureServer } from "./client";
import { runServer } from "./server";
import { App } from "./tui/App";

if (process.argv.includes("server")) {
  await runServer();
  process.exit(0);
}

await ensureServer();

let rendererDestroyed = false;
let resolveRendererDestroyed: () => void = () => {};
const rendererDestroyedPromise = new Promise<void>((resolve) => {
  resolveRendererDestroyed = resolve;
});

const renderer = await createCliRenderer({
  // The app owns Ctrl-C/signals so we can wait for OpenTUI's *native* terminal
  // teardown before exiting. OpenTUI's "destroy" event fires before that teardown.
  exitOnCtrlC: false,
  exitSignals: [],
  onDestroy: () => {
    rendererDestroyed = true;
    resolveRendererDestroyed();
  },
});

let shutdownStarted = false;
const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const forceTerminalSane = () => {
  // Best-effort fallback for interrupted native cleanup: show cursor, leave the
  // alternate screen, disable common mouse modes, and reset keypad/bracketed paste.
  process.stdout.write(
    "\x1b[?25h\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1l\x1b>",
  );
  if (process.stdin.setRawMode) process.stdin.setRawMode(false);
};

const shutdown = (code = 0, err?: unknown) => {
  if (shutdownStarted) return;
  shutdownStarted = true;

  void (async () => {
    try {
      if (!rendererDestroyed) renderer.destroy();
      await Promise.race([rendererDestroyedPromise, wait(1000)]);
      if (!rendererDestroyed) forceTerminalSane();
    } catch {
      forceTerminalSane();
    }

    if (err !== undefined) console.error(err);
    process.exit(code);
  })();
};

createRoot(renderer).render(
  <App onQuit={() => process.nextTick(() => shutdown(0))} />,
);

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("SIGHUP", () => shutdown(129));
process.on("uncaughtException", (err) => shutdown(1, err));
process.on("unhandledRejection", (err) => shutdown(1, err));
