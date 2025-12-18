import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export type IngestedFileKind = 'doc' | 'code';

export type IngestedFile = {
  repoId: string; // owner/repo
  kind: IngestedFileKind;
  repoRelativePath: string; // path inside repo (forward slashes)
  bundleNormRelativePath: string; // repos/<owner>/<repo>/norm/<...>
  bundleNormAbsPath: string;
  sha256: string;
  bytes: number;
};

export type IngestOptions = {
  maxFileBytes: number;
  maxTotalBytes: number;
};

const DEFAULT_IGNORE = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.turbo/',
  '.cache/',
  'coverage/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.idea/',
  '.vscode/',
];

function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (const b of sample) {
    if (b === 0) return true;
  }
  return false;
}

function classifyKind(repoRelativePathPosix: string): IngestedFileKind {
  const base = path.posix.basename(repoRelativePathPosix).toLowerCase();
  const ext = path.posix.extname(repoRelativePathPosix).toLowerCase();

  if (
    base === 'readme' ||
    base === 'readme.md' ||
    base.startsWith('readme.') ||
    base === 'license' ||
    base.startsWith('license.') ||
    base === 'contributing' ||
    base === 'contributing.md' ||
    base === 'code_of_conduct' ||
    base === 'code_of_conduct.md' ||
    base === 'security' ||
    base === 'security.md' ||
    base === 'changelog' ||
    base === 'changelog.md' ||
    base === 'llms.txt'
  ) {
    return 'doc';
  }

  if (repoRelativePathPosix.includes('/docs/') || repoRelativePathPosix.includes('/doc/')) {
    return 'doc';
  }

  if (['.md', '.markdown', '.rst', '.txt', '.adoc'].includes(ext)) return 'doc';

  return 'code';
}

async function buildIgnore(repoRoot: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(DEFAULT_IGNORE);

  // Respect repo .gitignore if present.
  try {
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const raw = await fs.readFile(gitignorePath, 'utf8');
    ig.add(raw);
  } catch {
    // ignore
  }

  return ig;
}

async function* walkFiles(repoRoot: string, ig: Ignore): AsyncGenerator<{ absPath: string; relPosix: string }> {
  const stack: string[] = [repoRoot];

  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(repoRoot, abs);
      const relPosix = toPosix(rel);
      
      // Check ignore rules for both files and directories
      if (ig.ignores(relPosix)) {
        continue;
      }
      
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;

      yield { absPath: abs, relPosix };
    }
  }
}

export async function ingestRepoToBundle(params: {
  repoId: string;
  repoRoot: string;
  rawDestRoot: string;
  normDestRoot: string;
  bundleNormPrefixPosix: string; // repos/<owner>/<repo>/norm
  options: IngestOptions;
}): Promise<{ files: IngestedFile[]; totalBytes: number; skipped: string[] }> {
  const ig = await buildIgnore(params.repoRoot);

  let totalBytes = 0;
  const files: IngestedFile[] = [];
  const skipped: string[] = [];

  const decoder = new TextDecoder('utf-8', { fatal: true });

  for await (const f of walkFiles(params.repoRoot, ig)) {
    // ignore check already done in walkFiles

    const st = await fs.stat(f.absPath);
    if (st.size > params.options.maxFileBytes) {
      skipped.push(`${f.relPosix} (too large: ${st.size} bytes)`);
      continue;
    }

    if (totalBytes + st.size > params.options.maxTotalBytes) {
      skipped.push(`(bundle maxTotalBytes reached) stopped before: ${f.relPosix}`);
      break;
    }

    const buf = await fs.readFile(f.absPath);
    if (isProbablyBinary(buf)) {
      skipped.push(`${f.relPosix} (binary)`);
      continue;
    }

    let text: string;
    try {
      text = decoder.decode(buf);
    } catch {
      skipped.push(`${f.relPosix} (non-utf8)`);
      continue;
    }

    // Write raw bytes (as checked out by git).
    const rawDest = path.join(params.rawDestRoot, f.relPosix.split('/').join(path.sep));
    await fs.mkdir(path.dirname(rawDest), { recursive: true });
    await fs.writeFile(rawDest, buf);

    // Write normalized text with LF.
    const normalized = text.replace(/\r\n/g, '\n');
    const normDest = path.join(params.normDestRoot, f.relPosix.split('/').join(path.sep));
    await fs.mkdir(path.dirname(normDest), { recursive: true });
    await fs.writeFile(normDest, normalized, 'utf8');

    totalBytes += st.size;

    const kind = classifyKind(f.relPosix);
    const sha256 = sha256Hex(Buffer.from(normalized, 'utf8'));

    const bundleNormRelativePath = `${params.bundleNormPrefixPosix}/${f.relPosix}`;

    files.push({
      repoId: params.repoId,
      kind,
      repoRelativePath: f.relPosix,
      bundleNormRelativePath,
      bundleNormAbsPath: normDest,
      sha256,
      bytes: st.size,
    });
  }

  return { files, totalBytes, skipped };
}
