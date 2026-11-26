import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  enhancementContractVersion,
  type EnhancementModule,
  type Enhancement,
  type EnhancementContext,
  type TerminalIO,
  type RequestRecovery,
} from "issue-runner-core/terminal";
import { callMcp } from "./authorization.js";
import { boundTabs } from "./terminal.js";

export const contractVersion = enhancementContractVersion;

type Assignment = Parameters<Enhancement["onAssignment"]>[0];
type RecordData = Record<string, unknown>;

class HandoffCheckError extends Error {}

function record(value: unknown): RecordData {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid T3 observation.");
  return value as RecordData;
}

async function handoffAbsent(path: string) {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return true;
    throw new HandoffCheckError("Cannot check handoff.", { cause: error });
  }
}

export const createEnhancement: EnhancementModule["createEnhancement"] = async (
  io,
  requestRecovery,
  context,
  config,
) => {
  const settings = config === undefined ? {} : record(config);
  const retryLimit =
    settings.retryLimit === undefined ? 3 : settings.retryLimit;
  const delay =
    settings.handoffRecoveryDelaySeconds === undefined
      ? 120
      : settings.handoffRecoveryDelaySeconds;
  const logLevel =
    settings.logLevel === undefined ? "error" : settings.logLevel;
  if (
    typeof retryLimit !== "number" ||
    !Number.isInteger(retryLimit) ||
    retryLimit < 0
  )
    throw new Error("retryLimit must be a nonnegative integer.");
  if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0)
    throw new Error(
      "handoffRecoveryDelaySeconds must be finite nonnegative seconds.",
    );
  if (logLevel !== "error" && logLevel !== "info")
    throw new Error("logLevel must be error or info.");
  return new T3Enhancement(
    io,
    context,
    new MissingHandoffRecovery(requestRecovery, retryLimit, delay, logLevel),
  );
};

class MissingHandoffRecovery {
  private attempts = 0;
  private disabled = false;
  private inFlight = false;
  private pending:
    { runId: string; status: string; started: number } | undefined;

  constructor(
    private readonly requestRecovery: RequestRecovery,
    private readonly retryLimit: number,
    private readonly delaySeconds: number,
    private readonly logLevel: "error" | "info",
  ) {}

  cancel() {
    if (this.pending && this.logLevel === "info")
      console.error("Missing handoff recovery timer cancelled.");
    this.pending = undefined;
  }

  reset() {
    this.cancel();
    this.attempts = 0;
  }

  remainingDelay() {
    if (!this.pending) return Infinity;
    return Math.max(
      0,
      this.delaySeconds * 1000 - (performance.now() - this.pending.started),
    );
  }

  expired() {
    const expired = this.remainingDelay() === 0;
    if (expired && this.logLevel === "info")
      console.error("Missing handoff recovery timer expired.");
    return expired;
  }

  observe(
    assignmentId: string,
    runId: string,
    status: string,
    expired: boolean,
  ) {
    if (this.inFlight || this.disabled || this.attempts >= this.retryLimit) {
      this.cancel();
      return;
    }
    if (this.pending?.runId !== runId || this.pending.status !== status) {
      this.cancel();
      this.pending = { runId, status, started: performance.now() };
      if (this.logLevel === "info")
        console.error("Missing handoff recovery timer scheduled.");
      return;
    }
    if (!expired) return;
    this.pending = undefined;
    this.inFlight = true;
    this.attempts++;
    // Core owns input serialization and stale Assignment rejection.
    void this.submit(assignmentId);
    console.error(
      `Missing handoff recovery attempt ${this.attempts}/${this.retryLimit}.`,
    );
    if (this.attempts === this.retryLimit)
      console.error("Missing handoff recovery budget exhausted.");
  }

  private async submit(assignmentId: string) {
    try {
      await this.requestRecovery(assignmentId);
    } catch {
      this.disabled = true;
      console.error(
        "Missing handoff recovery request failed; automatic recovery disabled.",
      );
    } finally {
      this.inFlight = false;
    }
  }
}

