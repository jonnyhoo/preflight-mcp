import path from 'node:path';
import { type IngestedFile } from './ingest.js';
import { extractBundleFacts, writeFacts, type BundleFacts } from './facts.js';
import { generateAndSaveAnalysis } from './llm-analysis.js';
import { type PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';

export type AnalysisMode = 'none' | 'quick' | 'deep';

export type AnalysisResult = {
  facts?: BundleFacts;
  summary?: string;
  error?: string;
};

/**
 * Run static analysis on a bundle
 */
export async function analyzeBundleStatic(params: {
  bundleId: string;
  bundleRoot: string;
  repos: Array<{ repoId: string; files: IngestedFile[] }>;
  mode: AnalysisMode;
  cfg?: PreflightConfig;
}): Promise<AnalysisResult> {
  if (params.mode === 'none') {
    return {};
  }

  try {
    // Phase 1: Extract static facts
    const facts = await extractBundleFacts({
      bundleRoot: params.bundleRoot,
      repos: params.repos,
    });

    // Write facts to disk
    const factsPath = path.join(params.bundleRoot, 'analysis', 'FACTS.json');
    await writeFacts(factsPath, facts);

    // Phase 2: Generate LLM analysis (only for 'deep' mode)
    if (params.mode === 'deep' && params.cfg) {
      try {
        await generateAndSaveAnalysis({
          cfg: params.cfg,
          bundleRoot: params.bundleRoot,
        });
      } catch (err) {
        logger.warn('LLM analysis failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

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

  return sections.join('\n') + '\n';
}
