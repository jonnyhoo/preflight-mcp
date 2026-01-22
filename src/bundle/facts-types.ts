/**
 * Bundle Facts Type Definitions
 *
 * Types for bundle metadata extraction and analysis.
 *
 * @module bundle/facts-types
 */

import type {
  ExtensionPointInfo,
  TypeSemantics,
  UnifiedAnalysisResult,
} from '../analysis/index.js';
import type { ArchitectureSummary } from '../analysis/architecture-summary.js';

// ============================================================================
// Core Types
// ============================================================================

export type BundleFacts = {
  version: string;
  timestamp: string;
  projectType?: 'code' | 'documentation' | 'mixed';
  languages: LanguageStats[];
  docTypes?: Array<{ docType: string; fileCount: number; extensions: string[] }>;
  entryPoints: EntryPoint[];
  dependencies: DependencyInfo;
  fileStructure: FileStructureInfo;
  frameworks: string[];
  features?: FeatureInfo[]; // Extracted from skills/, commands/, plugins/ directories
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

// ============================================================================
// Phase 2: Module Analysis Types
// ============================================================================

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
 * Feature/skill information extracted from well-known directories
 */
export type FeatureInfo = {
  name: string; // Feature/skill name (directory name)
  desc?: string; // Short description extracted from SKILL.md, README.md, etc.
};
