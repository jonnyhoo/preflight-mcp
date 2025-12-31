import fs from 'node:fs/promises';
import path from 'node:path';
import { extractModuleSyntaxWasm } from '../ast/treeSitter.js';
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

export type BundleFacts = {
  version: string;
  timestamp: string;
  languages: LanguageStats[];
  entryPoints: EntryPoint[];
  dependencies: DependencyInfo;
  fileStructure: FileStructureInfo;
  frameworks: string[];
  modules?: ModuleInfo[]; // Phase 2: Module analysis
  patterns?: string[]; // Phase 2: Architecture patterns
  techStack?: TechStackInfo; // Phase 2: Technology stack
  // Phase 3: Extension point analysis
  extensionPoints?: ExtensionPointInfo[];
  typeSemantics?: TypeSemantics;
  extensionSummary?: UnifiedAnalysisResult['summary'];
  // Phase 4: Architecture overview (gives LLM bird's eye view)
  architectureSummary?: ArchitectureSummary;
};

export type LanguageStats = {
  language: string;
  fileCount: number;
  extensions: string[];
};

export type EntryPoint = {
  type: 'package-main' | 'package-bin' | 'index-file' | 'main-file';
  file: string;
  evidence: string;
};

export type DependencyInfo = {
  runtime: Array<{ name: string; version?: string; evidence: string }>;
  dev: Array<{ name: string; version?: string; evidence: string }>;
  manager: 'npm' | 'pip' | 'go' | 'cargo' | 'maven' | 'unknown';
};

export type FileStructureInfo = {
  totalFiles: number;
  totalDocs: number;
  totalCode: number;
  topLevelDirs: string[];
  hasTests: boolean;
  hasConfig: boolean;
};

/**
 * Phase 2: Module information
 */
export type ModuleInfo = {
  path: string; // Bundle-relative path
  exports: string[]; // Exported symbols
  imports: string[]; // Imported modules (both external and internal)
  role: 'core' | 'utility' | 'test' | 'config' | 'example' | 'unknown';
  standalone: boolean; // Can be used independently
  complexity: 'low' | 'medium' | 'high'; // Based on LOC and dependencies
  loc: number; // Lines of code
};

/**
 * Phase 2: Technology stack information
 */
export type TechStackInfo = {
  language: string; // Primary language
  runtime?: string; // e.g., "Node.js", "Python 3.x"
  packageManager?: string; // e.g., "npm", "pip"
  buildTools?: string[]; // e.g., ["TypeScript", "Webpack"]
  testFrameworks?: string[]; // e.g., ["Jest", "Pytest"]
};

/**
 * Detect programming languages from file extensions
 */
