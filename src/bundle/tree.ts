import fs from 'node:fs/promises';
import path from 'node:path';

export type TreeNode = {
  name: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
  size?: number;
};

export type TreeStats = {
  totalFiles: number;
  totalDirs: number;
  byExtension: Record<string, number>;
  byTopDir: Record<string, number>;
  /** File count per directory (when showFileCountPerDir=true) */
  byDir?: Record<string, number>;
};

export type EntryPointCandidate = {
  path: string;
  type: 'readme' | 'main' | 'index' | 'cli' | 'server' | 'app' | 'test' | 'config';
  priority: number;
};

export type RepoTreeResult = {
  bundleId: string;
  tree: string;
  stats: TreeStats;
  entryPointCandidates: EntryPointCandidate[];
  /** Info about auto-focus behavior for single-repo bundles */
  autoFocused?: { enabled: boolean; path?: string };
};

const ENTRY_POINT_PATTERNS: Array<{ pattern: RegExp; type: EntryPointCandidate['type']; priority: number }> = [
  { pattern: /^readme\.md$/i, type: 'readme', priority: 100 },
  { pattern: /^readme$/i, type: 'readme', priority: 95 },
  { pattern: /^index\.(ts|js|tsx|jsx|py|go|rs)$/i, type: 'index', priority: 90 },
  { pattern: /^main\.(ts|js|tsx|jsx|py|go|rs)$/i, type: 'main', priority: 85 },
  { pattern: /^app\.(ts|js|tsx|jsx|py)$/i, type: 'app', priority: 80 },
  { pattern: /^server\.(ts|js|tsx|jsx|py|go)$/i, type: 'server', priority: 75 },
  { pattern: /^cli\.(ts|js|py)$/i, type: 'cli', priority: 70 },
  { pattern: /^__init__\.py$/i, type: 'index', priority: 60 },
  { pattern: /^mod\.rs$/i, type: 'index', priority: 60 },
  { pattern: /^lib\.rs$/i, type: 'main', priority: 85 },
  { pattern: /^package\.json$/i, type: 'config', priority: 50 },
  { pattern: /^pyproject\.toml$/i, type: 'config', priority: 50 },
  { pattern: /^cargo\.toml$/i, type: 'config', priority: 50 },
  { pattern: /^go\.mod$/i, type: 'config', priority: 50 },
  { pattern: /\.test\.(ts|js|tsx|jsx)$/i, type: 'test', priority: 30 },
  { pattern: /_test\.(py|go)$/i, type: 'test', priority: 30 },
  { pattern: /^test_.*\.py$/i, type: 'test', priority: 30 },
];

function matchesGlob(filename: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  
  for (const pattern of patterns) {
    // Simple glob matching: * matches any sequence, ** matches any path
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    if (regex.test(filename)) return true;
  }
  return false;
}

