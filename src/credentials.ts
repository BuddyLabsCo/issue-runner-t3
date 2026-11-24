import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultEndpoint = 'http://127.0.0.1:3773/mcp';
export const operateScope = 'orchestration:operate';

export interface Credential {
  accessToken: string;
  expiresAt: number;
  scope: string;
}

export function normalizeEndpoint(input: unknown = defaultEndpoint): string {
  if (typeof input !== 'string') throw new Error('MCP URL must be a URL string.');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid MCP URL. Use the T3 environment MCP URL.');
  }
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('MCP URL must use HTTPS or loopback HTTP, without credentials, query, or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}

export function loginCommand(endpoint: string): string {
  return `issue-runner-t3 auth login ${endpoint}`;
}

function credentialPath(endpoint: string): string {
  return join(homedir(), '.issue-runner-t3', `${createHash('sha256').update(endpoint).digest('hex')}.json`);
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<Credential>;
  return typeof c.accessToken === 'string' && c.accessToken.length > 0 &&
    typeof c.expiresAt === 'number' && Number.isFinite(c.expiresAt) &&
    typeof c.scope === 'string';
}

async function checkPrivate(path: string, directory: boolean) {
  const info = await lstat(path);
  if ((directory ? !info.isDirectory() : !info.isFile()) ||
      (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
    throw new Error('Credential storage is not private.');
  }
  if (process.platform === 'win32') {
    windowsAcl(path, `
      $acl = Get-Acl -LiteralPath $env:ISSUE_RUNNER_T3_CREDENTIAL_PATH
      $allowed = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' })
      if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
          $allowed.Count -eq 0 -or @($allowed | Where-Object { $_.IdentityReference.Value -ne $sid.Value }).Count -ne 0) {
        throw 'Credential storage is not private.'
      }
    `);
  }
}

function windowsAcl(path: string, script: string) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    ${script}
  `], { env: { ...process.env, ISSUE_RUNNER_T3_CREDENTIAL_PATH: path }, stdio: 'ignore' });
}

function setPrivateWindowsAcl(path: string, directory: boolean) {
  // Node file modes do not set Windows ACLs.
  windowsAcl(path, `
    $acl = Get-Acl -LiteralPath $env:ISSUE_RUNNER_T3_CREDENTIAL_PATH
    $acl.SetAccessRuleProtection($true, $false)
    @($acl.Access) | ForEach-Object { $acl.RemoveAccessRuleSpecific($_) }
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { $acl.SetOwner($sid) }
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', '${directory ? 'ContainerInherit,ObjectInherit' : 'None'}', 'None', 'Allow'))
    Set-Acl -LiteralPath $env:ISSUE_RUNNER_T3_CREDENTIAL_PATH -AclObject $acl
  `);
}

export async function requireCredential(endpoint: string): Promise<Credential> {
  const path = credentialPath(endpoint);
  let credential: unknown;
  try {
    await checkPrivate(join(homedir(), '.issue-runner-t3'), true);
    await checkPrivate(path, false);
    credential = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(`${missing ? 'Missing credentials' : 'Cannot read private credentials'} for ${endpoint}. Run ${loginCommand(endpoint)}.`);
  }
  return validateCredential(endpoint, credential);
}

function validateCredential(endpoint: string, credential: unknown): Credential {
  if (!isCredential(credential)) throw new Error(`Invalid credentials for ${endpoint}. Run ${loginCommand(endpoint)}.`);
  if (credential.expiresAt <= Date.now()) throw new Error(`Expired credentials for ${endpoint}. Run ${loginCommand(endpoint)}.`);
  if (!credential.scope.split(/\s+/).includes(operateScope)) {
    throw new Error(`Insufficient credentials for ${endpoint}: ${operateScope} required. Run ${loginCommand(endpoint)} and approve operation access.`);
  }
  return credential;
}

async function privateDirectory(): Promise<void> {
  const dir = join(homedir(), '.issue-runner-t3');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || (process.platform !== 'win32' && info.uid !== process.getuid?.())) {
    throw new Error('Credential directory must be owned by the current user.');
  }
  if (process.platform === 'win32') {
    setPrivateWindowsAcl(dir, true);
  } else {
    await chmod(dir, 0o700);
  }
}

export async function saveCredential(endpoint: string, credential: Credential): Promise<void> {
  validateCredential(endpoint, credential);
  const path = credentialPath(endpoint);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await privateDirectory();
    await writeFile(temporary, JSON.stringify(credential), { mode: 0o600, flag: 'wx' });
    if (process.platform === 'win32') setPrivateWindowsAcl(temporary, false);
    validateCredential(endpoint, credential);
    await rename(temporary, path);
  } catch {
    // Storage setup can consume the remaining lifetime of a short-lived token.
    validateCredential(endpoint, credential);
    throw new Error('Unable to save credentials privately under the current user home directory. Check its permissions.');
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
