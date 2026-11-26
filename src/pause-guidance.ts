import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { callMcp } from "./authorization.js";

const confirmation =
  /(?:Enter to retry, (?:s to skip [^\n]+, )?q\/EOF to cancel\. Other input is unsupported\.|^(?:\[Operator Pause\] [^\n]+: )?Enter to restart the entire [^\n]+, or q to exit Runner\.|^\[Enhancement Pause\] [\s\S]*\nEnter to continue\. Other input is unsupported\.)\n$/;

type Wait = {
  listener: ReturnType<typeof process.stdin.listeners>[number];
  controller: AbortController;
  dispatched: boolean;
};

export function startPauseGuidance(
  endpoint: string,
  launcherId: string,
  enabled: unknown = true,
  { input, output } = { input: process.stdin, output: process.stdout },
): () => void {
  if (typeof enabled !== "boolean")
    throw new Error("terminalPlugins.pauseGuidance must be a boolean.");
  if (!enabled) return () => {};

  const template = readFileSync(
    new URL("../prompts/runner-pause-guidance.md", import.meta.url),
    "utf8",
  );
  const originalWrite = output.write;
  const originalRemoveListener = input.removeListener;
  const baseline = new Set(input.listeners("data"));
  let recent = "";
  let candidate: Wait["listener"] | undefined;
  let active: Wait | undefined;
  let unsupported = false;
  let scheduled: NodeJS.Immediate | undefined;

  function cancel() {
    active?.controller.abort();
    active = undefined;
    unsupported = false;
  }

  function schedule() {
    scheduled ??= setImmediate(() => {
      scheduled = undefined;
      if (!active) return;
      if (!input.listeners("data").includes(active.listener)) {
        cancel();
        return;
      }
      if (active.dispatched) return;
      active.dispatched = true;
      void sendGuidance(
        endpoint,
        launcherId,
        template.replace("<output>", () => recent),
        active.controller.signal,
      );
    });
  }

  // Node 22 streams can omit the removeListener event when Core unpipes input.
  // Reconcile after the turn so an unsupported response can replace the listener.
  input.removeListener = function (event, listener) {
    const result = originalRemoveListener.call(input, event, listener);
    if (event === "data" && active?.listener === listener) schedule();
    return result;
  };

  output.write = function (...args: Parameters<typeof originalWrite>) {
    const result = Reflect.apply(originalWrite, output, args);
    const text =
      typeof args[0] === "string"
        ? args[0]
        : Buffer.from(args[0]).toString("utf8");
    recent = (recent + text).split("\n").slice(-15).join("\n");
    if (
      text === "Unsupported input.\n" &&
      active &&
      !input.listeners("data").includes(active.listener)
    ) {
      unsupported = true;
    }
    if (confirmation.test(text)) {
      const listeners = input
        .listeners("data")
        .filter((listener) => !baseline.has(listener));
      candidate = listeners.length === 1 ? listeners[0] : undefined;
    }
    if (text === "> " && candidate) {
      const listener = candidate;
      candidate = undefined;
      if (
        input.listeners("data").includes(listener) &&
        active?.listener !== listener
      ) {
        if (active && unsupported) {
          active.listener = listener;
          unsupported = false;
        } else {
          cancel();
          active = {
            listener,
            controller: new AbortController(),
            dispatched: false,
          };
        }
        schedule();
      }
    }
    return result;
  } as typeof originalWrite;

  return () => {
    output.write = originalWrite;
    input.removeListener = originalRemoveListener;
    if (scheduled) clearImmediate(scheduled);
    cancel();
  };
}

async function sendGuidance(
  endpoint: string,
  launcherId: string,
  message: string,
  signal: AbortSignal,
) {
  try {
    const result = await callMcp(
      endpoint,
      "t3_thread_send",
      {
        threadId: launcherId,
        message,
        mode: "queue",
        clientRequestId: randomUUID(),
      },
      {
        signal,
        acknowledged: (result) =>
          result.threadId === launcherId &&
          typeof result.messageId === "string" &&
          !!result.messageId &&
          typeof result.runId === "string" &&
          !!result.runId &&
          (result.delivery === "queued" || result.delivery === "started"),
        uncertainEffect:
          "The diagnostic message may already have reached the launcher Thread.",
      },
    );
    if ("code" in result) throw new Error(String(result.message));
  } catch (error) {
    if (!signal.aborted)
      console.error(
        `Pause guidance delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
  }
}
