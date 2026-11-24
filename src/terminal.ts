import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { CreateTabOptions, TabHandle, TerminalPlugin } from 'issue-runner-core/terminal';
import { callMcp, checkAuthorization } from './authorization.js';

const startUsage = 'Expected t3 start --provider <instance-id> --model <model> [--option <id>=<value>].';
const busyThreadMessage = 'Saved T3 thread is busy or its idle state is unconfirmed. After exiting, finish or stop the turn in T3, then rerun the same command.';
class ThreadNotFoundError extends Error {}

function startSelection(args: string[]) {
  const { values } = parseArgs({ args, options: { provider: { type: 'string' }, model: { type: 'string' }, option: { type: 'string', multiple: true } } });
  if (!values.provider || !values.model) throw new Error(startUsage);
  const options = (values.option ?? []).map(option => {
    const separator = option.indexOf('=');
    if (separator <= 0 || separator === option.length - 1) throw new Error(startUsage);
    return { id: option.slice(0, separator), value: option.slice(separator + 1) };
  });
  return { instanceId: values.provider, model: values.model, ...(options.length ? { options } : {}) };
}

function hasInactiveRunStatus(thread: Record<string, unknown>) {
  return thread.activeRunId === null && typeof thread.status === 'string' &&
    ['idle', 'completed', 'failed', 'cancelled', 'interrupted', 'rolled_back'].includes(thread.status);
}

async function sameWorktree(saved: string, cwd: string) {
  if (!isAbsolute(saved)) return false;
  try {
    return relative(await realpath(saved), await realpath(cwd)) === '';
  } catch {
    return false;
  }
}

async function call(endpoint: string, name: string, args: Record<string, unknown>, retry?: Parameters<typeof callMcp>[3]) {
  const result = await callMcp(endpoint, name, args, retry);
  if ('code' in result) {
    if (!retry && result.code === 'thread_not_found') throw new ThreadNotFoundError('T3 thread not found.');
    throw new Error(`${name}: ${result.message}`);
  }
  return result;
}

async function readThread(endpoint: string, threadId: string, projectId?: string) {
  const { thread } = await call(endpoint, 't3_thread_read', { threadId });
  if (!thread || typeof thread !== 'object' || !('threadId' in thread) || thread.threadId !== threadId ||
    !('projectId' in thread) || typeof thread.projectId !== 'string' || !thread.projectId.trim()) {
    throw new Error('T3 returned an invalid thread identity.');
  }
  if (projectId !== undefined && thread.projectId !== projectId) throw new Error('Saved T3 thread belongs to another project.');
  return thread as Record<string, unknown> & { projectId: string };
}

async function readResumeCandidate(endpoint: string, threadId: string, projectId: string, cwd: string) {
  const thread = await readThread(endpoint, threadId, projectId);
  if (typeof thread.worktreePath !== 'string' || !await sameWorktree(thread.worktreePath, cwd)) {
    throw new Error('Saved T3 thread Worktree does not resolve to the Core cwd.');
  }
  if (!hasInactiveRunStatus(thread)) throw new Error(busyThreadMessage);
  return thread;
}

async function assertEmptyQueue(endpoint: string, threadId: string, message: string) {
  const queue = await call(endpoint, 't3_queue', { threadId, action: 'list', limit: 1 });
  if (!Array.isArray(queue.items) || queue.items.length || queue.nextCursor !== null) throw new Error(message);
}

