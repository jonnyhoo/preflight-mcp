/**
 * Architectural Pattern Detection - Type Definitions
 *
 * Defines types for high-level architectural pattern detection.
 * Detects patterns like MVC, MVVM, Repository, Service Layer, Layered, and Clean Architecture.
 *
 * @module bundle/analyzers/architectural/types
 */

import type { AnalyzerOptions } from '../types.js';

// ============================================================================
// Enums
// ============================================================================

/**
 * Supported architectural pattern types.
 */
export type ArchitecturalPatternType =
  | 'MVC'
  | 'MVVM'
  | 'MVP'
  | 'Repository'
  | 'ServiceLayer'
  | 'LayeredArchitecture'
  | 'CleanArchitecture'
  | 'Hexagonal';

/**
 * Framework detection types.
 */
export type FrameworkType =
  | 'Django'
  | 'Flask'
  | 'Spring'
  | 'ASP.NET'
  | 'Rails'
  | 'Angular'
  | 'React'
  | 'Vue.js'
  | 'Express'
  | 'Laravel'
  | 'NestJS'
  | 'FastAPI'
  | 'Next.js'
  | 'Unknown';

// ============================================================================
// Pattern Evidence Types
// ============================================================================

/**
 * Evidence supporting architectural pattern detection.
 */
export type ArchitecturalEvidence = {
  /** Type of evidence */
  type: 'directory' | 'file' | 'naming' | 'framework' | 'structural';
  /** Human-readable description */
  description: string;
  /** Confidence contribution (0.0-1.0) */
  confidence: number;
};

// ============================================================================
// Pattern Instance Types
// ============================================================================

/**
 * Component mapping for detected patterns.
 * Maps component type (e.g., 'Models', 'Views') to file paths.
 */
export type ComponentMap = {
  [componentType: string]: string[];
};

/**
 * Single detected architectural pattern.
 */
export type ArchitecturalPattern = {
  /** Pattern type */
  patternType: ArchitecturalPatternType;
  /** Detection confidence (0.0-1.0) */
  confidence: number;
  /** Evidence supporting detection */
  evidence: ArchitecturalEvidence[];
  /** Component type to file paths mapping */
  components: ComponentMap;
  /** Detected framework (if applicable) */
  framework?: FrameworkType;
  /** Human-readable description */
  description: string;
};

/**
 * Directory structure analysis result.
 * Maps directory name (lowercase) to file count.
 */
export type DirectoryStructure = {
  [dirName: string]: number;
};

/**
 * Complete architectural analysis report.
 */
export type ArchitecturalReport = {
  /** Detected architectural patterns */
  patterns: ArchitecturalPattern[];
  /** Directory structure analysis */
  directoryStructure: DirectoryStructure;
  /** Total files analyzed */
  totalFilesAnalyzed: number;
  /** Detected frameworks */
  frameworksDetected: FrameworkType[];
  /** Primary architecture (highest confidence pattern) */
  primaryArchitecture?: ArchitecturalPatternType;
};

// ============================================================================
// Analyzer Options
// ============================================================================

/**
 * Architectural Pattern Analyzer specific options.
 */
export type ArchitecturalAnalyzerOptions = AnalyzerOptions & {
  /** Minimum confidence threshold (0.0-1.0) */
  minConfidence: number;
  /** Pattern types to detect (empty = all) */
  patternTypes: ArchitecturalPatternType[];
  /** Whether to include evidence in output */
  includeEvidence: boolean;
  /** Whether to detect frameworks */
  detectFrameworks: boolean;
};

/**
 * Default options for Architectural Pattern Analyzer.
 */
