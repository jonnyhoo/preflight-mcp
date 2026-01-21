import fs from 'node:fs/promises';
import path from 'node:path';
import { type IngestedFile } from './ingest.js';
import { readFacts, type BundleFacts } from './facts.js';

/**
 * Highlight item from analysis results.
 */
type AnalysisHighlight = {
  type: string;
  description: string;
  confidence: number;
  file?: string;
  line?: number;
};

/**
 * Summary entry for a single analyzer.
 */
type AnalyzerSummaryEntry = {
  analyzerName: string;
  summary: string;
  highlights: AnalysisHighlight[];
};

/**
 * Combined summaries from all analyzers.
 */
type AnalysisSummary = {
  overall: string;
  analyzers: AnalyzerSummaryEntry[];
  totalMs: number;
};

/**
 * Load analysis summary from SUMMARY.json
 */
async function loadAnalysisSummary(bundleRootDir: string): Promise<AnalysisSummary | null> {
  const summaryPath = path.join(bundleRootDir, 'analysis', 'SUMMARY.json');
  try {
    const content = await fs.readFile(summaryPath, 'utf8');
    return JSON.parse(content) as AnalysisSummary;
  } catch {
    return null;
  }
}

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

// README extraction limits
const MAX_SECTION_CHARS = 500;
const MAX_TOTAL_CHARS = 3000;
const MAX_SECTIONS = 5;
const MAX_FALLBACK_SECTIONS = 3;

// Doc listing limits
const MAX_DOC_ENTRIES = 30;
const MAX_DOC_DEPTH = 3;

/** Key section patterns (Chinese + English) */
const KEY_SECTION_PATTERNS = [
  /how.*work|workflow|feature|what.*inside|skills|功能|特性|工作流|技能/i,
  /install|usage|getting.*start|安装|使用|快速开始/i,
  /philosoph|design|principle|设计|原理|哲学/i,
];

/** Sections to skip */
const SKIP_SECTION_PATTERNS = [
  /^(table\s+of\s+contents?|toc|目录|contents?)$/i,
  /^(license|licen[cs]e|许可|授权)$/i,
  /^(contributing|贡献|参与)$/i,
  /^(code\s+of\s+conduct|行为准则)$/i,
  /^(acknowledgement|致谢|鸣谢)$/i,
];

/** Check if line is badge/image markdown */
function isBadgeOrImageLine(line: string): boolean {
  const trimmed = line.trim();
  // ![...] or [![...]
  return trimmed.startsWith('![') || trimmed.startsWith('[![');
}

/** Check if heading should be skipped */
function shouldSkipSection(heading: string): boolean {
  const text = heading.replace(/^#+\s*/, '').trim();
  return SKIP_SECTION_PATTERNS.some((p) => p.test(text));
}

/** Check if heading matches key section patterns */
function isKeySection(heading: string): boolean {
  const text = heading.replace(/^#+\s*/, '').trim();
  return KEY_SECTION_PATTERNS.some((p) => p.test(text));
}

/** Parse README into sections */
function parseReadmeSections(
  content: string
): Array<{ heading: string; level: number; lines: string[] }> {
  const rawLines = content.split(/\r?\n/);
  const sections: Array<{ heading: string; level: number; lines: string[] }> = [];
  let current: { heading: string; level: number; lines: string[] } | null = null;
  let inCodeBlock = false;

  for (const line of rawLines) {
    // Track code fences
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue; // Skip code fence lines
    }
    if (inCodeBlock) continue; // Skip content inside code blocks

    // Skip badges/images
    if (isBadgeOrImageLine(line)) continue;

    // Detect headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (current) sections.push(current);
      const level = headingMatch[1]!.length;
      const heading = headingMatch[2]!.trim();
      current = { heading, level, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      // Content before first heading (intro)
      if (!sections.length && !current) {
        current = { heading: '', level: 0, lines: [] };
      }
      current?.lines.push(line);
    }
  }
  if (current) sections.push(current);

  return sections;
}

/** Truncate text to max chars */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).replace(/\s+\S*$/, '') + '...';
}

