import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitHubRepoRef = {
  owner: string;
  repo: string;
};

export function parseOwnerRepo(input: string): GitHubRepoRef {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, '');
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid GitHub repo identifier: ${input} (expected owner/repo)`);
  }
  return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/i, '') };
}

export function toCloneUrl(ref: GitHubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}

async function runGit(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs ?? 5 * 60_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export async function getRemoteHeadSha(cloneUrl: string): Promise<string> {
  const { stdout } = await runGit(['ls-remote', cloneUrl, 'HEAD'], { timeoutMs: 60_000 });
  const line = stdout.trim().split(/\r?\n/)[0];
  if (!line) throw new Error(`git ls-remote returned empty output for ${cloneUrl}`);
  const [sha] = line.split(/\s+/);
  if (!sha || sha.length < 8) throw new Error(`Could not parse remote sha from: ${line}`);
  return sha;
}

export async function shallowClone(
  cloneUrl: string,
  destDir: string,
  opts?: { ref?: string }
): Promise<void> {
  await fs.mkdir(path.dirname(destDir), { recursive: true });

  // Clean dest if exists.
  await fs.rm(destDir, { recursive: true, force: true });

  const args = ['-c', 'core.autocrlf=false', 'clone', '--depth', '1', '--no-tags', '--single-branch'];
  if (opts?.ref) {
    args.push('--branch', opts.ref);
  }
  args.push(cloneUrl, destDir);

  await runGit(args, { timeoutMs: 15 * 60_000 });
}

export async function getLocalHeadSha(repoDir: string): Promise<string> {
  const { stdout } = await runGit(['-C', repoDir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}
