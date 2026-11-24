import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import type { CreateTabOptions, TabHandle, TerminalPlugin } from 'issue-runner-core/terminal';
import { callMcp, checkAuthorization } from './authorization.js';

function startSelection(command: string) {
  const [tool, action, ...args] = command.trim().split(/\s+/);
  const usage = 'Expected t3 start --provider <instance-id> --model <model> [--option <id>=<value>].';
  if (tool !== 't3' || action !== 'start') throw new Error(usage);
  const { values } = parseArgs({ args, options: { provider: { type: 'string' }, model: { type: 'string' }, option: { type: 'string', multiple: true } } });
  if (!values.provider || !values.model) throw new Error(usage);
  const options = (values.option ?? []).map(option => {
    const separator = option.indexOf('=');
    if (separator <= 0 || separator === option.length - 1) throw new Error(usage);
    return { id: option.slice(0, separator), value: option.slice(separator + 1) };
  });
  return { instanceId: values.provider, model: values.model, ...(options.length ? { options } : {}) };
}

export async function createT3Terminal(endpoint: string, launcherId: string): Promise<TerminalPlugin> {
  async function call(name: string, args: Record<string, unknown>) {
    const result = await callMcp(endpoint, name, args);
    if ('code' in result) {
      throw new Error(`${name}: ${result.message}`);
    }
    return result;
  }
  async function readThread(threadId: string) {
    const { thread } = await call('t3_thread_read', { threadId });
    if (!thread || typeof thread !== 'object' || !('threadId' in thread) || thread.threadId !== threadId ||
      !('projectId' in thread) || typeof thread.projectId !== 'string' || !thread.projectId.trim()) {
      throw new Error('T3 returned an invalid thread identity.');
    }
    return thread;
  }
  const launcher = await readThread(launcherId);
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
          const result = await call('t3_thread_send', { threadId: tab.threadId, message, clientRequestId: randomUUID() });
          if (result.threadId !== tab.threadId || typeof result.messageId !== 'string' || !result.messageId || typeof result.runId !== 'string' || !result.runId) {
            throw new Error('T3 did not acknowledge message delivery.');
          }
        },
      } };
    },
    async execute(handle, command) {
      const tab = owned(handle);
      tab.options.signal?.throwIfAborted();
      if (tab.threadId) throw new Error('T3 task handle is already bound.');
      const result = await call('t3_thread_launch', {
        projectId, title: tab.options.label, modelSelection: startSelection(command),
        workspaceStrategy: { type: 'existing_worktree', worktreePath: tab.options.cwd },
        clientRequestId: randomUUID(),
      });
      if (typeof result.threadId !== 'string' || !result.threadId.trim() || result.threadId === launcherId || result.projectId !== projectId || result.runId !== null) {
        throw new Error('T3 did not return an idle task thread in the selected project.');
      }
      tab.threadId = result.threadId;
      return tab.threadId;
    },
    async closeTab(handle) {
      const tab = owned(handle);
      if (tab.threadId) {
        const thread = await readThread(tab.threadId);
        if (thread.projectId !== projectId || !('activeRunId' in thread) || thread.activeRunId !== null ||
          !('status' in thread) || !['idle', 'completed', 'failed', 'cancelled', 'interrupted', 'rolled_back'].includes(String(thread.status))) {
          throw new Error('Cannot archive a T3 thread that is busy or belongs to another project.');
        }
        if (!('archived' in thread) || typeof thread.archived !== 'boolean') throw new Error('T3 did not return the thread archival state.');
        if (!thread.archived) {
          const receipt = await call('t3_thread_organize', { threadId: tab.threadId, action: 'archive' });
          if (typeof receipt.sequence !== 'number') throw new Error('T3 did not acknowledge thread archival.');
        }
      }
      handles.delete(handle);
    },
  };
}
