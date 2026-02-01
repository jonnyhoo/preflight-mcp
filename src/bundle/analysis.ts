import path from 'node:path';
import { type IngestedFile } from './ingest.js';
import { extractBundleFacts, writeFacts, type BundleFacts } from './facts.js';
import { logger } from '../logging/logger.js';

export type AnalysisMode = 'none' | 'quick' | 'full';
// 'full' enables Phase 2 + Phase 3 (for TypeScript projects)

export type AnalysisResult = {
  facts?: BundleFacts;
  summary?: string;
  error?: string;
};

/** Supported extensions for semantic analysis (ts-morph) */
const SEMANTIC_ANALYSIS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs']);

/**
 * Check if project is a code project (has enough code files for semantic analysis).
 * Triggers if >30% of code files are in supported languages.
 */
function isCodeProject(files: IngestedFile[]): boolean {
  const codeFiles = files.filter((f) => f.kind === 'code');
  if (codeFiles.length === 0) return false;
  
  const supportedFiles = codeFiles.filter((f) => {
    const ext = path.extname(f.repoRelativePath).toLowerCase();
    return SEMANTIC_ANALYSIS_EXTENSIONS.has(ext);
  });
  
  return supportedFiles.length / codeFiles.length > 0.3;
}

/**
 * Run static analysis on a bundle
 * 
 * Modes:
 * - 'none': Skip all analysis
 * - 'quick': Phase 1 only (basic stats, fast)
 * - 'full': Phase 1 + Phase 2 + Phase 3 (complete analysis)
 *           Semantic analysis (ts-morph) only runs for code projects
 *           Framework detection runs for all projects
 */
