import fs from 'node:fs/promises';
import path from 'node:path';
import { type IngestedFile } from './ingest.js';
import type { Context7LibrarySummary } from './context7.js';

type RepoOverviewInput = {
  repoId: string;
  headSha?: string;
  files: IngestedFile[];
};

function evidence(p: string, start: number, end: number): string {
  return `(evidence: ${p}:${start}-${end})`;
}

function parseOwnerRepoId(repoId: string): { owner: string; repo: string } | null {
  const parts = repoId.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function renderRepoMetaFacts(bundleRootDir: string, repoId: string): Promise<string[]> {
  const parsed = parseOwnerRepoId(repoId);
  if (!parsed) return [];

  const rel = `repos/${parsed.owner}/${parsed.repo}/meta.json`;
  const abs = path.join(bundleRootDir, 'repos', parsed.owner, parsed.repo, 'meta.json');

  let lines: string[];
  try {
    lines = await readLines(abs);
  } catch {
    return [];
  }

  let obj: any;
  try {
    obj = JSON.parse(lines.join('\n'));
  } catch {
    return [];
  }

  const out: string[] = [];

  const pushIf = (label: string, key: string) => {
    const val = obj?.[key];
    if (val === undefined) return;
    const ln = firstLineNumberContaining(lines, `"${key}"`);
    if (!ln) return;
    out.push(`- ${label}: ${JSON.stringify(val)}. ${evidence(rel, ln, ln)}`);
  };

  pushIf('Snapshot commit', 'headSha');
  pushIf('Fetched at', 'fetchedAt');
  pushIf('Clone URL', 'cloneUrl');
  pushIf('Ingested files', 'ingestedFiles');

  return out;
}

function firstLineNumberContaining(lines: string[], needle: string): number | null {
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').includes(needle)) return i + 1;
  }
  return null;
}

async function readLines(filePath: string): Promise<string[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  // Norm files are LF; keep stable.
  return raw.split('\n');
}

function getRepoDocFiles(files: IngestedFile[]): IngestedFile[] {
  return files
    .filter((f) => f.kind === 'doc')
    .sort((a, b) => a.repoRelativePath.localeCompare(b.repoRelativePath));
}

async function renderNodePackageFacts(files: IngestedFile[]): Promise<string[]> {
  const pkg = files.find((f) => f.repoRelativePath === 'package.json');
  if (!pkg) return [];

  const lines = await readLines(pkg.bundleNormAbsPath);
  const out: string[] = [];

  out.push(`- Found package.json at ${pkg.bundleNormRelativePath}. ${evidence(pkg.bundleNormRelativePath, 1, 1)}`);

  // Best-effort parse to list scripts.
  try {
    const obj = JSON.parse(lines.join('\n')) as any;
    const scripts = obj?.scripts && typeof obj.scripts === 'object' ? (obj.scripts as Record<string, unknown>) : null;
    if (scripts) {
      const keys = Object.keys(scripts).slice(0, 20);
      for (const k of keys) {
        const v = scripts[k];
        if (typeof v !== 'string') continue;
        const ln = firstLineNumberContaining(lines, `"${k}"`);
        const start = ln ?? 1;
        const end = ln ?? 1;
        out.push(`  - script "${k}": ${JSON.stringify(v)}. ${evidence(pkg.bundleNormRelativePath, start, end)}`);
      }
    }
  } catch {
    // If JSON is not parseable, stay silent.
  }

  // Best-effort main/module/types.
  for (const key of ['main', 'module', 'types', 'typings']) {
    const ln = firstLineNumberContaining(lines, `"${key}"`);
    if (ln) {
      out.push(`- package.json contains key "${key}". ${evidence(pkg.bundleNormRelativePath, ln, ln)}`);
    }
  }

  return out;
}

