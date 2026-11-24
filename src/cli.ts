#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCli } from 'issue-runner-core/cli';
import { terminalContractVersion } from 'issue-runner-core/terminal';
import { parse } from 'yaml';
import { checkAuthorization } from './authorization.js';
import { defaultEndpoint, normalizeEndpoint } from './credentials.js';
import { login } from './oauth.js';

const commandName = 'issue-runner-t3';
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);

const help = `Usage: ${commandName} <command> [options]

Commands:
  auth login [mcp-url]       Approve access in your browser
  auth status [mcp-url]      Check saved authorization
  init --project <key>       Initialize a Core Project
  run --project <key>        Native task execution (pending issue #11)

Options: --help, --version`;
const authHelp = `Usage: ${commandName} auth <login|status> [mcp-url]\n\nDefault MCP URL: ${defaultEndpoint}`;

async function projectEndpoint(): Promise<string> {
  const { values } = parseArgs({ args, options: { project: { type: 'string' } }, strict: false, allowPositionals: true });
  const key = values.project;
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]+$/.test(key) || key === '.' || key === '..') {
    return normalizeEndpoint();
  }
  let source: string;
  try {
    source = await readFile(join(process.cwd(), key, 'config.yaml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return normalizeEndpoint();
    throw new Error('Cannot read Project configuration.');
  }
  try {
    return normalizeEndpoint(parse(source)?.terminalPlugins?.mcpUrl);
  } catch {
    throw new Error('Check terminalPlugins.mcpUrl in the Project config.yaml. It must be a valid MCP URL.');
  }
}

async function main() {
  const helpRequested = args.includes('--help') || args.includes('-h');
  if (!args.length || ['--help', '-h'].includes(args[0])) {
    console.log(help);
    return;
  }
  if (args[0] === 'auth') {
    if (helpRequested) {
      console.log(authHelp);
      return;
    }
    if (args.length > 3 || !['login', 'status'].includes(args[1])) throw new Error(authHelp);
    const endpoint = normalizeEndpoint(args[2]);
    if (args[1] === 'login') await login(endpoint);
    else await checkAuthorization(endpoint);
    console.log(`Authorized for ${endpoint}.`);
    return;
  }
  if (args[0] === 'init' && helpRequested) {
    console.log(`Usage: ${commandName} init --project <key>\n\nCreates a Core Project with config.yaml and three prompts. Sign in to the effective MCP URL first.`);
    return;
  }
  if (!['--version', '-v'].includes(args[0]) && !helpRequested) {
    await checkAuthorization(await projectEndpoint());
  }
  await runCli({
    commandName,
    commandVersion: version,
    terminalPackageRoot: packageRoot,
    terminalCliEntry: fileURLToPath(import.meta.url),
    terminal: {
      contractVersion: terminalContractVersion,
      async createTerminalPlugin() {
        // Native task threads are implemented separately in issue #11.
        throw new Error('Native T3 Run support is not available yet (issue #11).');
      },
    },
  });
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