class T3Enhancement implements Enhancement {
  private readonly tab: NonNullable<ReturnType<typeof boundTabs.get>>;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private assignment: Assignment | undefined;
  // Retain observed Run ownership across Assignments to ignore old markers.
  private readonly runAssignments = new Map<string, string | undefined>();
  private readonly processedReplies = new Set<string>();
  private activeRun: string | undefined;
  private paused = false;
  private monitoring = false;
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private observationFailure: "lost" | "reconnect" | "handoff" | undefined;
  constructor(
    io: TerminalIO,
    private readonly context: EnhancementContext,
    private readonly recovery: MissingHandoffRecovery,
  ) {
    const tab = boundTabs.get(io);
    if (!tab) throw new Error("Enhancement requires bound T3 Tab I/O.");
    this.tab = tab;
    this.signal = AbortSignal.any([
      this.controller.signal,
      ...(tab.options.signal ? [tab.options.signal] : []),
    ]);
    this.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(this.timer);
        this.recovery.cancel();
      },
      { once: true },
    );
  }

  private current() {
    return !this.signal.aborted && !!this.tab.threadId;
  }

  private async read(args: RecordData = {}) {
    try {
      if (!this.current()) throw new Error("T3 observation stopped.");
      const threadId = this.tab.threadId;
      const result = await callMcp(
        this.tab.endpoint,
        "t3_thread_read",
        {
          threadId,
          view: "messages",
          runLimit: 50,
          ...args,
        },
        undefined,
        this.signal,
      );
      const thread = record(result.thread);
      if (
        !this.current() ||
        thread.threadId !== threadId ||
        !Array.isArray(result.recentRuns) ||
        !Array.isArray(result.items)
      )
        throw new Error("Invalid T3 observation.");
      const items = result.items.map(record);
      const runIds = result.recentRuns.map((run) => {
        const { runId } = record(run);
        if (typeof runId !== "string") throw new Error("Invalid T3 Run.");
        return runId;
      });
      // A continuation page may expose new Runs even when reply extraction fails.
      for (const runId of runIds) {
        if (!this.runAssignments.has(runId))
          this.runAssignments.set(runId, this.assignment?.id);
      }
      this.activeRun =
        typeof thread.activeRunId === "string" ? thread.activeRunId : undefined;
      return { thread, items, earlierPosition: result.earlierPosition };
    } catch (error) {
      // A failed native read invalidates active Run ownership; reply extraction does not.
      this.activeRun = undefined;
      throw error;
    }
  }

  private async lastReply(
    page: Awaited<ReturnType<T3Enhancement["read"]>>,
    runId: string,
  ) {
    const status = page.thread.status;
    function sameRun(next: Awaited<ReturnType<T3Enhancement["read"]>>) {
      if (
        next.thread.latestRunId !== runId ||
        next.thread.status !== status ||
        next.thread.activeRunId !== null
      )
        throw new Error("T3 Run changed during observation.");
    }
    let before = Infinity;
    for (;;) {
      const item = page.items
        .slice()
        .reverse()
        .find(
          (item) =>
            item.type === "assistant_message" &&
            item.runId === runId &&
            item.sourceThreadId === this.tab.threadId,
        );
      if (item) {
        if (typeof item.itemId !== "string" || typeof item.text !== "string")
          throw new Error("Invalid T3 reply.");
        let text = item.text;
        let chunk = item;
        while (chunk.textTruncated === true) {
          const offset = chunk.nextTextOffset;
          if (
            typeof offset !== "number" ||
            offset <= 0 ||
            offset !== text.length
          )
            throw new Error("Invalid T3 reply offset.");
          const next = await this.read({
            itemId: item.itemId,
            textOffset: offset,
          });
          sameRun(next);
          chunk = record(
            next.items.find((candidate) => candidate.itemId === item.itemId),
          );
          if (
            chunk.sourceThreadId !== item.sourceThreadId ||
            chunk.runId !== runId ||
            chunk.updatedAt !== item.updatedAt ||
            typeof chunk.text !== "string" ||
            !chunk.text.length
          )
            throw new Error("T3 reply changed during observation.");
          text += chunk.text;
        }
        if (chunk.textTruncated !== false)
          throw new Error("Invalid T3 reply text.");
        return { itemId: item.itemId, text };
      }
      if (page.earlierPosition === null) return;
      if (
        typeof page.earlierPosition !== "number" ||
        page.earlierPosition < 0 ||
        page.earlierPosition >= before
      )
        throw new Error("Invalid T3 timeline cursor.");
      before = page.earlierPosition;
      page = await this.read({ beforePosition: before });
      sameRun(page);
    }
  }

  private async missing(candidate: Assignment) {
    if (!this.current() || candidate !== this.assignment) return false;
    const absent = await handoffAbsent(
      resolve(this.context.cwd, candidate.expectedFile),
    );
    if (!absent && this.current() && candidate === this.assignment) {
      this.recovery.reset();
    }
    return absent;
  }

  private async observe() {
    const generation = this.generation;
    const page = await this.read();
    const candidate = this.assignment;
    const { thread } = page;
    if (
      !candidate ||
      !(await this.missing(candidate)) ||
      !this.current() ||
      candidate !== this.assignment
    )
      return;
    const runId = thread.latestRunId;
    const status = thread.status;
    if (
      typeof runId !== "string" ||
      thread.activeRunId !== null ||
      (status !== "completed" && status !== "interrupted")
    )
      return;
    // Run attribution gates Pause, not Missing Handoff Recovery.
    const reply =
      this.runAssignments.get(runId) === candidate.id
        ? await this.lastReply(page, runId)
        : undefined;
    const wasPaused = this.paused;
    if (
      !(await this.missing(candidate)) ||
      !this.current() ||
      candidate !== this.assignment
    )
      return;
    this.pauseForReply(candidate, runId, reply, wasPaused);
    return { candidate, generation, runId, status };
  }

  private pauseForReply(
    candidate: Assignment,
    runId: string,
    reply: Awaited<ReturnType<T3Enhancement["lastReply"]>>,
    wasPaused: boolean,
  ) {
    if (!reply?.text.trimStart().startsWith("[action required]")) return;
    const identity = JSON.stringify([runId, reply.itemId]);
    if (this.processedReplies.has(identity)) return;
    this.processedReplies.add(identity);
    if (this.paused || wasPaused) return;
    this.paused = true;
    this.context.enhancementPause(candidate.id, "ACTION REQUIRED!!!");
  }

  private schedule(delay = 5000) {
    if (this.signal.aborted) return;
    this.timer = setTimeout(async () => {
      let next = 5000;
      try {
        // Only a read started at or after expiry can authorize submission.
        const expired = this.recovery.expired();
        const observation = this.current() ? await this.observe() : undefined;
        if (
          observation &&
          this.current() &&
          observation.generation === this.generation &&
          !this.paused
        ) {
          const { candidate, runId, status } = observation;
          this.recovery.observe(candidate.id, runId, status, expired);
        } else this.recovery.cancel();
        this.observationFailure = undefined;
      } catch (error) {
        if (this.signal.aborted) return;
        this.recovery.cancel();
        this.reportFailure(error);
        next = 10000;
      }
      this.schedule(Math.min(next, Math.ceil(this.recovery.remainingDelay())));
    }, delay);
    this.timer.unref();
  }

  private reportFailure(error: unknown) {
    const failure =
      error instanceof HandoffCheckError
        ? "handoff"
        : this.observationFailure === "lost" ||
            this.observationFailure === "reconnect"
          ? "reconnect"
          : "lost";
    if (failure === this.observationFailure) return;
    this.observationFailure = failure;
    const messages = {
      lost: "T3 observation lost; retrying in 10 seconds.",
      reconnect: "T3 observation reconnect failed; retrying in 10 seconds.",
      handoff: "Missing handoff recovery check failed; retrying in 10 seconds.",
    };
    console.error(messages[failure]);
  }

  async startMonitoring() {
    if (this.monitoring || this.signal.aborted) return;
    this.monitoring = true;
    this.schedule();
  }
  async waitUntilReady() {
    if (!this.tab.threadId)
      throw new Error("T3 task handle is not bound to a thread.");
    return this.tab.threadId;
  }
  onAssignment(next: Assignment) {
    if (this.signal.aborted) return;
    this.assignment = next;
    this.generation++;
    this.recovery.reset();
    if (this.activeRun) this.runAssignments.set(this.activeRun, next.id);
    this.paused = false;
    this.processedReplies.clear();
  }
  async enhancementResume(assignmentId: string) {
    if (this.assignment?.id === assignmentId) {
      this.paused = false;
      this.generation++;
      this.recovery.cancel();
    }
  }
  async stop() {
    this.controller.abort();
    this.assignment = undefined;
    this.activeRun = undefined;
    this.paused = false;
    this.runAssignments.clear();
    this.processedReplies.clear();
  }
}