export async function analyzeBundleStatic(params: {
  bundleId: string;
  bundleRoot: string;
  repos: Array<{ repoId: string; files: IngestedFile[] }>;
  mode: AnalysisMode;
}): Promise<AnalysisResult> {
  if (params.mode === 'none') {
    return {};
  }

  const allFiles = params.repos.flatMap((r) => r.files);
  const isFull = params.mode === 'full';
  const codeProjectDetected = isCodeProject(allFiles);
  
  // Semantic analysis (ts-morph) only for code projects
  const enableSemanticAnalysis = isFull && codeProjectDetected;
  // Framework detection for all projects
  const enableFrameworkDetection = isFull;
  
  if (enableSemanticAnalysis) {
    logger.info('Enabling semantic analysis (code project detected)');
  }

  try {
    const facts = await extractBundleFacts({
      bundleRoot: params.bundleRoot,
      repos: params.repos,
      enablePhase2: isFull,
      enableSemanticAnalysis,
      enableFrameworkDetection,
    });

    const factsPath = path.join(params.bundleRoot, 'analysis', 'FACTS.json');
    await writeFacts(factsPath, facts);

    return { facts };
  } catch (err) {
    logger.error('Analysis failed', err instanceof Error ? err : undefined);
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Generate a quick text summary from facts
 */
export function generateQuickSummary(facts: BundleFacts): string {
  const sections: string[] = [];

  sections.push('# Quick Analysis Summary\n');
  sections.push(`Generated: ${facts.timestamp}\n`);

  // Languages
  if (facts.languages.length > 0) {
    sections.push('## Languages');
    for (const lang of facts.languages) {
      sections.push(`- ${lang.language}: ${lang.fileCount} files (${lang.extensions.join(', ')})`);
    }
    sections.push('');
  }

  // Frameworks
  if (facts.frameworks.length > 0) {
    sections.push('## Detected Frameworks');
    sections.push(facts.frameworks.map((f) => `- ${f}`).join('\n'));
    sections.push('');
  }

  // Entry points
  if (facts.entryPoints.length > 0) {
    sections.push('## Entry Points');
    for (const ep of facts.entryPoints) {
      sections.push(`- [${ep.type}] ${ep.file}`);
      sections.push(`  Evidence: ${ep.evidence}`);
    }
    sections.push('');
  }

  // Dependencies
  if (facts.dependencies.runtime.length > 0 || facts.dependencies.dev.length > 0) {
    sections.push(`## Dependencies (${facts.dependencies.manager})`);
    if (facts.dependencies.runtime.length > 0) {
      sections.push(`### Runtime (${facts.dependencies.runtime.length})`);
      for (const dep of facts.dependencies.runtime.slice(0, 20)) {
        sections.push(`- ${dep.name}${dep.version ? ` ${dep.version}` : ''}`);
      }
      if (facts.dependencies.runtime.length > 20) {
        sections.push(`- ... and ${facts.dependencies.runtime.length - 20} more`);
      }
    }
    if (facts.dependencies.dev.length > 0) {
      sections.push(`### Development (${facts.dependencies.dev.length})`);
      for (const dep of facts.dependencies.dev.slice(0, 10)) {
        sections.push(`- ${dep.name}${dep.version ? ` ${dep.version}` : ''}`);
      }
      if (facts.dependencies.dev.length > 10) {
        sections.push(`- ... and ${facts.dependencies.dev.length - 10} more`);
      }
    }
    sections.push('');
  }

  // File structure
  sections.push('## File Structure');
  sections.push(`- Total files: ${facts.fileStructure.totalFiles}`);
  sections.push(`- Documentation: ${facts.fileStructure.totalDocs}`);
  sections.push(`- Code: ${facts.fileStructure.totalCode}`);
  sections.push(`- Has tests: ${facts.fileStructure.hasTests ? 'Yes' : 'No'}`);
  sections.push(`- Has config files: ${facts.fileStructure.hasConfig ? 'Yes' : 'No'}`);
  if (facts.fileStructure.topLevelDirs.length > 0) {
    sections.push(`- Top-level directories: ${facts.fileStructure.topLevelDirs.join(', ')}`);
  }
  sections.push('');

  // Phase 2: Modules (if available)
  if (facts.modules && facts.modules.length > 0) {
    sections.push('## Module Analysis');
    sections.push(`- Total modules: ${facts.modules.length}`);

    const roleCount = facts.modules.reduce((acc, m) => {
      acc[m.role] = (acc[m.role] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    sections.push(`- Core modules: ${roleCount['core'] || 0}`);
    sections.push(`- Utility modules: ${roleCount['utility'] || 0}`);
    sections.push(`- Test modules: ${roleCount['test'] || 0}`);
    sections.push(`- Config modules: ${roleCount['config'] || 0}`);

    const coreModules = facts.modules.filter(m => m.role === 'core').slice(0, 5);
    if (coreModules.length > 0) {
      sections.push('\n### Top Core Modules');
      for (const mod of coreModules) {
        sections.push(`- ${mod.path} (${mod.exports.length} exports, ${mod.loc} LOC)`);
      }
    }
    sections.push('');
  }

  // Phase 2: Architecture patterns (if available)
  if (facts.patterns && facts.patterns.length > 0) {
    sections.push('## Architecture Patterns');
    sections.push(facts.patterns.map(p => `- ${p}`).join('\n'));
    sections.push('');
  }

  // Phase 2: Tech stack (if available)
  if (facts.techStack) {
    sections.push('## Technology Stack');
    sections.push(`- Language: ${facts.techStack.language}`);
    if (facts.techStack.runtime) {
      sections.push(`- Runtime: ${facts.techStack.runtime}`);
    }
    if (facts.techStack.packageManager) {
      sections.push(`- Package Manager: ${facts.techStack.packageManager}`);
    }
    if (facts.techStack.buildTools) {
      sections.push(`- Build Tools: ${facts.techStack.buildTools.join(', ')}`);
    }
    if (facts.techStack.testFrameworks) {
      sections.push(`- Test Frameworks: ${facts.techStack.testFrameworks.join(', ')}`);
    }
    sections.push('');
  }

  // Phase 3: Extension Points (if available)
  if (facts.extensionSummary) {
    const summary = facts.extensionSummary;
    sections.push('## Extension Points Analysis');
    sections.push(`- Total extension points: ${summary.totalExtensionPoints}`);
    sections.push(`- Files analyzed: ${summary.filesAnalyzed}`);
    
    // By kind breakdown
    if (summary.byKind) {
      const kinds = Object.entries(summary.byKind)
        .filter(([_, count]) => count > 0)
        .map(([kind, count]) => `${kind}: ${count}`);
      if (kinds.length > 0) {
        sections.push(`- By type: ${kinds.join(', ')}`);
      }
    }
    
    // Top extension points (high extensibility score)
    if (summary.topExtensionPoints && summary.topExtensionPoints.length > 0) {
      sections.push('\n### Key Extension Points');
      for (const ep of summary.topExtensionPoints.slice(0, 8)) {
        sections.push(`- **${ep.name}** (score: ${ep.score}) - ${ep.file}`);
      }
    }
    sections.push('');
  }

  // Phase 3: Type Semantics (if available)
  if (facts.typeSemantics) {
    const ts = facts.typeSemantics;
    const hasContent = ts.unionTypes.length > 0 || ts.optionalCallbacks.length > 0 || ts.designHints.length > 0;
    
    if (hasContent) {
      sections.push('## Type Semantics');
      
      // Union types (format support indicators)
      if (ts.unionTypes.length > 0) {
        sections.push(`\n### Union Types (${ts.unionTypes.length})`);
        for (const ut of ts.unionTypes.slice(0, 5)) {
          const purpose = ut.inferredPurpose !== 'unknown' ? ` [${ut.inferredPurpose}]` : '';
          sections.push(`- **${ut.name}**${purpose}: ${ut.members.slice(0, 6).join(' | ')}${ut.members.length > 6 ? ' | ...' : ''}`);
        }
      }
      
      // Optional callbacks (injection points)
      if (ts.optionalCallbacks.length > 0) {
        sections.push(`\n### Optional Callbacks (${ts.optionalCallbacks.length})`);
        for (const cb of ts.optionalCallbacks.slice(0, 5)) {
          sections.push(`- **${cb.parent}.${cb.name}?**: ${cb.signature.slice(0, 60)}${cb.signature.length > 60 ? '...' : ''}`);
        }
      }
      
      // Design hints
      if (ts.designHints.length > 0) {
        sections.push(`\n### Design References (${ts.designHints.length})`);
        for (const hint of ts.designHints.filter(h => h.intent === 'reference').slice(0, 3)) {
          sections.push(`- ${hint.comment} (${hint.file}:${hint.line})`);
        }
      }
      
      sections.push('');
    }
  }

  // Phase 4: Architecture Summary (if available)
  if (facts.architectureSummary) {
    const arch = facts.architectureSummary;
    sections.push('## Architecture Overview');
    sections.push(`- Modules analyzed: ${arch.stats.totalModules}`);
    sections.push(`- Internal dependencies: ${arch.stats.totalInternalDeps}`);
    sections.push(`- External packages: ${arch.stats.totalExternalDeps}`);
    sections.push(`- Core types: ${arch.stats.totalCoreTypes}`);
    sections.push(`- Public APIs: ${arch.stats.totalPublicAPIs}`);
    
    // Hub modules (most connected)
    if (arch.moduleDependencies.hubModules.length > 0) {
      sections.push('\n### Hub Modules (High Connectivity)');
      for (const hub of arch.moduleDependencies.hubModules.slice(0, 5)) {
        sections.push(`- **${hub.module}** (in: ${hub.inDegree}, out: ${hub.outDegree})`);
      }
    }
    
    // Core types (most used)
    if (arch.coreTypes.length > 0) {
      sections.push('\n### Core Types (Most Referenced)');
      for (const t of arch.coreTypes.slice(0, 8)) {
        sections.push(`- **${t.name}** (${t.kind}) - ${t.file}:${t.line} [${t.usageCount} refs]`);
      }
    }
    
    // Interface implementations
    if (arch.implementations.length > 0) {
      const withImpls = arch.implementations.filter(i => i.implementations.length > 0);
      if (withImpls.length > 0) {
        sections.push('\n### Interface Implementations');
        for (const iface of withImpls.slice(0, 5)) {
          const implNames = iface.implementations.map(i => i.name).join(', ');
          sections.push(`- **${iface.interfaceName}** → ${implNames}`);
        }
      }
    }
    
    // Entry points
    if (arch.entryPoints.length > 0) {
      sections.push('\n### Entry Points');
      for (const ep of arch.entryPoints.slice(0, 5)) {
        sections.push(`- [${ep.kind}] ${ep.file}`);
      }
    }
    
    // External dependencies (top packages)
    if (arch.moduleDependencies.externalDeps.length > 0) {
      sections.push('\n### External Dependencies');
      sections.push(arch.moduleDependencies.externalDeps.slice(0, 15).join(', '));
      if (arch.moduleDependencies.externalDeps.length > 15) {
        sections.push(`... and ${arch.moduleDependencies.externalDeps.length - 15} more`);
      }
    }
    
    sections.push('');
  }

  // Documentation Categories (for documentation-type projects)
  if (facts.docCategories && facts.docCategories.length > 0) {
    sections.push('## Documentation Structure\n');
    
    const totalDocs = facts.docCategories.reduce((sum, cat) => sum + cat.fileCount, 0);
    sections.push(`Total documents: ${totalDocs} files in ${facts.docCategories.length} categories\n`);
    
    for (const category of facts.docCategories) {
      sections.push(`### ${category.name} (${category.fileCount} files)`);
      
      // Show top 5 documents per category with summaries
      const topDocs = category.files.slice(0, 5);
      for (const doc of topDocs) {
        const summary = doc.summary ? `: ${doc.summary}` : '';
        sections.push(`- **${doc.title}**${summary}`);
        sections.push(`  Path: ${doc.path}`);
      }
      
      // Show remaining count if more files exist
      if (category.fileCount > 5) {
        sections.push(`- ... and ${category.fileCount - 5} more files`);
      }
      sections.push('');
    }
  }

  return sections.join('\n') + '\n';
}