function detectLanguages(files: IngestedFile[]): LanguageStats[] {
  const langMap = new Map<string, Set<string>>();

  const extToLang: Record<string, string> = {
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
  };

  for (const file of files) {
    if (file.kind !== 'code') continue;
    const ext = path.extname(file.repoRelativePath).toLowerCase();
    const lang = extToLang[ext] || 'Other';

    if (!langMap.has(lang)) {
      langMap.set(lang, new Set());
    }
    langMap.get(lang)!.add(ext);
  }

  return Array.from(langMap.entries())
    .map(([language, exts]) => ({
      language,
      fileCount: files.filter(
        (f) => f.kind === 'code' && exts.has(path.extname(f.repoRelativePath).toLowerCase())
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
 * Detect frameworks from dependencies and file patterns
 */
function detectFrameworks(deps: DependencyInfo, files: IngestedFile[]): string[] {
  const frameworks = new Set<string>();

  const allDeps = [...deps.runtime, ...deps.dev].map((d) => d.name.toLowerCase());

  // JavaScript/TypeScript frameworks
  if (allDeps.includes('react')) frameworks.add('React');
  if (allDeps.includes('vue')) frameworks.add('Vue');
  if (allDeps.includes('angular')) frameworks.add('Angular');
  if (allDeps.includes('next')) frameworks.add('Next.js');
  if (allDeps.includes('nuxt')) frameworks.add('Nuxt');
  if (allDeps.includes('express')) frameworks.add('Express');
  if (allDeps.includes('fastify')) frameworks.add('Fastify');
  if (allDeps.includes('nestjs')) frameworks.add('NestJS');

  // Python frameworks
  if (allDeps.includes('django')) frameworks.add('Django');
  if (allDeps.includes('flask')) frameworks.add('Flask');
  if (allDeps.includes('fastapi')) frameworks.add('FastAPI');

  // Test frameworks
  if (allDeps.includes('jest')) frameworks.add('Jest');
  if (allDeps.includes('vitest')) frameworks.add('Vitest');
  if (allDeps.includes('pytest')) frameworks.add('Pytest');

  return Array.from(frameworks).sort();
}

/**
 * Extract all facts from a bundle
 */
export async function extractBundleFacts(params: {
  bundleRoot: string;
  repos: Array<{ repoId: string; files: IngestedFile[] }>;
  enablePhase2?: boolean; // Enable Phase 2 module analysis
  enablePhase3?: boolean; // Enable Phase 3 extension point analysis
}): Promise<BundleFacts> {
  // Aggregate all files
  const allFiles = params.repos.flatMap((r) => r.files);

  // Extract facts
  const languages = detectLanguages(allFiles);

  const entryPointsPromises = params.repos.map((r) =>
    findEntryPoints(r.files, params.bundleRoot, r.repoId)
  );
  const entryPointsArrays = await Promise.all(entryPointsPromises);
  const entryPoints = entryPointsArrays.flat();

  const dependencies = await extractDependencies(allFiles, params.bundleRoot);
  const fileStructure = analyzeFileStructure(allFiles);
  const frameworks = detectFrameworks(dependencies, allFiles);

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

  if (params.enablePhase3) {
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

  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    languages,
    entryPoints,
    dependencies,
    fileStructure,
    frameworks,
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

/**
 * Phase 2: Extract exports from a code file using regex
 */
function extractExports(content: string, filePath: string): string[] {
  const exports: string[] = [];
  const lines = content.split('\n');

  // Detect file language
  const ext = path.extname(filePath).toLowerCase();
  const isTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  const isPython = ext === '.py';
  const isGo = ext === '.go';

  if (isTS) {
    // TypeScript/JavaScript export patterns
    for (const line of lines) {
      // export function/class/const/let/var/type/interface
      const match1 = line.match(/^\s*export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([a-zA-Z_$][\w$]*)/);
      if (match1?.[1]) {
        exports.push(match1[1]);
        continue;
      }

      // export { xxx, yyy }
      const match2 = line.match(/^\s*export\s*\{\s*([^}]+)\s*\}/);
      if (match2?.[1]) {
        const names = match2[1].split(',').map(n => {
          const parts = n.trim().split(/\s+as\s+/);
          return parts[parts.length - 1]?.trim() || '';
        }).filter(Boolean);
        exports.push(...names);
        continue;
      }

      // export default
      if (line.match(/^\s*export\s+default\s+/)) {
        exports.push('default');
      }
    }
  } else if (isPython) {
    // Python: __all__ = [...]
    const allMatch = content.match(/__all__\s*=\s*\[([^\]]+)\]/);
    if (allMatch?.[1]) {
      const names = allMatch[1].split(',').map(n => n.trim().replace(/["']/g, '')).filter(Boolean);
      exports.push(...names);
    }

    // Top-level functions and classes (heuristic)
    for (const line of lines) {
      const funcMatch = line.match(/^def\s+([a-zA-Z_][\w]*)/);
      if (funcMatch?.[1] && !funcMatch[1].startsWith('_')) {
        exports.push(funcMatch[1]);
      }

      const classMatch = line.match(/^class\s+([a-zA-Z_][\w]*)/);
      if (classMatch?.[1] && !classMatch[1].startsWith('_')) {
        exports.push(classMatch[1]);
      }
    }
  } else if (isGo) {
    // Go: public functions/types (start with uppercase)
    for (const line of lines) {
      const funcMatch = line.match(/^func\s+([A-Z][\w]*)/);
      if (funcMatch?.[1]) {
        exports.push(funcMatch[1]);
      }

      const typeMatch = line.match(/^type\s+([A-Z][\w]*)/);
      if (typeMatch?.[1]) {
        exports.push(typeMatch[1]);
      }
    }
  }

  return [...new Set(exports)]; // Remove duplicates
}

/**
 * Phase 2: Extract imports from a code file using regex
 */
function extractImports(content: string, filePath: string): string[] {
  const imports: string[] = [];
  const lines = content.split('\n');

  const ext = path.extname(filePath).toLowerCase();
  const isTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  const isPython = ext === '.py';
  const isGo = ext === '.go';

  if (isTS) {
    // import ... from 'xxx'
    for (const line of lines) {
      const match1 = line.match(/from\s+['"]([^'"]+)['"]/);
      if (match1?.[1]) {
        imports.push(match1[1]);
        continue;
      }

      // import 'xxx' or import('xxx')
      const match2 = line.match(/import\s*\(?\s*['"]([^'"]+)['"]/);
      if (match2?.[1]) {
        imports.push(match2[1]);
        continue;
      }

      // require('xxx')
      const match3 = line.match(/require\s*\(\s*['"]([^'"]+)['"]/);
      if (match3?.[1]) {
        imports.push(match3[1]);
      }
    }
  } else if (isPython) {
    // import xxx or from xxx import
    for (const line of lines) {
      const match1 = line.match(/^\s*import\s+([a-zA-Z_][\w.]*)/);
      if (match1?.[1]) {
        imports.push(match1[1].split('.')[0]!);
        continue;
      }

      const match2 = line.match(/^\s*from\s+([a-zA-Z_][\w.]*)\s+import/);
      if (match2?.[1]) {
        imports.push(match2[1].split('.')[0]!);
      }
    }
  } else if (isGo) {
    // Go: import statements
    const importBlock = content.match(/import\s*\(([^)]+)\)/);
    if (importBlock?.[1]) {
      const lines = importBlock[1].split('\n');
      for (const line of lines) {
        const match = line.match(/["']([^"']+)["']/);
        if (match?.[1]) {
          imports.push(match[1]);
        }
      }
    }

    // Single import
    for (const line of lines) {
      const match = line.match(/^\s*import\s+["']([^"']+)["']/);
      if (match?.[1]) {
        imports.push(match[1]);
      }
    }
  }

  return [...new Set(imports)]; // Remove duplicates
}

/**
 * Phase 2: Determine module role based on path and usage
 */
function determineModuleRole(
  file: IngestedFile,
  importedBy: Set<string>
): 'core' | 'utility' | 'test' | 'config' | 'example' | 'unknown' {
  const p = file.repoRelativePath.toLowerCase();

  // Test files
  if (
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/__tests__/') ||
    p.includes('.test.') ||
    p.includes('.spec.')
  ) {
    return 'test';
  }

  // Config files
  if (
    p.includes('config') ||
    p.endsWith('.config.ts') ||
    p.endsWith('.config.js') ||
    p.includes('/scripts/')
  ) {
    return 'config';
  }

  // Example files
  if (p.includes('/example') || p.includes('/demo')) {
    return 'example';
  }

  // Core: imported by multiple modules (2+)
  if (importedBy.size >= 2) {
    return 'core';
  }

  // Utility: in utils/helpers directory or imported by 1-2 modules
  if (p.includes('/util') || p.includes('/helper') || importedBy.size > 0) {
    return 'utility';
  }

  return 'unknown';
}

/**
 * Phase 2: Calculate module complexity
 */
function calculateComplexity(loc: number, importCount: number): 'low' | 'medium' | 'high' {
  // Simple heuristic based on LOC and import count
  const score = loc / 100 + importCount / 5;

  if (score < 2) return 'low';
  if (score < 5) return 'medium';
  return 'high';
}

/**
 * Phase 2: Analyze modules in the repository
 */
async function analyzeModules(files: IngestedFile[]): Promise<ModuleInfo[]> {
  const modules: ModuleInfo[] = [];

  const eligibleExtensions = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.go',
    '.java',
    '.rs',
  ]);

  const fileKey = (f: IngestedFile): string => `${f.repoId}:${f.repoRelativePath}`;

  type FileData = { exports: string[]; imports: string[]; content: string; loc: number };

  type RepoIndexes = {
    keyByRelPath: Map<string, string>; // repoRelativePath -> fileKey
    suffixIndex: Map<string, string | null>; // suffix -> fileKey (null = ambiguous)

    // Go module support
    goModules: Array<{ moduleRootDir: string; modulePath: string }>;
    goRepByDir: Map<string, string>; // dir -> representative fileKey

    // Rust crate/module support
    rustCrateRootDirs: string[]; // crate root directories (desc by length)
    rustCrateRootFiles: Set<string>; // repoRelativePath values
  };

  const buildSuffixIndex = (keyByRelPath: Map<string, string>): Map<string, string | null> => {
    const index = new Map<string, string | null>();

    const add = (suffix: string, key: string): void => {
      const existing = index.get(suffix);
      if (existing === undefined) {
        index.set(suffix, key);
        return;
      }
      if (existing !== key) {
        index.set(suffix, null);
      }
    };

    for (const [relPath, key] of keyByRelPath.entries()) {
      const parts = relPath.split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        add(parts.slice(i).join('/'), key);
      }
    }

    return index;
  };

  // Pre-pass: build per-repo lookup tables so we can resolve local imports deterministically.
  const repoIndexes = new Map<string, RepoIndexes>();
  for (const file of files) {
    if (file.kind !== 'code') continue;
    const ext = path.extname(file.repoRelativePath).toLowerCase();
    if (!eligibleExtensions.has(ext)) continue;

    let idx = repoIndexes.get(file.repoId);
    if (!idx) {
      idx = {
        keyByRelPath: new Map(),
        suffixIndex: new Map(),
        goModules: [],
        goRepByDir: new Map(),
        rustCrateRootDirs: [],
        rustCrateRootFiles: new Set(),
      };
      repoIndexes.set(file.repoId, idx);
    }
    idx.keyByRelPath.set(file.repoRelativePath, fileKey(file));
  }
  for (const idx of repoIndexes.values()) {
    idx.suffixIndex = buildSuffixIndex(idx.keyByRelPath);
  }

  const normalizeDir = (d: string): string => (d === '.' ? '' : d);

  // Go: build package directory representative map + parse go.mod module paths.
  const goModFilesByRepo = new Map<string, IngestedFile[]>();
  for (const file of files) {
    if (file.repoRelativePath === 'go.mod' || file.repoRelativePath.endsWith('/go.mod')) {
      const list = goModFilesByRepo.get(file.repoId) ?? [];
      list.push(file);
      goModFilesByRepo.set(file.repoId, list);
    }
  }

  const parseGoModulePath = (content: string): string | null => {
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//')) continue;
      const m = t.match(/^module\s+(\S+)/);
      if (m?.[1]) return m[1];
    }
    return null;
  };

  for (const [repoId, idx] of Array.from(repoIndexes.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    // go package dir -> representative file
    const goFilesByDir = new Map<string, string[]>();
    for (const relPath of idx.keyByRelPath.keys()) {
      if (!relPath.endsWith('.go')) continue;
      const dir = normalizeDir(path.posix.dirname(relPath));
      const list = goFilesByDir.get(dir) ?? [];
      list.push(relPath);
      goFilesByDir.set(dir, list);
    }
    for (const [dir, relPaths] of goFilesByDir.entries()) {
      relPaths.sort();
      const preferred = relPaths.find((p) => !p.endsWith('_test.go')) ?? relPaths[0];
      if (preferred) {
        const key = idx.keyByRelPath.get(preferred);
        if (key) idx.goRepByDir.set(dir, key);
      }
    }

    // go.mod module path(s)
    const goMods = (goModFilesByRepo.get(repoId) ?? []).slice().sort((a, b) => a.repoRelativePath.localeCompare(b.repoRelativePath));
    for (const goMod of goMods) {
      try {
        const raw = await fs.readFile(goMod.bundleNormAbsPath, 'utf8');
        const content = raw.replace(/\r\n/g, '\n');
        const modulePath = parseGoModulePath(content);
        if (!modulePath) continue;

        const moduleRootDir = normalizeDir(path.posix.dirname(goMod.repoRelativePath));
        idx.goModules.push({ moduleRootDir, modulePath });
      } catch {
        // ignore
      }
    }
    idx.goModules.sort((a, b) => {
      const len = b.moduleRootDir.length - a.moduleRootDir.length;
      if (len !== 0) return len;
      return a.moduleRootDir.localeCompare(b.moduleRootDir) || a.modulePath.localeCompare(b.modulePath);
    });

    // Rust: detect crate roots (lib/main + bin/examples/benches/tests entrypoints)
    const crateRootDirs = new Set<string>();

    const isCrateRootFile = (relPath: string): boolean => {
      if (!relPath.endsWith('.rs')) return false;
      const base = path.posix.basename(relPath);
      if (base === 'lib.rs' || base === 'main.rs') return true;
      if (base === 'mod.rs') return false;

      const dir = path.posix.dirname(relPath);
      const isEntryDir =
        dir === 'src/bin' ||
        dir.endsWith('/src/bin') ||
        dir === 'examples' ||
        dir.endsWith('/examples') ||
        dir === 'benches' ||
        dir.endsWith('/benches') ||
        dir === 'tests' ||
        dir.endsWith('/tests');

      return isEntryDir;
    };

    for (const relPath of idx.keyByRelPath.keys()) {
      if (!isCrateRootFile(relPath)) continue;
      idx.rustCrateRootFiles.add(relPath);
      crateRootDirs.add(normalizeDir(path.posix.dirname(relPath)));
    }

    idx.rustCrateRootDirs = Array.from(crateRootDirs)
      .sort((a, b) => {
        const len = b.length - a.length;
        if (len !== 0) return len;
        return a.localeCompare(b);
      });
  }

  const isJsLike = (ext: string): boolean =>
    ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);

  const resolveJsLocalImportRelPath = (params: {
    importerRelPath: string;
    specifier: string;
    keyByRelPath: Map<string, string>;
  }): string | null => {
    const cleaned = params.specifier.split(/[?#]/, 1)[0] ?? '';
    if (!cleaned || (!cleaned.startsWith('.') && !cleaned.startsWith('/'))) return null;

    const base = cleaned.startsWith('/')
      ? path.posix.normalize(cleaned.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(params.importerRelPath), cleaned));

    const addIfExists = (cand: string, out: string[]): void => {
      if (params.keyByRelPath.has(cand)) out.push(cand);
    };

    const candidates: string[] = [];
    const ext = path.posix.extname(base).toLowerCase();

    if (ext) {
      addIfExists(base, candidates);

      // TS projects often import './x.js' but source is './x.ts'
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        const stem = base.slice(0, -ext.length);
        addIfExists(`${stem}.ts`, candidates);
        addIfExists(`${stem}.tsx`, candidates);
        addIfExists(`${stem}.jsx`, candidates);
      }
      if (ext === '.jsx') {
        const stem = base.slice(0, -ext.length);
        addIfExists(`${stem}.tsx`, candidates);
        addIfExists(`${stem}.ts`, candidates);
      }
    } else {
      const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
      for (const e of exts) addIfExists(`${base}${e}`, candidates);
      for (const e of exts) addIfExists(path.posix.join(base, `index${e}`), candidates);
    }

    return candidates[0] ?? null;
  };

  const resolvePythonLocalImportKey = (params: {
    importerRelPath: string;
    specifier: string;
    suffixIndex: Map<string, string | null>;
    keyByRelPath: Map<string, string>;
  }): string | null => {
    const cleaned = params.specifier.split(/[?#]/, 1)[0]?.trim() ?? '';
    if (!cleaned) return null;

    // Relative imports: .foo / ..foo.bar
    if (cleaned.startsWith('.')) {
      const m = cleaned.match(/^(\.+)(.*)$/);
      if (!m) return null;

      const dotCount = m[1]?.length ?? 0;
      const rest = (m[2] ?? '').replace(/^\.+/, '');

      let baseDir = normalizeDir(path.posix.dirname(params.importerRelPath));
      for (let i = 1; i < dotCount; i++) {
        baseDir = normalizeDir(path.posix.dirname(baseDir));
      }

      const restPath = rest ? rest.replace(/\./g, '/') : '';

      const candidates: string[] = [];
      if (restPath) {
        candidates.push(normalizeDir(path.posix.join(baseDir, `${restPath}.py`)));
        candidates.push(normalizeDir(path.posix.join(baseDir, restPath, '__init__.py')));
      } else {
        candidates.push(normalizeDir(path.posix.join(baseDir, '__init__.py')));
      }

      for (const cand of candidates) {
        const direct = params.keyByRelPath.get(cand);
        if (direct) return direct;
      }

      return null;
    }

    // If the import is already a path, try to match directly.
    if (cleaned.startsWith('/')) {
      const asPath = cleaned.slice(1);
      const direct = params.keyByRelPath.get(asPath);
      if (direct) return direct;
    }

    // Dotted module name -> file path suffix (best-effort, unique-match only).
    const modulePath = cleaned.replace(/\./g, '/');
    const candFile = `${modulePath}.py`;
    const candInit = path.posix.join(modulePath, '__init__.py');

    const directFile = params.keyByRelPath.get(candFile);
    if (directFile) return directFile;
    const directInit = params.keyByRelPath.get(candInit);
    if (directInit) return directInit;

    const viaSuffixFile = params.suffixIndex.get(candFile);
    if (typeof viaSuffixFile === 'string') return viaSuffixFile;
    const viaSuffixInit = params.suffixIndex.get(candInit);
    if (typeof viaSuffixInit === 'string') return viaSuffixInit;

    return null;
  };

  const resolveJavaLocalImportKey = (params: {
    specifier: string;
    suffixIndex: Map<string, string | null>;
    keyByRelPath: Map<string, string>;
  }): string | null => {
    const cleaned = params.specifier.split(/[?#]/, 1)[0] ?? '';
    if (!cleaned || cleaned.endsWith('.*')) return null;

    const cand = `${cleaned.replace(/\./g, '/')}.java`;
    const direct = params.keyByRelPath.get(cand);
    if (direct) return direct;

    const viaSuffix = params.suffixIndex.get(cand);
    if (typeof viaSuffix === 'string') return viaSuffix;

    return null;
  };

  const findGoModuleForFile = (
    fileRelPath: string,
    modules: Array<{ moduleRootDir: string; modulePath: string }>
  ): { moduleRootDir: string; modulePath: string } | null => {
    for (const m of modules) {
      if (!m.moduleRootDir) return m;
      if (fileRelPath.startsWith(`${m.moduleRootDir}/`)) return m;
    }
    return null;
  };

  const isGoModuleLocalImport = (file: IngestedFile, specifier: string): boolean => {
    const idx = repoIndexes.get(file.repoId);
    if (!idx) return false;

    const mod = findGoModuleForFile(file.repoRelativePath, idx.goModules);
    if (!mod) return false;

    const cleaned = specifier.split(/[?#]/, 1)[0]?.trim() ?? '';
    return cleaned === mod.modulePath || cleaned.startsWith(`${mod.modulePath}/`);
  };

  const resolveGoLocalImportKey = (params: {
    importerRelPath: string;
    specifier: string;
    idx: RepoIndexes;
  }): string | null => {
    const cleaned = params.specifier.split(/[?#]/, 1)[0]?.trim() ?? '';
    if (!cleaned) return null;

    const mod = findGoModuleForFile(params.importerRelPath, params.idx.goModules);
    if (!mod) return null;

    if (cleaned !== mod.modulePath && !cleaned.startsWith(`${mod.modulePath}/`)) return null;

    const sub = cleaned === mod.modulePath ? '' : cleaned.slice(mod.modulePath.length + 1);
    const targetDir = normalizeDir(path.posix.join(mod.moduleRootDir, sub));

    return params.idx.goRepByDir.get(targetDir) ?? null;
  };

  const findRustCrateRootDir = (fileRelPath: string, crateRootDirs: string[]): string | null => {
    for (const dir of crateRootDirs) {
      if (!dir) return '';
      if (fileRelPath.startsWith(`${dir}/`)) return dir;
    }
    return null;
  };

  const moduleDirForRustFile = (fileRelPath: string, crateRootFiles: Set<string>): string => {
    const dir = normalizeDir(path.posix.dirname(fileRelPath));

    if (crateRootFiles.has(fileRelPath)) return dir;

    const base = path.posix.basename(fileRelPath);
    if (base === 'mod.rs') return dir;

    const stem = path.posix.basename(fileRelPath, '.rs');
    return normalizeDir(path.posix.join(dir, stem));
  };

  const resolveRustLocalImportKey = (params: {
    importerRelPath: string;
    specifier: string;
    idx: RepoIndexes;
  }): string | null => {
    let cleaned = (params.specifier.split(/[?#]/, 1)[0] ?? '').trim();
    cleaned = cleaned.replace(/;$/, '');
    cleaned = cleaned.replace(/^::+/, '');
    if (!cleaned) return null;

    const rawSegs = cleaned.split('::').filter(Boolean);
    const segs: string[] = [];
    for (const seg of rawSegs) {
      const m = seg.match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!m?.[0]) break;
      segs.push(m[0]);
    }

    if (segs.length === 0) return null;

    let baseDir: string;
    let i = 0;

    if (segs[0] === 'crate') {
      const crateRoot = findRustCrateRootDir(params.importerRelPath, params.idx.rustCrateRootDirs);
      if (crateRoot === null) return null;
      baseDir = crateRoot;
      i = 1;
    } else if (segs[0] === 'self') {
      baseDir = moduleDirForRustFile(params.importerRelPath, params.idx.rustCrateRootFiles);
      i = 1;
    } else if (segs[0] === 'super') {
      baseDir = moduleDirForRustFile(params.importerRelPath, params.idx.rustCrateRootFiles);
      while (i < segs.length && segs[i] === 'super') {
        baseDir = normalizeDir(path.posix.dirname(baseDir));
        i++;
      }
    } else {
      return null;
    }

    if (i >= segs.length) return null;

    let curDir = baseDir;
    let lastResolvedRelPath: string | null = null;

    for (let j = i; j < segs.length; j++) {
      const name = segs[j]!;
      const cand1 = path.posix.join(curDir, `${name}.rs`);
      if (params.idx.keyByRelPath.has(cand1)) {
        lastResolvedRelPath = cand1;
        curDir = moduleDirForRustFile(cand1, params.idx.rustCrateRootFiles);
        continue;
      }

      const cand2 = path.posix.join(curDir, name, 'mod.rs');
      if (params.idx.keyByRelPath.has(cand2)) {
        lastResolvedRelPath = cand2;
        curDir = moduleDirForRustFile(cand2, params.idx.rustCrateRootFiles);
        continue;
      }

      break;
    }

    if (!lastResolvedRelPath) return null;
    return params.idx.keyByRelPath.get(lastResolvedRelPath) ?? null;
  };

  const resolveLocalImportKey = (file: IngestedFile, specifier: string): string | null => {
    const idx = repoIndexes.get(file.repoId);
    if (!idx) return null;

    const ext = path.extname(file.repoRelativePath).toLowerCase();
    if (isJsLike(ext)) {
      const rel = resolveJsLocalImportRelPath({
        importerRelPath: file.repoRelativePath,
        specifier,
        keyByRelPath: idx.keyByRelPath,
      });
      if (!rel) return null;
      return idx.keyByRelPath.get(rel) ?? null;
    }

    if (ext === '.py') {
      return resolvePythonLocalImportKey({
        importerRelPath: file.repoRelativePath,
        specifier,
        suffixIndex: idx.suffixIndex,
        keyByRelPath: idx.keyByRelPath,
      });
    }

    if (ext === '.java') {
      return resolveJavaLocalImportKey({
        specifier,
        suffixIndex: idx.suffixIndex,
        keyByRelPath: idx.keyByRelPath,
      });
    }

    if (ext === '.go') {
      return resolveGoLocalImportKey({ importerRelPath: file.repoRelativePath, specifier, idx });
    }

    if (ext === '.rs') {
      return resolveRustLocalImportKey({ importerRelPath: file.repoRelativePath, specifier, idx });
    }

    return null;
  };

  const isExternalImportForStandalone = (file: IngestedFile, specifier: string): boolean => {
    const ext = path.extname(file.repoRelativePath).toLowerCase();
    const cleaned = specifier.split(/[?#]/, 1)[0] ?? '';

    // If we can confidently resolve it to a repo file, it's internal.
    if (resolveLocalImportKey(file, cleaned)) return false;

    // Otherwise, fall back to language syntax heuristics.
    if (isJsLike(ext)) {
      return !(cleaned.startsWith('.') || cleaned.startsWith('/'));
    }

    if (ext === '.go') {
      // In-module Go imports are internal even though they are not relative paths.
      if (isGoModuleLocalImport(file, cleaned)) return false;
    }

    if (ext === '.rs') {
      // Rust intra-crate paths.
      if (
        cleaned.startsWith('crate::') ||
        cleaned.startsWith('self::') ||
        cleaned.startsWith('super::') ||
        cleaned.startsWith('::crate::') ||
        cleaned.startsWith('::self::') ||
        cleaned.startsWith('::super::')
      ) {
        return false;
      }
    }

    // For other languages, only treat explicit relative paths as internal.
    if (cleaned.startsWith('.') || cleaned.startsWith('/')) return false;

    return true;
  };

  const importGraph = new Map<string, Set<string>>(); // fileKey -> imported fileKeys
  const reverseImportGraph = new Map<string, Set<string>>(); // fileKey -> fileKeys that import it

  // First pass: extract exports and imports
  const fileData = new Map<string, FileData>(); // fileKey -> data

  for (const file of files) {
    if (file.kind !== 'code') continue;

    const ext = path.extname(file.repoRelativePath).toLowerCase();
    if (!eligibleExtensions.has(ext)) continue;

    const key = fileKey(file);

    try {
      const raw = await fs.readFile(file.bundleNormAbsPath, 'utf8');
      const content = raw.replace(/\r\n/g, '\n');

      let exports: string[] = [];
      let imports: string[] = [];

      try {
        const parsed = await extractModuleSyntaxWasm(file.repoRelativePath, content);
        if (parsed) {
          exports = Array.from(new Set(parsed.exports)).sort();
          imports = Array.from(new Set(parsed.imports.map((i) => i.module))).sort();
        } else {
          exports = extractExports(content, file.repoRelativePath).sort();
          imports = extractImports(content, file.repoRelativePath).sort();
        }
      } catch {
        // Keep Phase2 analysis robust: fall back to regex if parsing fails.
        exports = extractExports(content, file.repoRelativePath).sort();
        imports = extractImports(content, file.repoRelativePath).sort();
      }

      const loc = content
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('//')).length;

      fileData.set(key, { exports, imports, content, loc });

      // Build local-import graph (resolved to known repo files)
      const localImportKeys = new Set<string>();
      for (const imp of imports) {
        const targetKey = resolveLocalImportKey(file, imp);
        if (targetKey) localImportKeys.add(targetKey);
      }
      importGraph.set(key, localImportKeys);
    } catch {
      // Skip files that can't be read
    }
  }

  // Build reverse import graph
  for (const [fromKey, toKeys] of importGraph.entries()) {
    for (const toKey of toKeys) {
      if (!reverseImportGraph.has(toKey)) {
        reverseImportGraph.set(toKey, new Set());
      }
      reverseImportGraph.get(toKey)!.add(fromKey);
    }
  }

  // Second pass: create ModuleInfo
  for (const file of files) {
    if (file.kind !== 'code') continue;

    const ext = path.extname(file.repoRelativePath).toLowerCase();
    if (!eligibleExtensions.has(ext)) continue;

    const key = fileKey(file);
    const data = fileData.get(key);
    if (!data) continue;

    const importedBy = reverseImportGraph.get(key) || new Set<string>();
    const role = determineModuleRole(file, importedBy);
    const complexity = calculateComplexity(data.loc, data.imports.length);
    const externalImportCount = data.imports.filter((imp) => isExternalImportForStandalone(file, imp)).length;
    const standalone = externalImportCount <= 3; // Few external deps

    modules.push({
      path: file.bundleNormRelativePath,
      exports: data.exports,
      imports: data.imports,
      role,
      standalone,
      complexity,
      loc: data.loc,
    });
  }

  return modules;
}

/**
 * Phase 2: Detect architecture patterns
 */
function detectArchitecturePatterns(
  files: IngestedFile[],
  modules: ModuleInfo[]
): string[] {
  const patterns: string[] = [];
  const paths = files.map(f => f.repoRelativePath.toLowerCase());
  const pathSet = new Set(paths);

  // MVC pattern
  if (
    paths.some(p => p.includes('/model')) &&
    paths.some(p => p.includes('/view')) &&
    paths.some(p => p.includes('/controller'))
  ) {
    patterns.push('MVC');
  }

  // Plugin architecture
  if (paths.some(p => p.includes('/plugin')) || paths.some(p => p.includes('/extension'))) {
    patterns.push('Plugin Architecture');
  }

  // Event-driven
  const hasEvents = modules.some(m => 
    m.exports.some(e => e.toLowerCase().includes('event') || e.toLowerCase().includes('emitter'))
  );
  if (hasEvents) {
    patterns.push('Event-Driven');
  }

  // Monorepo
  if (pathSet.has('packages') || pathSet.has('apps') || paths.filter(p => p === 'package.json').length > 1) {
    patterns.push('Monorepo');
  }

  // Layered architecture
  if (
    paths.some(p => p.includes('/service')) &&
    paths.some(p => p.includes('/repository')) ||
    paths.some(p => p.includes('/dao'))
  ) {
    patterns.push('Layered Architecture');
  }

  // Microservices indicators
  if (pathSet.has('docker-compose.yml') || paths.filter(p => p.includes('/service/')).length > 3) {
    patterns.push('Microservices');
  }

  // CLI
  if (paths.some(p => p.includes('/cli/') || p.includes('/command'))) {
    patterns.push('CLI');
  }

  return patterns;
}

/**
 * Phase 2: Analyze technology stack
 */
function analyzeTechStack(
  languages: LanguageStats[],
  dependencies: DependencyInfo,
  frameworks: string[]
): TechStackInfo {
  const primaryLang = languages[0]?.language || 'Unknown';
  
  let runtime: string | undefined;
  let packageManager: string | undefined;
  const buildTools: string[] = [];
  const testFrameworks: string[] = [];

  // Detect runtime
  if (primaryLang === 'TypeScript' || primaryLang === 'JavaScript') {
    runtime = 'Node.js';
  } else if (primaryLang === 'Python') {
    runtime = 'Python';
  } else if (primaryLang === 'Go') {
    runtime = 'Go';
  }

  // Package manager
  packageManager = dependencies.manager !== 'unknown' ? dependencies.manager : undefined;

  // Build tools
  const allDeps = [...dependencies.runtime, ...dependencies.dev].map(d => d.name.toLowerCase());
  if (primaryLang === 'TypeScript') buildTools.push('TypeScript');
  if (allDeps.includes('webpack')) buildTools.push('Webpack');
  if (allDeps.includes('vite')) buildTools.push('Vite');
  if (allDeps.includes('rollup')) buildTools.push('Rollup');
  if (allDeps.includes('esbuild')) buildTools.push('esbuild');
  if (allDeps.includes('babel')) buildTools.push('Babel');

  // Test frameworks
  if (allDeps.includes('jest')) testFrameworks.push('Jest');
  if (allDeps.includes('vitest')) testFrameworks.push('Vitest');
  if (allDeps.includes('mocha')) testFrameworks.push('Mocha');
  if (allDeps.includes('pytest')) testFrameworks.push('Pytest');
  if (allDeps.includes('unittest')) testFrameworks.push('unittest');

  return {
    language: primaryLang,
    runtime,
    packageManager,
    buildTools: buildTools.length > 0 ? buildTools : undefined,
    testFrameworks: testFrameworks.length > 0 ? testFrameworks : undefined,
  };
}