function shouldExclude(relativePath: string, excludePatterns: string[]): boolean {
  if (excludePatterns.length === 0) return false;
  
  for (const pattern of excludePatterns) {
    // Simple exclusion matching
    if (relativePath.includes(pattern)) return true;
    if (pattern.startsWith('*') && relativePath.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

/**
 * Detect if bundle contains a single repository and return its norm path.
 * Returns null if multiple repos or structure is non-standard.
 */
async function detectSingleRepoNormPath(reposDir: string): Promise<string | null> {
  try {
    // repos/{source}/{repo}/norm structure
    const sources = await fs.readdir(reposDir, { withFileTypes: true });
    const sourceDirs = sources.filter(d => d.isDirectory() && !d.name.startsWith('.'));
    
    if (sourceDirs.length !== 1) return null;
    
    const sourceDir = path.join(reposDir, sourceDirs[0]!.name);
    const repos = await fs.readdir(sourceDir, { withFileTypes: true });
    const repoDirs = repos.filter(d => d.isDirectory() && !d.name.startsWith('.'));
    
    if (repoDirs.length !== 1) return null;
    
    const normPath = path.join(sourceDir, repoDirs[0]!.name, 'norm');
    try {
      await fs.access(normPath);
      return normPath;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export async function generateRepoTree(
  bundleRootDir: string,
  bundleId: string,
  options: {
    depth?: number;
    include?: string[];
    exclude?: string[];
    /** Focus directory - expand deeper within this path */
    focusDir?: string;
    /** Extra depth to apply within focusDir */
    focusDepthBonus?: number;
    /** Track file count per directory */
    showFileCountPerDir?: boolean;
    /** Auto-focus to norm/ for single-repo bundles (default: true) */
    autoFocusSingleRepo?: boolean;
  } = {}
): Promise<RepoTreeResult & { autoFocused?: { enabled: boolean; path?: string } }> {
  const depth = options.depth ?? 6;
  const includePatterns = options.include ?? [];
  const excludePatterns = options.exclude ?? ['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '*.pyc'];
  const focusDir = options.focusDir?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const focusDepthBonus = options.focusDepthBonus ?? 3;
  const showFileCountPerDir = options.showFileCountPerDir ?? false;
  const autoFocusSingleRepo = options.autoFocusSingleRepo ?? true;

  const reposDir = path.join(bundleRootDir, 'repos');
  
  // Auto-focus detection for single-repo bundles
  let effectiveStartDir = reposDir;
  let autoFocusInfo: { enabled: boolean; path?: string } = { enabled: false };
  
  if (autoFocusSingleRepo && !focusDir) {
    const singleRepoNormPath = await detectSingleRepoNormPath(reposDir);
    if (singleRepoNormPath) {
      effectiveStartDir = singleRepoNormPath;
      // Calculate relative path from reposDir for display
      const relativePath = path.relative(reposDir, singleRepoNormPath).replace(/\\/g, '/');
      autoFocusInfo = { enabled: true, path: relativePath };
    }
  }
  
  const stats: TreeStats = {
    totalFiles: 0,
    totalDirs: 0,
    byExtension: {},
    byTopDir: {},
  };
  
  // Track per-directory file counts if requested
  const dirFileCounts: Record<string, number> = {};

  const entryPointCandidates: EntryPointCandidate[] = [];

  // Check if path is within focus directory
  function isInFocusDir(relPath: string): boolean {
    if (!focusDir) return false;
    return relPath === focusDir || relPath.startsWith(focusDir + '/');
  }

  // Get effective depth limit for a path
  function getEffectiveDepth(relPath: string): number {
    if (focusDir && isInFocusDir(relPath)) {
      return depth + focusDepthBonus;
    }
    return depth;
  }

  // Build tree recursively
  async function buildTree(dir: string, currentDepth: number, relativePath: string): Promise<TreeNode | null> {
    const effectiveDepth = getEffectiveDepth(relativePath);
    if (currentDepth > effectiveDepth) return null;

    try {
      const stat = await fs.stat(dir);
      const name = path.basename(dir);

      if (stat.isFile()) {
        // Check include/exclude patterns
        if (includePatterns.length > 0 && !matchesGlob(name, includePatterns)) {
          return null;
        }
        if (shouldExclude(relativePath, excludePatterns)) {
          return null;
        }

        stats.totalFiles++;
        
        // Track extension stats
        const ext = path.extname(name).toLowerCase() || '(no ext)';
        stats.byExtension[ext] = (stats.byExtension[ext] ?? 0) + 1;

        // Track top directory stats
        const topDir = relativePath.split('/')[0] ?? '(root)';
        stats.byTopDir[topDir] = (stats.byTopDir[topDir] ?? 0) + 1;
        
        // Track per-directory file counts
        if (showFileCountPerDir) {
          const parentDir = relativePath.includes('/') 
            ? relativePath.substring(0, relativePath.lastIndexOf('/')) 
            : '(root)';
          dirFileCounts[parentDir] = (dirFileCounts[parentDir] ?? 0) + 1;
        }

        // Check for entry point candidates
        for (const ep of ENTRY_POINT_PATTERNS) {
          if (ep.pattern.test(name)) {
            entryPointCandidates.push({
              path: relativePath,
              type: ep.type,
              priority: ep.priority,
            });
            break;
          }
        }

        return { name, type: 'file', size: stat.size };
      }

      if (stat.isDirectory()) {
        // Check exclude patterns for directories
        if (shouldExclude(name, excludePatterns) || shouldExclude(relativePath, excludePatterns)) {
          return null;
        }

        stats.totalDirs++;

        const entries = await fs.readdir(dir, { withFileTypes: true });
        const children: TreeNode[] = [];

        // Sort: directories first, then files, alphabetically
        const sortedEntries = entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const entry of sortedEntries) {
          const childPath = path.join(dir, entry.name);
          const childRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
          const childNode = await buildTree(childPath, currentDepth + 1, childRelPath);
          if (childNode) {
            children.push(childNode);
          }
        }

        return { name, type: 'dir', children: children.length > 0 ? children : undefined };
      }

      return null;
    } catch {
      return null;
    }
  }

  // Build tree starting from repos directory (or auto-focused path)
  let rootNode: TreeNode | null = null;
  try {
    await fs.access(effectiveStartDir);
    rootNode = await buildTree(effectiveStartDir, 0, '');
  } catch {
    // Try repos dir, then bundle root as fallbacks
    try {
      await fs.access(reposDir);
      rootNode = await buildTree(reposDir, 0, '');
    } catch {
      rootNode = await buildTree(bundleRootDir, 0, '');
    }
  }

  // Generate ASCII tree
  function renderTree(node: TreeNode, prefix: string = '', isLast: boolean = true): string[] {
    const lines: string[] = [];
    const connector = isLast ? '└── ' : '├── ';
    const extension = isLast ? '    ' : '│   ';

    lines.push(`${prefix}${connector}${node.name}${node.type === 'dir' ? '/' : ''}`);

    if (node.children) {
      const childCount = node.children.length;
      node.children.forEach((child, index) => {
        const childLines = renderTree(child, prefix + extension, index === childCount - 1);
        lines.push(...childLines);
      });
    }

    return lines;
  }

  let treeText = '';
  if (rootNode) {
    if (rootNode.children && rootNode.children.length > 0) {
      treeText = `${rootNode.name}/\n`;
      rootNode.children.forEach((child, index) => {
        const childLines = renderTree(child, '', index === rootNode!.children!.length - 1);
        treeText += childLines.join('\n') + '\n';
      });
    } else {
      treeText = `${rootNode.name}/ (empty or filtered out)`;
    }
  } else {
    treeText = '(no files found)';
  }

  // Sort entry point candidates by priority
  entryPointCandidates.sort((a, b) => b.priority - a.priority);

  // Add per-directory counts if requested
  if (showFileCountPerDir) {
    stats.byDir = dirFileCounts;
  }

  return {
    bundleId,
    tree: treeText.trim(),
    stats,
    entryPointCandidates: entryPointCandidates.slice(0, 20), // Limit to top 20
    autoFocused: autoFocusInfo,
  };
}

/**
 * Format tree result as human-readable text
 */
export function formatTreeResult(result: RepoTreeResult): string {
  const lines: string[] = [];

  lines.push(`📂 Repository Structure for bundle: ${result.bundleId}`);
  
  // Show auto-focus info if enabled
  if (result.autoFocused?.enabled && result.autoFocused.path) {
    lines.push(`📍 Auto-focused to: \`${result.autoFocused.path}\` (single-repo bundle)`);
  }
  lines.push('');
  lines.push('## Directory Tree');
  lines.push('```');
  lines.push(result.tree);
  lines.push('```');
  lines.push('');
  lines.push('## Statistics');
  lines.push(`- Total files: ${result.stats.totalFiles}`);
  lines.push(`- Total directories: ${result.stats.totalDirs}`);
  lines.push('');

  // By extension (top 10)
  const extEntries = Object.entries(result.stats.byExtension)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (extEntries.length > 0) {
    lines.push('### Files by Extension');
    for (const [ext, count] of extEntries) {
      lines.push(`- ${ext}: ${count}`);
    }
    lines.push('');
  }

  // By top directory (top 10)
  const dirEntries = Object.entries(result.stats.byTopDir)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (dirEntries.length > 0) {
    lines.push('### Files by Top Directory');
    for (const [dir, count] of dirEntries) {
      lines.push(`- ${dir}: ${count}`);
    }
    lines.push('');
  }

  // Entry point candidates
  if (result.entryPointCandidates.length > 0) {
    lines.push('## Entry Point Candidates');
    for (const ep of result.entryPointCandidates.slice(0, 10)) {
      lines.push(`- \`${ep.path}\` (${ep.type})`);
    }
  }

  return lines.join('\n');
}