async function resumeThread(endpoint: string, projectId: string, args: string[], options: CreateTabOptions) {
  try {
    const [threadId] = args;
    if (!threadId || args.length !== 1) throw new Error('Expected t3 resume <sessionref>.');
    await readResumeCandidate(endpoint, threadId, projectId, options.cwd);
    // A held queued turn can be older than the latest (terminal) run.
    await assertEmptyQueue(endpoint, threadId, busyThreadMessage);
    // An empty queue may mean a held turn started since the first read.
    const thread = await readResumeCandidate(endpoint, threadId, projectId, options.cwd);
    if (typeof thread.archived !== 'boolean' || typeof thread.title !== 'string') {
      throw new Error('T3 did not return the saved thread title and archival state.');
    }
    if (thread.archived) {
      const receipt = await call(endpoint, 't3_thread_organize', { threadId, action: 'unarchive' });
      if (typeof receipt.sequence !== 'number') throw new Error('T3 did not acknowledge thread unarchive.');
    }
    if (thread.title !== options.label) {
      const receipt = await call(endpoint, 't3_thread_update', { threadId, action: 'rename', title: options.label });
      if (typeof receipt.sequence !== 'number' || receipt.title !== options.label) throw new Error('T3 did not acknowledge thread rename.');
    }
    return threadId;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Press q to exit; Enter would advance past the failed execute.`);
  }
}

async function archiveThread(endpoint: string, threadId: string, projectId: string) {
  const busy = 'Cannot archive a T3 thread that is busy or its idle state is unconfirmed. Finish or stop the work in T3 before retrying.';
  async function alreadyArchived() {
    const thread = await readThread(endpoint, threadId, projectId);
    if (typeof thread.archived !== 'boolean') throw new Error('T3 did not return the thread archival state.');
    if (!thread.archived && !hasInactiveRunStatus(thread)) throw new Error(busy);
    return thread.archived;
  }
  try {
    if (await alreadyArchived()) return;
    await assertEmptyQueue(endpoint, threadId, busy);
    // A held turn may have started while the queue was being read.
    if (await alreadyArchived()) return;
  } catch (error) {
    if (error instanceof ThreadNotFoundError) return;
    throw error;
  }
  const receipt = await call(endpoint, 't3_thread_organize', { threadId, action: 'archive' });
  if (typeof receipt.sequence !== 'number') throw new Error('T3 did not acknowledge thread archival.');
}

export async function createT3Terminal(endpoint: string, launcherId: string): Promise<TerminalPlugin> {
  const launcher = await readThread(endpoint, launcherId);
  const projectId = launcher.projectId;
  const handles = new Map<TabHandle, { options: CreateTabOptions; threadId?: string }>();
  function owned(handle: TabHandle) {
    const tab = handles.get(handle);
    if (!tab) throw new Error('Unknown T3 task handle.');
    return tab;
  }
  return {
    async createTab(options) {
      options.signal?.throwIfAborted();
      if (!isAbsolute(options.cwd) || Object.keys(options.env).length || options.submitKey !== 'Enter') {
        throw new Error('T3 requires an absolute Worktree, an empty Agent environment overlay, and Enter submission.');
      }
      await checkAuthorization(endpoint);
      const handle = {};
      handles.set(handle, { options });
      return { handle, io: {
        async read() { throw new Error('Native T3 chat has no terminal screen.'); },
        async sendKeys() { throw new Error('Native T3 chat does not support terminal key chords.'); },
        async submitText(message) {
          const tab = owned(handle);
          tab.options.signal?.throwIfAborted();
          if (!tab.threadId) throw new Error('T3 task handle is not bound to a thread.');
          await call(endpoint, 't3_thread_send', { threadId: tab.threadId, message, clientRequestId: randomUUID() }, {
            acknowledged: result => result.threadId === tab.threadId && typeof result.messageId === 'string' && !!result.messageId && typeof result.runId === 'string' && !!result.runId,
            uncertainEffect: `The prompt may already have reached T3 thread ${tab.threadId}. Inspect it before continuing; signing in again changes the deduplication scope.`,
            signal: tab.options.signal,
          });
        },
      } };
    },
    async execute(handle, command) {
      const tab = owned(handle);
      tab.options.signal?.throwIfAborted();
      if (tab.threadId) throw new Error('T3 task handle is already bound.');
      const [tool, action, ...args] = command.trim().split(/\s+/);
      if (tool !== 't3' || (action !== 'start' && action !== 'resume')) throw new Error(startUsage);
      if (action === 'resume') {
        tab.threadId = await resumeThread(endpoint, projectId, args, tab.options);
        return tab.threadId;
      }
      const result = await call(endpoint, 't3_thread_launch', {
        projectId, title: tab.options.label, modelSelection: startSelection(args),
        workspaceStrategy: { type: 'existing_worktree', worktreePath: tab.options.cwd },
        clientRequestId: randomUUID(),
      }, {
        acknowledged: result => typeof result.threadId === 'string' && !!result.threadId.trim() && result.threadId !== launcherId && result.projectId === projectId && result.runId === null,
        uncertainEffect: 'An idle T3 task thread may already exist. Inspect T3 before continuing; signing in again changes the deduplication scope.',
        signal: tab.options.signal,
      });
      tab.threadId = result.threadId as string;
      return tab.threadId;
    },
    async closeTab(handle) {
      const tab = owned(handle);
      if (tab.threadId) {
        try {
          await archiveThread(endpoint, tab.threadId, projectId);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)} If exiting Runner, T3 thread ${tab.threadId} may need manual archival after restart.`, { cause: error });
        }
      }
      handles.delete(handle);
    },
  };
}