/** Clean section content */
function cleanSectionContent(lines: string[]): string {
  return lines
    .filter((l) => l.trim() && !isBadgeOrImageLine(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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

/**
 * Find README file (supports README.*, prioritizes README.md)
 */
function findReadmeFile(files: IngestedFile[]): IngestedFile | null {
  // Pattern: README.* at root level
  const readmes = files.filter((f) => {
    const name = path.basename(f.repoRelativePath).toLowerCase();
    const dir = path.dirname(f.repoRelativePath);
    return (dir === '.' || dir === '') && name.startsWith('readme.');
  });

  if (!readmes.length) return null;

  // Prioritize README.md, then others
  return (
    readmes.find((f) => path.basename(f.repoRelativePath).toLowerCase() === 'readme.md') ||
    readmes[0] ||
    null
  );
}

/**
 * Find fallback doc files (docs/index.md, docs/README.md)
 */
function findFallbackDocFile(files: IngestedFile[]): IngestedFile | null {
  const candidates = ['docs/index.md', 'docs/readme.md', 'doc/index.md', 'doc/readme.md'];
  for (const cand of candidates) {
    const found = files.find((f) => f.repoRelativePath.toLowerCase() === cand);
    if (found) return found;
  }
  return null;
}

/**
 * Extract content from README sections
 */
function extractReadmeContent(
  sections: Array<{ heading: string; level: number; lines: string[] }>
): string {
  const results: string[] = [];
  let totalChars = 0;
  let sectionCount = 0;

  // 0. Extract project description from intro or first # heading
  let introContent: string | null = null;
  let usedFirstH1 = false;

  // Try content before first heading
  const intro = sections.find((s) => s.heading === '' && s.level === 0);
  if (intro) {
    introContent = cleanSectionContent(intro.lines);
  }

  // Fallback: first # level heading content (common pattern: # ProjectName + description)
  const firstH1 = sections.find((s) => s.level === 1);
  if (!introContent && firstH1) {
    introContent = cleanSectionContent(firstH1.lines);
    usedFirstH1 = true;
  }

  if (introContent) {
    const truncated = truncateText(introContent, MAX_SECTION_CHARS);
    results.push(truncated);
    totalChars += truncated.length;
    sectionCount++;
  }

  // 1. Try to match key sections (only top-level ## sections, not ### sub-sections)
  // Skip firstH1 if it was used as intro to avoid duplication
  const keySections = sections.filter(
    (s) =>
      s.heading &&
      s.level <= 2 &&
      isKeySection(s.heading) &&
      !shouldSkipSection(s.heading) &&
      !(usedFirstH1 && s === firstH1)
  );

  for (const section of keySections) {
    if (sectionCount >= MAX_SECTIONS) break;
    if (totalChars >= MAX_TOTAL_CHARS) break;

    const content = cleanSectionContent(section.lines);
    if (!content) continue;

    const truncated = truncateText(content, MAX_SECTION_CHARS);
    const formatted = `**${section.heading}**: ${truncated}`;

    if (totalChars + formatted.length > MAX_TOTAL_CHARS) break;

    results.push(formatted);
    totalChars += formatted.length;
    sectionCount++;
  }

  // 2. Fallback: first N non-skip heading blocks
  if (results.length === 0) {
    const fallbackSections = sections
      .filter((s) => !shouldSkipSection(s.heading))
      .slice(0, MAX_FALLBACK_SECTIONS);

    for (const section of fallbackSections) {
      if (totalChars >= MAX_TOTAL_CHARS) break;

      const content = cleanSectionContent(section.lines);
      if (!content) continue;

      const truncated = truncateText(content, MAX_SECTION_CHARS);
      const formatted = section.heading ? `**${section.heading}**: ${truncated}` : truncated;

      if (totalChars + formatted.length > MAX_TOTAL_CHARS) break;

      results.push(formatted);
      totalChars += formatted.length;
    }
  }

  return results.join('\n\n');
}

/**
 * Phase 3: Extract project purpose from README (enhanced)
 */
async function extractProjectPurpose(files: IngestedFile[]): Promise<string | null> {
  // Try README.* first
  let docFile = findReadmeFile(files);

  // Fallback to docs/index.md or docs/README.md
  if (!docFile) {
    docFile = findFallbackDocFile(files);
  }

  if (!docFile) return null;

  try {
    const content = await fs.readFile(docFile.bundleNormAbsPath, 'utf8');
    const sections = parseReadmeSections(content);

    const extracted = extractReadmeContent(sections);
    return extracted || null;
  } catch {
    return null;
  }
}

/**
 * Phase 3: Format module list for display
 */
function formatCoreModules(facts: BundleFacts): string[] {
  if (!facts.modules || facts.modules.length === 0) return [];

  const coreModules = facts.modules
    .filter(m => m.role === 'core')
    .sort((a, b) => b.exports.length - a.exports.length)
    .slice(0, 10);

  if (coreModules.length === 0) return [];

  const lines: string[] = [];
  for (const mod of coreModules) {
    const shortPath = mod.path.replace(/^repos\/[^\/]+\/[^\/]+\/norm\//, '');
    lines.push(`- **${shortPath}**`);
    lines.push(`  - Exports: ${mod.exports.slice(0, 5).join(', ')}${mod.exports.length > 5 ? ` (+${mod.exports.length - 5} more)` : ''}`);
    lines.push(`  - Complexity: ${mod.complexity}, LOC: ${mod.loc}`);
    lines.push(`  - Evidence: ${mod.path}:1`);
  }

  return lines;
}

/**
 * Format documentation structure grouped by directory
 */
function formatDocumentationStructure(files: IngestedFile[]): string[] {
  const docFiles = files
    .filter((f) => f.kind === 'doc')
    .map((f) => f.repoRelativePath)
    .sort();

  if (!docFiles.length) return [];

  // Group by directory (up to MAX_DOC_DEPTH)
  const groups = new Map<string, string[]>();
  for (const filePath of docFiles) {
    const parts = filePath.split('/');
    const depth = parts.length - 1;
    const dir = depth > MAX_DOC_DEPTH ? parts.slice(0, MAX_DOC_DEPTH).join('/') + '/...' : parts.slice(0, -1).join('/') || '.';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(parts[parts.length - 1]!);
  }

  const lines: string[] = [];
  let totalEntries = 0;

  for (const [dir, fileNames] of groups.entries()) {
    if (totalEntries >= MAX_DOC_ENTRIES) {
      lines.push(`- ... and ${docFiles.length - totalEntries} more files`);
      break;
    }

    const remaining = MAX_DOC_ENTRIES - totalEntries;
    const displayDir = dir === '.' ? '(root)' : dir;

    if (fileNames.length <= remaining && fileNames.length <= 5) {
      // List individual files
      for (const name of fileNames) {
        lines.push(`- ${dir === '.' ? name : `${dir}/${name}`}`);
        totalEntries++;
      }
    } else {
      // Summarize directory
      lines.push(`- **${displayDir}/** (${fileNames.length} files)`);
      totalEntries++;
    }
  }

  return lines;
}

/**
 * Phase 3: Format standalone modules for reuse guidance
 */
function formatStandaloneModules(facts: BundleFacts): string[] {
  if (!facts.modules || facts.modules.length === 0) return [];

  const standalone = facts.modules
    .filter(m => m.standalone && (m.role === 'core' || m.role === 'utility'))
    .filter(m => m.exports.length > 0)
    .slice(0, 5);

  if (standalone.length === 0) return [];

  const lines: string[] = [];
  for (const mod of standalone) {
    const shortPath = mod.path.replace(/^repos\/[^\/]+\/[^\/]+\/norm\//, '');
    lines.push(`- **${shortPath}**`);
    lines.push(`  - Can be used independently`);
    lines.push(`  - Exports: ${mod.exports.slice(0, 3).join(', ')}`);
    lines.push(`  - External deps: ${mod.imports.filter(i => !i.startsWith('.')).slice(0, 3).join(', ') || 'None'}`);
  }

  return lines;
}

export async function generateOverviewMarkdown(params: {
  bundleId: string;
  bundleRootDir: string;
  repos: RepoOverviewInput[];
}): Promise<string> {
  // Load FACTS.json if available
  const factsPath = path.join(params.bundleRootDir, 'analysis', 'FACTS.json');
  const facts = await readFacts(factsPath);

  const sections: string[] = [];
  const allFiles = params.repos.flatMap((r) => r.files);
  const isDocProject = facts?.projectType === 'documentation';

  // Header
  sections.push(`# ${params.repos[0]?.repoId || 'Project'} - Overview\r\n`);

  if (facts && isDocProject) {
    // === DOCUMENTATION PROJECT FORMAT ===
    // README content comes first
    const purpose = await extractProjectPurpose(allFiles);
    if (purpose) {
      sections.push('## About\r\n');
      sections.push(`${purpose}\r\n`);
      sections.push('');
    }

    // Document types statistics
    if (facts.docTypes && facts.docTypes.length > 0) {
      sections.push('## Document Types\r\n');
      for (const dt of facts.docTypes) {
        sections.push(`- **${dt.docType}**: ${dt.fileCount} files (${dt.extensions.join(', ')})\r\n`);
      }
      sections.push('');
    }

    // Frameworks (for docs, these are doc frameworks like MkDocs, Docusaurus)
    if (facts.frameworks && facts.frameworks.length > 0) {
      sections.push(`**Documentation Framework**: ${facts.frameworks.join(', ')}\r\n\r\n`);
    }

    // Documentation structure
    const docStructure = formatDocumentationStructure(allFiles);
    if (docStructure.length > 0) {
      sections.push('## Documentation Structure\r\n');
      sections.push(...docStructure.map((l) => l + '\r\n'));
      sections.push('');
    }

    return sections.join('\n') + '\n';
  }

  // === CODE PROJECT FORMAT (existing behavior) ===
  if (facts) {
    sections.push('## What is this?\r\n');

    // Try to get project purpose from README
    const purpose = await extractProjectPurpose(allFiles);
    if (purpose) {
      sections.push(`${purpose}\r\n`);
    }

    // Primary language and frameworks
    if (facts.languages && facts.languages.length > 0) {
      const primaryLang = facts.languages[0];
      if (primaryLang) {
        sections.push(`**Language**: ${primaryLang.language} (${primaryLang.fileCount} files)\r\n`);
      }
    }

    if (facts.frameworks && facts.frameworks.length > 0) {
      sections.push(`**Frameworks**: ${facts.frameworks.join(', ')}\r\n`);
    }

    // Tech stack (Phase 2)
    if (facts.techStack) {
      if (facts.techStack.runtime) {
        sections.push(`**Runtime**: ${facts.techStack.runtime}\r\n`);
      }
      if (facts.techStack.packageManager) {
        sections.push(`**Package Manager**: ${facts.techStack.packageManager}\r\n`);
      }
    }

    sections.push('');
  }

  // Architecture section (code projects only)
  if (facts && !isDocProject) {
    sections.push('## Architecture\r\n');

    // Entry points
    if (facts.entryPoints && facts.entryPoints.length > 0) {
      sections.push('### Entry Points\r\n');
      for (const ep of facts.entryPoints.slice(0, 5)) {
        const shortPath = ep.file.replace(/^repos\/[^\/]+\/[^\/]+\/norm\//, '');
        sections.push(`- \`${shortPath}\` (${ep.type}). ${evidence(ep.evidence, 1, 1)}\r\n`);
      }
      sections.push('');
    }

    // Phase 2: Architecture patterns
    if (facts.patterns && facts.patterns.length > 0) {
      sections.push('### Design Patterns\r\n');
      for (const pattern of facts.patterns) {
        sections.push(`- ${pattern}\r\n`);
      }
      sections.push('');
    }

    // Phase 2: Core modules
    const coreModuleLines = formatCoreModules(facts);
    if (coreModuleLines.length > 0) {
      sections.push('### Core Modules\r\n');
      sections.push(...coreModuleLines.map((l) => l + '\r\n'));
      sections.push('');
    }
  }

  // Dependencies (code projects only)
  if (facts && !isDocProject && (facts.dependencies.runtime.length > 0 || facts.dependencies.dev.length > 0)) {
    sections.push('## Dependencies\r\n');

    if (facts.dependencies.runtime.length > 0) {
      sections.push(`### Production (${facts.dependencies.runtime.length})\r\n`);
      for (const dep of facts.dependencies.runtime.slice(0, 15)) {
        sections.push(`- ${dep.name}${dep.version ? ` ${dep.version}` : ''}\r\n`);
      }
      if (facts.dependencies.runtime.length > 15) {
        sections.push(`- ... and ${facts.dependencies.runtime.length - 15} more\r\n`);
      }
      sections.push('');
    }

    if (facts.dependencies.dev.length > 0) {
      sections.push(`### Development (${facts.dependencies.dev.length})\r\n`);
      for (const dep of facts.dependencies.dev.slice(0, 10)) {
        sections.push(`- ${dep.name}${dep.version ? ` ${dep.version}` : ''}\r\n`);
      }
      if (facts.dependencies.dev.length > 10) {
        sections.push(`- ... and ${facts.dependencies.dev.length - 10} more\r\n`);
      }
      sections.push('');
    }
  }

  // How to Reuse (code projects only)
  if (facts && !isDocProject) {
    const standaloneLines = formatStandaloneModules(facts);
    if (standaloneLines.length > 0) {
      sections.push('## How to Reuse\r\n');
      sections.push('### Standalone Modules\r\n');
      sections.push('These modules can be extracted and used independently:\r\n\r\n');
      sections.push(...standaloneLines.map((l) => l + '\r\n'));
      sections.push('');
    }

    // Phase 4: Code Analysis Summary
    const analysisSummary = await loadAnalysisSummary(params.bundleRootDir);
    if (analysisSummary) {
      sections.push('## Code Analysis Summary\r\n');

      // Overall summary
      if (analysisSummary.overall) {
        sections.push(analysisSummary.overall + '\r\n\r\n');
      }

      // Individual analyzer summaries with highlights
      for (const analyzer of analysisSummary.analyzers) {
        sections.push(`### ${analyzer.analyzerName}\r\n`);
        sections.push(`${analyzer.summary}\r\n`);

        // Show highlights if available
        if (analyzer.highlights && analyzer.highlights.length > 0) {
          sections.push('\r\n**Key Findings:**\r\n');
          for (const h of analyzer.highlights.slice(0, 3)) {
            const location = h.file ? ` (${h.file}${h.line ? `:${h.line}` : ''})` : '';
            sections.push(`- ${h.description}${location}\r\n`);
          }
        }
        sections.push('');
      }
    }

    // Return Phase 3 format directly
    return sections.join('\n') + '\n';
  }

  // Return if we have facts (mixed project or other cases)
  if (facts) {
    return sections.join('\n') + '\n';
  }

  // Fallback to legacy format if no FACTS
  {
    const header = `# OVERVIEW.md - Preflight Bundle ${params.bundleId}\r\n\r\nThis file is generated. It contains **only factual statements** with evidence pointers into bundle files.\r\n\r\n`;
    sections.splice(0, sections.length); // Clear Phase 3 sections
    sections.push(header);

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
  }

  return sections.join('\n') + '\n';
}

export async function writeOverviewFile(targetPath: string, markdown: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, markdown, 'utf8');
}
