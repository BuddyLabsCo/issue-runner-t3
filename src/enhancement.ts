import {
  enhancementContractVersion,
  type EnhancementModule,
} from "issue-runner-core/terminal";
import { boundTabs } from "./terminal.js";

export const contractVersion = enhancementContractVersion;

export const createEnhancement: EnhancementModule["createEnhancement"] = async (
  io,
) => {
  const tab = boundTabs.get(io);
  if (!tab) throw new Error("Enhancement requires bound T3 Tab I/O.");

  return {
    // Observation and recovery policy belong to the follow-up Enhancement tickets.
    async startMonitoring() {},
    async waitUntilReady() {
      if (!tab.threadId)
        throw new Error("T3 task handle is not bound to a thread.");
      return tab.threadId;
    },
    onAssignment() {},
    async enhancementResume() {},
    async stop() {},
  };
};
