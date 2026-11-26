import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  enhancementContractVersion,
  type EnhancementModule,
  type Enhancement,
  type EnhancementContext,
  type TerminalIO,
} from "issue-runner-core/terminal";
import { callMcp } from "./authorization.js";
import { boundTabs } from "./terminal.js";

export const contractVersion = enhancementContractVersion;

type Assignment = Parameters<Enhancement["onAssignment"]>[0];
type RecordData = Record<string, unknown>;

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
    throw error;
  }
}

export const createEnhancement: EnhancementModule["createEnhancement"] = async (
  io,
  _requestRecovery,
  context,
) => new T3Enhancement(io, context);

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

  constructor(
    io: TerminalIO,
    private readonly context: EnhancementContext,
  ) {
    const tab = boundTabs.get(io);
    if (!tab) throw new Error("Enhancement requires bound T3 Tab I/O.");
    this.tab = tab;
    this.signal = AbortSignal.any([
      this.controller.signal,
      ...(tab.options.signal ? [tab.options.signal] : []),
    ]);
  }

  private current() {
    return !this.signal.aborted && !!this.tab.threadId;
  }

  private async read(args: RecordData = {}) {
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
    return {
      thread,
      runs: result.recentRuns.map(record),
      items: result.items.map(record),
      earlierPosition: result.earlierPosition,
    };
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

  private async observe() {
    const page = await this.read();
    const { thread, runs } = page;
    for (const run of runs) {
      if (typeof run.runId !== "string") throw new Error("Invalid T3 Run.");
      if (!this.runAssignments.has(run.runId))
        this.runAssignments.set(run.runId, this.assignment?.id);
    }
    this.activeRun =
      typeof thread.activeRunId === "string" ? thread.activeRunId : undefined;
    const candidate = this.assignment;
    if (!candidate) return;
    const path = resolve(this.context.cwd, candidate.expectedFile);
    if (
      !(await handoffAbsent(path)) ||
      !this.current() ||
      candidate !== this.assignment
    )
      return;
    const runId = thread.latestRunId;
    if (
      typeof runId !== "string" ||
      thread.activeRunId !== null ||
      (thread.status !== "completed" && thread.status !== "interrupted") ||
      this.runAssignments.get(runId) !== candidate.id
    )
      return;
    const reply = await this.lastReply(page, runId);
    if (!reply?.text.trimStart().startsWith("[action required]")) return;
    const identity = JSON.stringify([runId, reply.itemId]);
    const wasPaused = this.paused;
    if (
      this.processedReplies.has(identity) ||
      !(await handoffAbsent(path)) ||
      !this.current() ||
      candidate !== this.assignment
    )
      return;
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
        if (this.current()) await this.observe();
      } catch {
        next = 10000;
      }
      this.schedule(next);
    }, delay);
    this.timer.unref();
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
    if (this.activeRun) this.runAssignments.set(this.activeRun, next.id);
    this.paused = false;
    this.processedReplies.clear();
  }
  async enhancementResume(assignmentId: string) {
    if (this.assignment?.id === assignmentId) this.paused = false;
  }
  async stop() {
    this.controller.abort();
    clearTimeout(this.timer);
    this.assignment = undefined;
    this.activeRun = undefined;
    this.paused = false;
    this.runAssignments.clear();
    this.processedReplies.clear();
  }
}
