/**
 * Bundle Facts Extraction
 *
 * Core functionality for extracting metadata from bundles.
 * Phase 2 module analysis is in facts-modules.ts.
 *
 * @module bundle/facts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { type IngestedFile } from './ingest.js';
import {
  createUnifiedAnalyzer,
  type ExtensionPointInfo,
  type TypeSemantics,
  type UnifiedAnalysisResult,
} from '../analysis/index.js';
import {
  createArchitectureSummaryExtractor,
  type ArchitectureSummary,
} from '../analysis/architecture-summary.js';

// Re-export types for backward compatibility
export type {
  BundleFacts,
  LanguageStats,
  EntryPoint,
  DependencyInfo,
  FileStructureInfo,
  ModuleInfo,
  TechStackInfo,
  FeatureInfo,
} from './facts-types.js';

import type {
  BundleFacts,
  LanguageStats,
  DependencyInfo,
  FileStructureInfo,
  EntryPoint,
  ModuleInfo,
  TechStackInfo,
  FeatureInfo,
} from './facts-types.js';
import {
  analyzeModules,
  detectArchitecturePatterns,
  analyzeTechStack,
} from './facts-modules.js';

/**
 * Detect languages from file extensions (includes both code and doc languages)
 */
function detectLanguages(files: IngestedFile[]): LanguageStats[] {
  const langMap = new Map<string, { exts: Set<string>; kind: 'code' | 'doc' }>();

  // Code language mappings
  const codeExtToLang: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.mjs': 'JavaScript',
    '.cjs': 'JavaScript',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.rb': 'Ruby',
    '.php': 'PHP',
    '.c': 'C',
    '.cpp': 'C++',
    '.cc': 'C++',
    '.h': 'C/C++',
    '.hpp': 'C++',
    '.cs': 'C#',
    '.swift': 'Swift',
    '.kt': 'Kotlin',
    '.scala': 'Scala',
    '.sh': 'Shell',
    '.bash': 'Shell',
    '.zsh': 'Shell',
  };

  // Doc language mappings (aligned with detectDocTypes)
  const docExtToLang: Record<string, string> = {
    '.md': 'Markdown',
    '.mdx': 'Markdown',
    '.rst': 'reStructuredText',
    '.adoc': 'AsciiDoc',
    '.txt': 'Plain Text',
  };

  // Process code files
  for (const file of files) {
    if (file.kind !== 'code') continue;
    const ext = path.extname(file.repoRelativePath).toLowerCase();
    const lang = codeExtToLang[ext] || 'Other';

    if (!langMap.has(lang)) {
      langMap.set(lang, { exts: new Set(), kind: 'code' });
    }
    langMap.get(lang)!.exts.add(ext);
  }

  // Process doc files (merge into languages for unified view)
  for (const file of files) {
    if (file.kind !== 'doc') continue;
    const ext = path.extname(file.repoRelativePath).toLowerCase();
    const lang = docExtToLang[ext];
    if (!lang) continue;

    if (!langMap.has(lang)) {
      langMap.set(lang, { exts: new Set(), kind: 'doc' });
    }
    langMap.get(lang)!.exts.add(ext);
  }

  return Array.from(langMap.entries())
    .map(([language, { exts, kind }]) => ({
      language,
      fileCount: files.filter(
        (f) => f.kind === kind && exts.has(path.extname(f.repoRelativePath).toLowerCase())
      ).length,
      extensions: Array.from(exts).sort(),
    }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

/**
 * Find entry points in the repository
 */
async function findEntryPoints(
  files: IngestedFile[],
  bundleRoot: string,
  repoId: string
): Promise<EntryPoint[]> {
  const entryPoints: EntryPoint[] = [];
  const [owner, repo] = repoId.split('/');

  // Check package.json for Node.js projects
  const pkgJson = files.find((f) => f.repoRelativePath === 'package.json');
  if (pkgJson) {
    try {
      const content = await fs.readFile(pkgJson.bundleNormAbsPath, 'utf8');
      const pkg = JSON.parse(content);

      if (pkg.main) {
        entryPoints.push({
          type: 'package-main',
          file: `repos/${owner}/${repo}/norm/${pkg.main}`,
          evidence: `${pkgJson.bundleNormRelativePath}:1`,
        });
      }

      if (pkg.bin) {
        const binEntries = typeof pkg.bin === 'string' ? { [repo!]: pkg.bin } : pkg.bin;
        for (const [name, binPath] of Object.entries(binEntries)) {
          entryPoints.push({
            type: 'package-bin',
            file: `repos/${owner}/${repo}/norm/${binPath}`,
            evidence: `${pkgJson.bundleNormRelativePath}:1`,
          });
        }
      }
    } catch {
      // Ignore parsing errors
    }
  }

  // Common entry point patterns
  const commonEntries = ['index.ts', 'index.js', 'main.ts', 'main.js', 'src/index.ts', 'src/main.ts'];
  for (const entry of commonEntries) {
    const file = files.find((f) => f.repoRelativePath === entry);
    if (file) {
      entryPoints.push({
        type: entry.includes('index') ? 'index-file' : 'main-file',
        file: file.bundleNormRelativePath,
        evidence: `${file.bundleNormRelativePath}:1`,
      });
    }
  }

  return entryPoints;
}

/**
 * Extract dependency information
 */
async function extractDependencies(
  files: IngestedFile[],
  bundleRoot: string
): Promise<DependencyInfo> {
  const result: DependencyInfo = {
    runtime: [],
    dev: [],
    manager: 'unknown',
  };

  // Node.js - package.json
  const pkgJson = files.find((f) => f.repoRelativePath === 'package.json');
  if (pkgJson) {
    result.manager = 'npm';
    try {
      const content = await fs.readFile(pkgJson.bundleNormAbsPath, 'utf8');
      const pkg = JSON.parse(content);

      if (pkg.dependencies) {
        for (const [name, version] of Object.entries(pkg.dependencies)) {
          result.runtime.push({
            name,
            version: String(version),
            evidence: `${pkgJson.bundleNormRelativePath}:1`,
          });
        }
      }

      if (pkg.devDependencies) {
        for (const [name, version] of Object.entries(pkg.devDependencies)) {
          result.dev.push({
            name,
            version: String(version),
            evidence: `${pkgJson.bundleNormRelativePath}:1`,
          });
        }
      }
    } catch {
      // Ignore parsing errors
    }
  }

  // Python - requirements.txt
  const reqTxt = files.find((f) => f.repoRelativePath === 'requirements.txt');
  if (reqTxt) {
    result.manager = 'pip';
    try {
      const content = await fs.readFile(reqTxt.bundleNormAbsPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim() ?? '';
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([a-zA-Z0-9_-]+)(==|>=|<=|~=)?(.+)?/);
        if (match) {
          result.runtime.push({
            name: match[1]!,
            version: match[3],
            evidence: `${reqTxt.bundleNormRelativePath}:${i + 1}`,
          });
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // Go - go.mod
  const goMod = files.find((f) => f.repoRelativePath === 'go.mod');
  if (goMod) {
    result.manager = 'go';
    try {
      const content = await fs.readFile(goMod.bundleNormAbsPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim() ?? '';
        const match = line.match(/^\s*([^\s]+)\s+v?([0-9.]+)/);
        if (match) {
          result.runtime.push({
            name: match[1]!,
            version: match[2],
            evidence: `${goMod.bundleNormRelativePath}:${i + 1}`,
          });
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return result;
}

/**
 * Analyze file structure
 */
function analyzeFileStructure(files: IngestedFile[]): FileStructureInfo {
  const topLevelDirs = new Set<string>();

  for (const file of files) {
    const parts = file.repoRelativePath.split('/');
    if (parts.length > 1 && parts[0]) {
      topLevelDirs.add(parts[0]);
    }
  }

  const hasTests = files.some(
    (f) =>
      f.repoRelativePath.includes('/test/') ||
      f.repoRelativePath.includes('/tests/') ||
      f.repoRelativePath.includes('/__tests__/') ||
      f.repoRelativePath.includes('.test.') ||
      f.repoRelativePath.includes('.spec.')
  );

  const hasConfig = files.some(
    (f) =>
      f.repoRelativePath.includes('config') ||
      f.repoRelativePath.endsWith('.config.js') ||
      f.repoRelativePath.endsWith('.config.ts') ||
      f.repoRelativePath.endsWith('.json')
  );

  return {
    totalFiles: files.length,
    totalDocs: files.filter((f) => f.kind === 'doc').length,
    totalCode: files.filter((f) => f.kind === 'code').length,
    topLevelDirs: Array.from(topLevelDirs).sort(),
    hasTests,
    hasConfig,
  };
}

/**
 * Detect document types from files
 */
function detectDocTypes(files: IngestedFile[]): Array<{ docType: string; fileCount: number; extensions: string[] }> {
  const docTypeMap = new Map<string, Set<string>>();

  const extToDocType: Record<string, string> = {
    '.md': 'Markdown',
    '.mdx': 'Markdown',
    '.rst': 'reStructuredText',
    '.adoc': 'AsciiDoc',
    '.txt': 'Plain Text',
  };

  for (const file of files) {
    if (file.kind !== 'doc') continue;
    const ext = path.extname(file.repoRelativePath).toLowerCase();
    const docType = extToDocType[ext];
    if (!docType) continue;

    if (!docTypeMap.has(docType)) {
      docTypeMap.set(docType, new Set());
    }
    docTypeMap.get(docType)!.add(ext);
  }

  return Array.from(docTypeMap.entries())
    .map(([docType, exts]) => ({
      docType,
      fileCount: files.filter(
        (f) => f.kind === 'doc' && exts.has(path.extname(f.repoRelativePath).toLowerCase())
      ).length,
      extensions: Array.from(exts).sort(),
    }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

/**
 * Detect project type based on code/doc ratio
 */
function detectProjectType(fileStructure: FileStructureInfo): 'code' | 'documentation' | 'mixed' {
  const { totalCode, totalDocs } = fileStructure;

  if (totalDocs === 0 && totalCode === 0) return 'mixed';
  if (totalDocs > totalCode * 2) return 'documentation';
  if (totalCode > totalDocs * 2) return 'code';
  return 'mixed';
}

/**
 * Detect documentation frameworks from file patterns
 */
function detectDocFrameworks(files: IngestedFile[]): string[] {
  const frameworks = new Set<string>();
  const pathSet = new Set(files.map((f) => f.repoRelativePath.toLowerCase()));
  const dirSet = new Set<string>();

  for (const file of files) {
    const parts = file.repoRelativePath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      dirSet.add(parts.slice(0, i).join('/').toLowerCase());
    }
  }

  // MkDocs: mkdocs.yml
  if (pathSet.has('mkdocs.yml') || pathSet.has('mkdocs.yaml')) {
    frameworks.add('MkDocs');
  }

  // Docusaurus: docusaurus.config.*
  if (
    pathSet.has('docusaurus.config.js') ||
    pathSet.has('docusaurus.config.ts') ||
    pathSet.has('docusaurus.config.mjs')
  ) {
    frameworks.add('Docusaurus');
  }

  // Jekyll: _config.yml + _layouts/
  if (pathSet.has('_config.yml') && dirSet.has('_layouts')) {
    frameworks.add('Jekyll');
  }

  // VuePress: docs/.vuepress/
  if (dirSet.has('docs/.vuepress') || dirSet.has('.vuepress')) {
    frameworks.add('VuePress');
  }

  // GitBook: SUMMARY.md
  if (pathSet.has('summary.md')) {
    frameworks.add('GitBook');
  }

  return Array.from(frameworks).sort();
}

/**
 * Detect frameworks from dependencies and file patterns
 */
function detectFrameworks(deps: DependencyInfo, files: IngestedFile[]): string[] {
  const frameworks = new Set<string>();

  const allDeps = [...deps.runtime, ...deps.dev].map((d) => d.name.toLowerCase());

  // JavaScript/TypeScript web frameworks
  if (allDeps.includes('react')) frameworks.add('React');
  if (allDeps.includes('vue')) frameworks.add('Vue');
  if (allDeps.includes('angular')) frameworks.add('Angular');
  if (allDeps.includes('next')) frameworks.add('Next.js');
  if (allDeps.includes('nuxt')) frameworks.add('Nuxt');
  if (allDeps.includes('express')) frameworks.add('Express');
  if (allDeps.includes('fastify')) frameworks.add('Fastify');
  if (allDeps.includes('nestjs') || allDeps.includes('@nestjs/core')) frameworks.add('NestJS');

  // JavaScript/TypeScript AI/LLM SDKs (scoped packages)
  if (allDeps.some((d) => d.startsWith('@anthropic-ai/'))) frameworks.add('Anthropic');
  if (allDeps.some((d) => d.startsWith('@modelcontextprotocol/'))) frameworks.add('MCP');

  // JavaScript/TypeScript CLI frameworks
  if (allDeps.includes('commander')) frameworks.add('Commander');
  if (allDeps.includes('yargs')) frameworks.add('Yargs');
  if (allDeps.includes('ink')) frameworks.add('Ink');
  if (allDeps.includes('inquirer') || allDeps.includes('@inquirer/prompts')) frameworks.add('Inquirer');

  // JavaScript/TypeScript validation
  if (allDeps.includes('zod')) frameworks.add('Zod');

  // Python web frameworks
  if (allDeps.includes('django')) frameworks.add('Django');
  if (allDeps.includes('flask')) frameworks.add('Flask');
  if (allDeps.includes('fastapi')) frameworks.add('FastAPI');
  if (allDeps.includes('starlette')) frameworks.add('Starlette');
  if (allDeps.includes('uvicorn')) frameworks.add('Uvicorn');

  // Python AI/LLM frameworks
  if (allDeps.includes('anthropic')) frameworks.add('Anthropic');
  if (allDeps.includes('openai')) frameworks.add('OpenAI');
  if (allDeps.includes('langchain')) frameworks.add('LangChain');
  if (allDeps.includes('mcp')) frameworks.add('MCP');

  // Python data/scraping
  if (allDeps.includes('beautifulsoup4')) frameworks.add('BeautifulSoup');
  if (allDeps.includes('scrapy')) frameworks.add('Scrapy');
  if (allDeps.includes('httpx')) frameworks.add('HTTPX');
  if (allDeps.includes('requests')) frameworks.add('Requests');

  // Python CLI
  if (allDeps.includes('click')) frameworks.add('Click');
  if (allDeps.includes('typer')) frameworks.add('Typer');

  // Python data validation
  if (allDeps.includes('pydantic')) frameworks.add('Pydantic');

  // Test frameworks
  if (allDeps.includes('jest')) frameworks.add('Jest');
  if (allDeps.includes('vitest')) frameworks.add('Vitest');
  if (allDeps.includes('pytest')) frameworks.add('Pytest');
  if (allDeps.includes('unittest')) frameworks.add('unittest');

  return Array.from(frameworks).sort();
}

/**
 * Detect AI agent platforms from directory structure and config files
 */
function detectAgentPlatforms(files: IngestedFile[]): string[] {
  const platforms = new Set<string>();
  const pathSet = new Set(files.map((f) => f.repoRelativePath.toLowerCase()));
  const dirSet = new Set<string>();

  for (const file of files) {
    const parts = file.repoRelativePath.split('/');
    if (parts.length > 0) {
      dirSet.add(parts[0]!.toLowerCase());
    }
  }

  // Claude Code: .claude-plugin/ directory
  if (dirSet.has('.claude-plugin')) platforms.add('Claude Code');

  // Codex: .codex/ directory
  if (dirSet.has('.codex')) platforms.add('Codex');

  // OpenCode: .opencode/ directory
  if (dirSet.has('.opencode')) platforms.add('OpenCode');

  // Cursor: .cursor/ directory or .cursorrules file
  if (dirSet.has('.cursor') || pathSet.has('.cursorrules')) platforms.add('Cursor');

  // Windsurf: .windsurfrules file
  if (pathSet.has('.windsurfrules')) platforms.add('Windsurf');

  return Array.from(platforms).sort();
}

/**
 * Extract feature/skill information from well-known directories.
 * Reads SKILL.md, README.md, or index.md to extract a short description.
 */
async function extractFeatures(files: IngestedFile[]): Promise<FeatureInfo[]> {
  // Well-known skill/capability directories (not code modules like features/)
  const featureDirs = ['skills', 'plugins', 'agents'];
  // Files to look for description (in priority order)
  const descFiles = ['skill.md', 'readme.md', 'index.md'];

  // Group files by feature directory
  const featureFiles = new Map<string, IngestedFile[]>();

  for (const file of files) {
    const parts = file.repoRelativePath.split('/');
    // Need at least 3 parts: topDir/subDir/file
    if (parts.length < 3) continue;

    const topDir = parts[0]!.toLowerCase();
    const subDir = parts[1]!;

    if (featureDirs.includes(topDir) && subDir && !subDir.startsWith('.')) {
      const key = `${topDir}/${subDir}`;
      if (!featureFiles.has(key)) {
        featureFiles.set(key, []);
      }
      featureFiles.get(key)!.push(file);
    }
  }

  // Extract features with descriptions
  const features: FeatureInfo[] = [];

  for (const [key, fileList] of featureFiles) {
    const name = key.split('/')[1]!;
    let desc: string | undefined;

    // Find description file
    for (const descFileName of descFiles) {
      const descFile = fileList.find(
        (f) => f.repoRelativePath.split('/').pop()?.toLowerCase() === descFileName
      );
      if (descFile) {
        desc = await extractFirstParagraph(descFile.bundleNormAbsPath);
        if (desc) break;
      }
    }

    features.push({ name, desc });
  }

  return features.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract first meaningful paragraph from a markdown file.
 * Skips frontmatter, headings, and badges.
 */
async function extractFirstParagraph(filePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    let inFrontmatter = false;
    let foundHeading = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip frontmatter
      if (trimmed === '---') {
        inFrontmatter = !inFrontmatter;
        continue;
      }
      if (inFrontmatter) continue;

      // Skip empty lines
      if (!trimmed) continue;

      // Skip headings but mark that we passed one
      if (trimmed.startsWith('#')) {
        foundHeading = true;
        continue;
      }

      // Skip badges/images
      if (trimmed.startsWith('![') || trimmed.startsWith('[![')) continue;

      // Found a content line - take first sentence or up to 150 chars
      const firstSentence = trimmed.match(/^[^.!?]+[.!?]/);
      if (firstSentence) {
        return firstSentence[0].slice(0, 150);
      }
      return trimmed.slice(0, 150);
    }
  } catch {
    // File read error - return undefined
  }
  return undefined;
}

/**
 * Extract all facts from a bundle
 */
export async function extractBundleFacts(params: {
  bundleRoot: string;
  repos: Array<{ repoId: string; files: IngestedFile[] }>;
  enablePhase2?: boolean; // Enable Phase 2 module analysis
  enableSemanticAnalysis?: boolean; // Enable ts-morph semantic analysis (code projects only)
  enableFrameworkDetection?: boolean; // Enable framework detection (all projects)
}): Promise<BundleFacts> {
  // Aggregate all files
  const allFiles = params.repos.flatMap((r) => r.files);

  // Extract facts
  const languages = detectLanguages(allFiles);
  const docTypes = detectDocTypes(allFiles);
  const fileStructure = analyzeFileStructure(allFiles);
  const projectType = detectProjectType(fileStructure);

  // Skip entry point detection for web sources (they don't have package.json, etc.)
  const entryPointsPromises = params.repos
    .filter((r) => !r.repoId.startsWith('web/'))
    .map((r) =>
      findEntryPoints(r.files, params.bundleRoot, r.repoId)
    );
  const entryPointsArrays = await Promise.all(entryPointsPromises);
  const entryPoints = entryPointsArrays.flat();

  const dependencies = await extractDependencies(allFiles, params.bundleRoot);
  
  // Detect code frameworks from dependencies
  let frameworks = detectFrameworks(dependencies, allFiles);
  
  // Detect doc frameworks if framework detection is enabled
  if (params.enableFrameworkDetection) {
    const docFrameworks = detectDocFrameworks(allFiles);
    frameworks = [...new Set([...frameworks, ...docFrameworks])].sort();
  }

  // Always detect AI agent platforms (lightweight check)
  const agentPlatforms = detectAgentPlatforms(allFiles);
  if (agentPlatforms.length > 0) {
    frameworks = [...new Set([...frameworks, ...agentPlatforms])].sort();
  }

  // Extract feature/skill information from well-known directories
  const features = await extractFeatures(allFiles);

  // Phase 2: Module analysis (optional, more expensive)
  let modules: ModuleInfo[] | undefined;
  let patterns: string[] | undefined;
  let techStack: TechStackInfo | undefined;

  if (params.enablePhase2) {
    modules = await analyzeModules(allFiles);
    patterns = detectArchitecturePatterns(allFiles, modules);
    techStack = analyzeTechStack(languages, dependencies, frameworks);
  }

  // Phase 3: Extension point analysis (optional, uses ts-morph for TS/JS)
  let extensionPoints: ExtensionPointInfo[] | undefined;
  let typeSemantics: TypeSemantics | undefined;
  let extensionSummary: UnifiedAnalysisResult['summary'] | undefined;
  let architectureSummary: ArchitectureSummary | undefined;

  // Supported extensions for Phase 3 (TypeScript + JavaScript + Python + Go + Rust)
  const phase3Extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs']);

  if (params.enableSemanticAnalysis) {
    const analyzer = createUnifiedAnalyzer();
    
    // Prepare files for analysis (both TypeScript and JavaScript)
    const filesToAnalyze = allFiles
      .filter((f) => f.kind === 'code' && phase3Extensions.has(path.extname(f.repoRelativePath).toLowerCase()))
      .map((f) => ({
        absPath: f.bundleNormAbsPath,
        relativePath: f.bundleNormRelativePath,
      }));
    
    const analysisResult = await analyzer.analyzeFiles(filesToAnalyze);
    
    extensionPoints = analysisResult.extensionPoints;
    typeSemantics = analysisResult.typeSemantics;
    extensionSummary = analysisResult.summary;
    
    analyzer.clearCache();

    // Phase 4: Architecture summary (bird's eye view for LLMs)
    const archExtractor = createArchitectureSummaryExtractor();
    const extToLang: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript',
      '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
      '.py': 'python', '.go': 'go', '.rs': 'rust',
    };
    
    const filesForArch = await Promise.all(
      allFiles
        .filter((f) => f.kind === 'code' && phase3Extensions.has(path.extname(f.repoRelativePath).toLowerCase()))
        .map(async (f) => {
          const content = await fs.readFile(f.bundleNormAbsPath, 'utf8');
          const ext = path.extname(f.repoRelativePath).toLowerCase();
          return {
            absPath: f.bundleNormAbsPath,
            relativePath: f.bundleNormRelativePath,
            content,
            language: extToLang[ext] || 'unknown',
          };
        })
    );
    
    architectureSummary = await archExtractor.extractSummary(filesForArch, {
      extensionPoints: extensionPoints?.map((ep) => ({
        kind: ep.kind,
        name: ep.name,
        file: ep.file,
        line: ep.line,
      })),
    });
  }

  // Documentation project fallback: ensure patterns has at least "documentation"
  if (projectType === 'documentation' && (!patterns || patterns.length === 0)) {
    patterns = ['documentation'];
  }

  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    projectType,
    languages,
    docTypes: docTypes.length > 0 ? docTypes : undefined,
    entryPoints,
    dependencies,
    fileStructure,
    frameworks,
    features: features.length > 0 ? features : undefined,
    modules,
    patterns,
    techStack,
    extensionPoints,
    typeSemantics,
    extensionSummary,
    architectureSummary,
  };
}

/**
 * Write facts to JSON file
 */
export async function writeFacts(factsPath: string, facts: BundleFacts): Promise<void> {
  await fs.mkdir(path.dirname(factsPath), { recursive: true });
  await fs.writeFile(factsPath, JSON.stringify(facts, null, 2) + '\n', 'utf8');
}

/**
 * Read facts from JSON file
 */
export async function readFacts(factsPath: string): Promise<BundleFacts | null> {
  try {
    const content = await fs.readFile(factsPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