function safeContext7IdSegments(context7Id: string): string[] {
  const raw = context7Id.trim().replace(/^\/+/, '');
  const parts = raw.split('/').filter(Boolean);
  return parts.filter((p) => p !== '.' && p !== '..');
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function context7MetaRelPath(lib: Context7LibrarySummary): string {
  if (lib.id) {
    const segs = safeContext7IdSegments(lib.id);
    return `libraries/context7/${segs.join('/')}/meta.json`;
  }
  return `libraries/context7/_unresolved/${slug(lib.input) || 'library'}/meta.json`;
}

async function renderContext7LibraryFacts(bundleRootDir: string, lib: Context7LibrarySummary): Promise<string[]> {
  const relMeta = context7MetaRelPath(lib);
  const absMeta = path.join(bundleRootDir, ...relMeta.split('/'));

  let lines: string[];
  try {
    lines = await readLines(absMeta);
  } catch {
    return [];
  }

  const out: string[] = [];

  // Existence pointer.
  out.push(`- Meta file: ${relMeta}. ${evidence(relMeta, 1, 1)}`);

  const pushIf = (label: string, key: string) => {
    const ln = firstLineNumberContaining(lines, `"${key}"`);
    if (!ln) return;
    out.push(`- ${label}. ${evidence(relMeta, ln, ln)}`);
  };

  pushIf('Library input recorded', 'input');
  pushIf('Context7 ID recorded', 'id');
  pushIf('Fetched at recorded', 'fetchedAt');
  pushIf('Topics recorded', 'topics');

  if (lib.files && lib.files.length) {
    out.push('- Docs files:');
    for (const f of lib.files.slice(0, 20)) {
      out.push(`  - ${f}. ${evidence(f, 1, 1)}`);
    }
  } else {
    const ln = firstLineNumberContaining(lines, `"files"`) ?? 1;
    out.push(`- No docs files listed. ${evidence(relMeta, ln, ln)}`);
  }

  return out;
}

export async function generateOverviewMarkdown(params: {
  bundleId: string;
  bundleRootDir: string;
  repos: RepoOverviewInput[];
  libraries?: Context7LibrarySummary[];
}): Promise<string> {
  const header = `# OVERVIEW.md - Preflight Bundle ${params.bundleId}

This file is generated. It contains **only factual statements** with evidence pointers into bundle files.

`;

  const sections: string[] = [header];

  for (const r of params.repos) {
    sections.push(`## Repo: ${r.repoId}`);

    const metaFacts = await renderRepoMetaFacts(params.bundleRootDir, r.repoId);
    if (metaFacts.length) {
      sections.push('### Snapshot facts');
      sections.push(...metaFacts);
    }

    const nodeFacts = await renderNodePackageFacts(r.files);
    if (nodeFacts.length) {
      sections.push('### Node/JS facts');
      sections.push(...nodeFacts);
    }

    const docs = getRepoDocFiles(r.files).slice(0, 50);
    if (docs.length) {
      sections.push('### Documentation files (first 50)');
      for (const d of docs) {
        sections.push(`- ${d.bundleNormRelativePath}. ${evidence(d.bundleNormRelativePath, 1, 1)}`);
      }
    }

    // Give a small hint about where code lives, without guessing entry points.
    const codeSamples = r.files
      .filter((f) => f.kind === 'code')
      .map((f) => f.repoRelativePath)
      .filter((p) => p.startsWith('src/') || p.startsWith('lib/'))
      .slice(0, 10);

    if (codeSamples.length) {
      sections.push('### Code paths spotted (sample)');
      for (const p of codeSamples) {
        const file = r.files.find((f) => f.repoRelativePath === p);
        if (!file) continue;
        sections.push(`- ${file.bundleNormRelativePath}. ${evidence(file.bundleNormRelativePath, 1, 1)}`);
      }
    }

    sections.push('');
  }

  const libs = params.libraries ?? [];
  if (libs.length) {
    sections.push('## Context7 libraries');

    for (const lib of libs) {
      const facts = await renderContext7LibraryFacts(params.bundleRootDir, lib);
      sections.push(`### ${lib.input}`);
      if (facts.length) {
        sections.push(...facts);
      } else {
        sections.push('- No library facts available.');
      }
      sections.push('');
    }
  }

  return sections.join('\n') + '\n';
}

export async function writeOverviewFile(targetPath: string, markdown: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, markdown, 'utf8');
}