export const DEFAULT_ARCHITECTURAL_OPTIONS: Required<ArchitecturalAnalyzerOptions> = {
  enabled: true,
  timeout: 30000,
  maxFiles: 0,
  includePatterns: [],
  excludePatterns: ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/build/**'],
  minConfidence: 0.5,
  patternTypes: [], // Empty = detect all
  includeEvidence: true,
  detectFrameworks: true,
};

// ============================================================================
// Analyzer Output
// ============================================================================

/**
 * Architectural Pattern Analyzer output data.
 */
export type ArchitecturalOutput = ArchitecturalReport;

// ============================================================================
// Detector Interface
// ============================================================================

/**
 * Context for architectural pattern detection.
 */
export type ArchitecturalDetectionContext = {
  /** Directory structure (dir name -> file count) */
  directoryStructure: DirectoryStructure;
  /** All file paths (relative) */
  filePaths: string[];
  /** Detected frameworks */
  frameworks: FrameworkType[];
};

/**
 * Interface for individual architectural pattern detectors.
 */
export type ArchitecturalPatternDetector = {
  /** Pattern type this detector handles */
  readonly patternType: ArchitecturalPatternType;

  /**
   * Detect pattern in the given context.
   *
   * @param context - Detection context
   * @returns Pattern instance if detected, null otherwise
   */
  detect(context: ArchitecturalDetectionContext): ArchitecturalPattern | null;
};

// ============================================================================
// Constants
// ============================================================================

/**
 * Common directory patterns for MVC architecture.
 */
export const MVC_DIRECTORIES = new Set([
  'models',
  'views',
  'controllers',
  'model',
  'view',
  'controller',
]);

/**
 * Common directory patterns for MVVM architecture.
 */
export const MVVM_DIRECTORIES = new Set([
  'models',
  'views',
  'viewmodels',
  'viewmodel',
  'view-models',
]);

/**
 * Common directory patterns for Layered Architecture.
 */
export const LAYERED_DIRECTORIES = new Set([
  'presentation',
  'business',
  'data',
  'dal',
  'bll',
  'ui',
  'api',
  'web',
]);

/**
 * Common directory patterns for Clean Architecture.
 */
export const CLEAN_ARCH_DIRECTORIES = new Set([
  'domain',
  'application',
  'infrastructure',
  'presentation',
  'core',
  'usecases',
  'use-cases',
  'entities',
]);

/**
 * Common directory patterns for Repository pattern.
 */
export const REPOSITORY_DIRECTORIES = new Set(['repositories', 'repository', 'repos']);

/**
 * Common directory patterns for Service Layer pattern.
 */
export const SERVICE_DIRECTORIES = new Set(['services', 'service', 'svc']);

/**
 * Framework detection markers.
 */
export const FRAMEWORK_MARKERS: Record<FrameworkType, string[]> = {
  Django: ['django', 'manage.py', 'settings.py', 'urls.py', 'wsgi.py', 'asgi.py'],
  Flask: ['flask', 'app.py', 'wsgi.py', '__init__.py'],
  Spring: ['springframework', '@controller', '@service', '@repository', 'pom.xml', 'application.properties'],
  'ASP.NET': ['controllers', 'models', 'views', '.cshtml', 'startup.cs', 'program.cs', '.csproj'],
  Rails: ['app/models', 'app/views', 'app/controllers', 'config/routes.rb', 'gemfile'],
  Angular: ['app.module.ts', '@component', '@injectable', 'angular.json', '.component.ts'],
  React: ['package.json', 'react', 'jsx', 'tsx', '.component.jsx', '.component.tsx'],
  'Vue.js': ['vue', '.vue', 'nuxt.config', 'vue.config'],
  Express: ['express', 'app.js', 'routes', 'middleware'],
  Laravel: ['artisan', 'app/http/controllers', 'app/models', 'composer.json'],
  NestJS: ['@nestjs', '@module', '@controller', 'nest-cli.json', '.module.ts'],
  FastAPI: ['fastapi', 'uvicorn', '@app.get', '@app.post'],
  'Next.js': ['next.config', 'pages', '_app.tsx', '_document.tsx', 'next-env.d.ts'],
  Unknown: [],
};
