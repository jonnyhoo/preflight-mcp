import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logging/logger.js';

/** Progress callback for git operations */
export type GitProgressCallback = (phase: string, progress: number, message: string) => void;

export type GitHubRepoRef = {
  owner: string;
  repo: string;
};

export function parseOwnerRepo(input: string): GitHubRepoRef {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, '');
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid repo identifier: ${input} (expected owner/repo; for local use local/<name>)`);
  }
  return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/i, '') };
}

export function toCloneUrl(ref: GitHubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}

/**
 * Parse git clone progress from stderr.
 * Git outputs progress like:
 * - "Receiving objects:  45% (1234/2741)"
 * - "Resolving deltas:  60% (100/167)"
 */
function parseGitProgress(line: string): { phase: string; percent: number } | null {
  // Match patterns like "Receiving objects:  45% (1234/2741)"
  const match = line.match(/(Receiving objects|Resolving deltas|Counting objects|Compressing objects):\s+(\d+)%/);
  if (match) {
    return {
      phase: match[1]!,
      percent: parseInt(match[2]!, 10),
    };
  }
  return null;
}

async function runGit(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; onProgress?: GitProgressCallback }
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = opts?.timeoutMs ?? 5 * 60_000;
  const onProgress = opts?.onProgress;
  
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts?.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };

    const forceKill = () => {
      if (child.killed) return;
      
      try {
        // Try SIGKILL for forceful termination
        child.kill('SIGKILL');
      } catch (err) {
        logger.warn('Failed to kill git process', err instanceof Error ? err : undefined);
      }
    };

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      logger.warn(`Git command timed out after ${timeoutMs}ms`, { args });
      
      // Try graceful termination first
      try {
        child.kill('SIGTERM');
      } catch (err) {
        logger.warn('Failed to send SIGTERM to git process', err instanceof Error ? err : undefined);
      }
      
      // Force kill after 5 seconds if still running
      setTimeout(forceKill, 5000);
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr?.on('data', (data) => {
      const chunk = data.toString('utf8');
      stderr += chunk;
      
      // Parse and report progress
      if (onProgress) {
        // Git progress can come in chunks, split by lines
        const lines = chunk.split(/[\r\n]+/);
        for (const line of lines) {
          const progress = parseGitProgress(line);
          if (progress) {
            onProgress(progress.phase, progress.percent, `${progress.phase}: ${progress.percent}%`);
          }
        }
      }
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code, signal) => {
      cleanup();
      
      if (timedOut) {
        reject(new Error(`Git command timed out after ${timeoutMs}ms: git ${args.join(' ')}`));
      } else if (code !== 0) {
        reject(new Error(`Git command failed with code ${code}: ${stderr || stdout}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function getRemoteHeadSha(cloneUrl: string): Promise<string> {
  const { stdout } = await runGit(['ls-remote', cloneUrl, 'HEAD'], { timeoutMs: 60_000 });
  const line = stdout.trim().split(/\r?\n/)[0];
  if (!line) throw new Error(`git ls-remote returned empty output for ${cloneUrl}`);
  const [sha] = line.split(/\s+/);
  if (!sha || sha.length < 8) throw new Error(`Could not parse remote sha from: ${line}`);
  return sha;
}

/**
 * Validate git ref to prevent command injection.
 * Only allows: alphanumeric, hyphens, underscores, dots, forward slashes
 */
function validateGitRef(ref: string): void {
  if (!ref || ref.length === 0) {
    throw new Error('Git ref cannot be empty');
  }
  
  if (ref.length > 256) {
    throw new Error('Git ref too long (max 256 characters)');
  }
  
  // Allow only safe characters: alphanumeric, hyphen, underscore, dot, forward slash
  // This covers branches, tags, and commit SHAs
  const safeRefPattern = /^[a-zA-Z0-9_.\/-]+$/;
  if (!safeRefPattern.test(ref)) {
    throw new Error(`Invalid git ref: contains unsafe characters. Ref: ${ref}`);
  }
  
  // Prevent refs starting with dash (could be interpreted as git option)
  if (ref.startsWith('-')) {
    throw new Error('Invalid git ref: cannot start with hyphen');
  }
  
  // Prevent double dots (path traversal in git refs)
  if (ref.includes('..')) {
    throw new Error('Invalid git ref: cannot contain ".."');
  }
}

export async function shallowClone(
  cloneUrl: string,
  destDir: string,
  opts?: { ref?: string; timeoutMs?: number; onProgress?: GitProgressCallback }
): Promise<void> {
  await fs.mkdir(path.dirname(destDir), { recursive: true });

  // Clean dest if exists.
  await fs.rm(destDir, { recursive: true, force: true });

  // Use --progress to force progress output even when not attached to a terminal
  const args = ['-c', 'core.autocrlf=false', 'clone', '--depth', '1', '--no-tags', '--single-branch', '--progress'];
  if (opts?.ref) {
    // Validate ref before using it in git command
    validateGitRef(opts.ref);
    args.push('--branch', opts.ref);
  }
  args.push(cloneUrl, destDir);

  await runGit(args, { timeoutMs: opts?.timeoutMs ?? 15 * 60_000, onProgress: opts?.onProgress });
}

export async function getLocalHeadSha(repoDir: string): Promise<string> {
  const { stdout } = await runGit(['-C', repoDir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}
