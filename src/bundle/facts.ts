import fs from 'node:fs/promises';
import path from 'node:path';
import { type IngestedFile } from './ingest.js';

export type BundleFacts = {
  version: string;
  timestamp: string;
  languages: LanguageStats[];
  entryPoints: EntryPoint[];
  dependencies: DependencyInfo;
  fileStructure: FileStructureInfo;
  frameworks: string[];
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

  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    languages,
    entryPoints,
    dependencies,
    fileStructure,
    frameworks,
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
