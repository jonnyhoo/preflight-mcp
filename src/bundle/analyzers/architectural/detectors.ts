/**
 * Architectural Pattern Detectors
 *
 * Implements detectors for various high-level architectural patterns.
 * Each detector analyzes directory structure and file paths to identify patterns.
 *
 * @module bundle/analyzers/architectural/detectors
 */

import {
  type ArchitecturalPattern,
  type ArchitecturalEvidence,
  type ArchitecturalDetectionContext,
  type ArchitecturalPatternDetector,
  type ComponentMap,
  type FrameworkType,
  MVC_DIRECTORIES,
  MVVM_DIRECTORIES,
  LAYERED_DIRECTORIES,
  CLEAN_ARCH_DIRECTORIES,
  REPOSITORY_DIRECTORIES,
  SERVICE_DIRECTORIES,
} from './types.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Counts how many directories from a set exist in the structure.
 */
function countMatchingDirectories(
  structure: Record<string, number>,
  targetDirs: Set<string>
): number {
  return [...targetDirs].filter((d) => d in structure).length;
}

/**
 * Filters file paths by directory pattern.
 */
function filterFilesByDir(filePaths: string[], dirPattern: string): string[] {
  const pattern = dirPattern.toLowerCase();
  return filePaths.filter((fp) => {
    const lower = fp.toLowerCase();
    return lower.includes(`/${pattern}/`) || lower.includes(`\\${pattern}\\`) || lower.startsWith(`${pattern}/`);
  });
}

/**
 * Checks if file path matches any of the patterns.
 */
function fileMatchesPatterns(filePath: string, patterns: string[]): boolean {
  const lower = filePath.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

// ============================================================================
// MVC Pattern Detector
// ============================================================================

/**
 * Detects MVC (Model-View-Controller) architectural pattern.
 */
export class MVCDetector implements ArchitecturalPatternDetector {
  readonly patternType = 'MVC' as const;

  private static readonly MVC_FRAMEWORKS: FrameworkType[] = [
    'Django',
    'Flask',
    'Spring',
    'ASP.NET',
    'Rails',
    'Laravel',
    'Express',
  ];

  detect(context: ArchitecturalDetectionContext): ArchitecturalPattern | null {
    const { directoryStructure, filePaths, frameworks } = context;
    const evidence: ArchitecturalEvidence[] = [];
    const models: string[] = [];
    const views: string[] = [];
    const controllers: string[] = [];

    // Check directory structure for MVC directories
    const mvcDirMatches = countMatchingDirectories(directoryStructure, MVC_DIRECTORIES);
    if (mvcDirMatches < 2) {
      return null;
    }

    // Find files in each component directory
    for (const fp of filePaths) {
      const lower = fp.toLowerCase();

      // Models
      if (
        (lower.includes('/models/') || lower.includes('/model/') || lower.includes('\\models\\') || lower.includes('\\model\\')) &&
        !lower.includes('viewmodel')
      ) {
        models.push(fp);
      }

      // Views
      if (lower.includes('/views/') || lower.includes('/view/') || lower.includes('\\views\\') || lower.includes('\\view\\')) {
        views.push(fp);
      }

      // Controllers
      if (lower.includes('/controllers/') || lower.includes('/controller/') || lower.includes('\\controllers\\') || lower.includes('\\controller\\')) {
        controllers.push(fp);
      }
    }

    // Build evidence
    if (models.length > 0) {
      evidence.push({
        type: 'directory',
        description: `Models directory with ${models.length} model files`,
        confidence: 0.25,
      });
    }

    if (views.length > 0) {
      evidence.push({
        type: 'directory',
        description: `Views directory with ${views.length} view files`,
        confidence: 0.25,
      });
    }

    if (controllers.length > 0) {
      evidence.push({
        type: 'directory',
        description: `Controllers directory with ${controllers.length} controller files`,
        confidence: 0.25,
      });
    }

    // Calculate confidence
    const hasModels = models.length > 0;
    const hasViews = views.length > 0;
    const hasControllers = controllers.length > 0;
    const componentCount = [hasModels, hasViews, hasControllers].filter(Boolean).length;

    if (componentCount < 2) {
      return null;
    }

    let confidence = 0.5 + componentCount * 0.1;

    // Framework boost
    const matchedFramework = frameworks.find((fw) => MVCDetector.MVC_FRAMEWORKS.includes(fw));
    if (matchedFramework) {
      confidence = Math.min(0.95, confidence + 0.15);
      evidence.push({
        type: 'framework',
        description: `${matchedFramework} framework detected (uses MVC pattern)`,
        confidence: 0.15,
      });
    }

    return {
      patternType: 'MVC',
      confidence: Math.min(confidence, 0.95),
      evidence,
      components: { Models: models, Views: views, Controllers: controllers },
      framework: matchedFramework,
      description: 'Separates application into Models (data), Views (UI), and Controllers (logic)',
    };
  }
}

// ============================================================================
// MVVM Pattern Detector
// ============================================================================

/**
 * Detects MVVM (Model-View-ViewModel) architectural pattern.
 */
export class MVVMDetector implements ArchitecturalPatternDetector {
  readonly patternType = 'MVVM' as const;

  private static readonly MVVM_FRAMEWORKS: FrameworkType[] = ['Angular', 'Vue.js', 'ASP.NET'];

  detect(context: ArchitecturalDetectionContext): ArchitecturalPattern | null {
    const { directoryStructure, filePaths, frameworks } = context;
    const evidence: ArchitecturalEvidence[] = [];
    const models: string[] = [];
    const views: string[] = [];
    const viewModels: string[] = [];

    // Check for viewmodels directory or files with viewmodel in name
    const hasViewModelDir =
      'viewmodels' in directoryStructure ||
      'viewmodel' in directoryStructure ||
      'view-models' in directoryStructure;

    const viewModelFiles = filePaths.filter((fp) => fp.toLowerCase().includes('viewmodel'));

    if (!hasViewModelDir && viewModelFiles.length < 2) {
      return null;
    }

    // Find files in each component
    for (const fp of filePaths) {
      const lower = fp.toLowerCase();

      // ViewModels
      if (lower.includes('viewmodel') || lower.includes('view-model')) {
        viewModels.push(fp);
      }
      // Models (exclude viewmodels)
      else if ((lower.includes('/models/') || lower.includes('/model/')) && !lower.includes('viewmodel')) {
        models.push(fp);
      }
      // Views
      else if (lower.includes('/views/') || lower.includes('/view/')) {
        views.push(fp);
      }
    }

    // Build evidence
    if (viewModels.length >= 2) {
      evidence.push({
        type: 'directory',
        description: `ViewModels: ${viewModels.length} ViewModel classes detected`,
        confidence: 0.35,
      });
    }

    if (models.length > 0) {
      evidence.push({
        type: 'directory',
        description: `Models directory with ${models.length} model files`,
        confidence: 0.15,
      });
    }

    if (views.length > 0) {
      evidence.push({
        type: 'directory',
        description: `Views directory with ${views.length} view files`,
        confidence: 0.15,
      });
    }

    // Calculate confidence
    const hasModels = models.length > 0;
    const hasViews = views.length > 0;
    const hasViewModels = viewModels.length >= 2;

    if (!hasViewModels || (!hasModels && !hasViews)) {
      return null;
    }

    let confidence = 0.6;
    if (hasModels && hasViews && hasViewModels) {
      confidence = 0.75;
    }

    // Framework boost
    const matchedFramework = frameworks.find((fw) => MVVMDetector.MVVM_FRAMEWORKS.includes(fw));
    if (matchedFramework) {
      confidence = Math.min(0.95, confidence + 0.1);
      evidence.push({
        type: 'framework',
        description: `${matchedFramework} framework detected (supports MVVM pattern)`,
        confidence: 0.1,
      });
    }

    return {
      patternType: 'MVVM',
      confidence: Math.min(confidence, 0.95),
      evidence,
      components: { Models: models, Views: views, ViewModels: viewModels },
      framework: matchedFramework,
      description: 'ViewModels provide data-binding between Views and Models',
    };
  }
}

// ============================================================================
// Repository Pattern Detector
// ============================================================================

/**
 * Detects Repository Pattern.
 */
export class RepositoryDetector implements ArchitecturalPatternDetector {
  readonly patternType = 'Repository' as const;

  detect(context: ArchitecturalDetectionContext): ArchitecturalPattern | null {
    const { directoryStructure, filePaths } = context;
    const evidence: ArchitecturalEvidence[] = [];
    const components: ComponentMap = {
      Repositories: [],
    };

    // Check for repository directory
    const hasRepoDir = countMatchingDirectories(directoryStructure, REPOSITORY_DIRECTORIES) > 0;

    // Find repository files (by directory or naming convention)
    const repoFiles = filePaths.filter((fp) => {
      const lower = fp.toLowerCase();
      return (
        lower.includes('/repositories/') ||
        lower.includes('/repository/') ||
        lower.includes('\\repositories\\') ||
        lower.includes('\\repository\\') ||
        lower.includes('repository.') ||
        lower.endsWith('repository.ts') ||
        lower.endsWith('repository.js') ||
        lower.endsWith('repository.py') ||
        lower.endsWith('repository.java') ||
        lower.endsWith('repository.cs')
      );
    });

    if (!hasRepoDir && repoFiles.length < 2) {
      return null;
    }

    components.Repositories = repoFiles;

    if (repoFiles.length >= 2) {
      evidence.push({
        type: 'naming',
        description: `Repository pattern: ${repoFiles.length} repository classes detected`,
        confidence: 0.4,
      });

      evidence.push({
        type: 'structural',
        description: 'Repositories abstract data access logic from business logic',
        confidence: 0.2,
      });
    }

    if (hasRepoDir) {
      evidence.push({
        type: 'directory',
        description: 'Dedicated repositories directory found',
        confidence: 0.15,
      });
    }

    const confidence = Math.min(0.75, 0.5 + repoFiles.length * 0.05);

    return {
      patternType: 'Repository',
      confidence,
      evidence,
      components,
      description: 'Encapsulates data access logic in repository classes',
    };
  }
}

// ============================================================================
// Service Layer Pattern Detector
// ============================================================================

/**
 * Detects Service Layer Pattern.
 */
export class ServiceLayerDetector implements ArchitecturalPatternDetector {
  readonly patternType = 'ServiceLayer' as const;

  detect(context: ArchitecturalDetectionContext): ArchitecturalPattern | null {
    const { directoryStructure, filePaths } = context;
    const evidence: ArchitecturalEvidence[] = [];
    const components: ComponentMap = {
      Services: [],
    };

    // Check for service directory
    const hasServiceDir = countMatchingDirectories(directoryStructure, SERVICE_DIRECTORIES) > 0;

    // Find service files
    const serviceFiles = filePaths.filter((fp) => {
      const lower = fp.toLowerCase();
      return (
        lower.includes('/services/') ||
        lower.includes('/service/') ||
        lower.includes('\\services\\') ||
        lower.includes('\\service\\') ||
        lower.includes('service.') ||
        lower.endsWith('service.ts') ||
        lower.endsWith('service.js') ||
        lower.endsWith('service.py') ||
        lower.endsWith('service.java') ||
        lower.endsWith('service.cs')
      );
    });

    if (!hasServiceDir && serviceFiles.length < 3) {
      return null;
    }

    components.Services = serviceFiles;

    if (serviceFiles.length >= 3) {
      evidence.push({
        type: 'naming',
        description: `Service layer: ${serviceFiles.length} service classes detected`,
        confidence: 0.4,
      });

      evidence.push({
        type: 'structural',
        description: 'Services encapsulate business logic and orchestrate operations',
        confidence: 0.2,
      });
    }

    if (hasServiceDir) {
      evidence.push({
        type: 'directory',
        description: 'Dedicated services directory found',
        confidence: 0.15,
      });
    }

    const confidence = Math.min(0.8, 0.5 + serviceFiles.length * 0.04);

    return {
      patternType: 'ServiceLayer',
      confidence,
      evidence,
      components,
      description: 'Encapsulates business logic in service classes',
    };
  }
}

// ============================================================================
// Layered Architecture Detector
// ============================================================================

/**
 * Detects Layered Architecture (3-tier, N-tier).
 */
export class LayeredArchitectureDetector implements ArchitecturalPatternDetector {
  readonly patternType = 'LayeredArchitecture' as const;

  detect(context: ArchitecturalDetectionContext): ArchitecturalPattern | null {
    const { directoryStructure } = context;
    const evidence: ArchitecturalEvidence[] = [];
    const components: ComponentMap = {
      Layers: [],
    };

    const layeredMatches = countMatchingDirectories(directoryStructure, LAYERED_DIRECTORIES);

    if (layeredMatches < 2) {
      return null;
    }

    const layersFound: string[] = [];

    // Check for presentation layer
    if ('presentation' in directoryStructure || 'ui' in directoryStructure || 'web' in directoryStructure) {
      layersFound.push('Presentation Layer');
      evidence.push({
        type: 'directory',
        description: 'Presentation/UI layer detected',
        confidence: 0.2,
      });
    }

    // Check for business logic layer
    if ('business' in directoryStructure || 'bll' in directoryStructure || 'logic' in directoryStructure) {
      layersFound.push('Business Logic Layer');
      evidence.push({
        type: 'directory',
        description: 'Business logic layer detected',
        confidence: 0.2,
      });
    }

    // Check for data access layer
    if ('data' in directoryStructure || 'dal' in directoryStructure || 'persistence' in directoryStructure) {
      layersFound.push('Data Access Layer');
      evidence.push({
        type: 'directory',
        description: 'Data access layer detected',
        confidence: 0.2,
      });
    }

    // Check for API layer
    if ('api' in directoryStructure) {
      layersFound.push('API Layer');
      evidence.push({
        type: 'directory',
        description: 'API layer detected',
        confidence: 0.15,
      });
    }

    if (layersFound.length < 2) {
      return null;
    }

    components.Layers = layersFound;

    const confidence = Math.min(0.9, 0.55 + layersFound.length * 0.1);

    return {
      patternType: 'LayeredArchitecture',
      confidence,
      evidence,
      components,
      description: `Separates concerns into ${layersFound.length} distinct layers`,
    };
  }
}

// ============================================================================
// Clean Architecture Detector
// ============================================================================

/**
 * Detects Clean Architecture.
 */
export class CleanArchitectureDetector implements ArchitecturalPatternDetector {
  readonly patternType = 'CleanArchitecture' as const;

  detect(context: ArchitecturalDetectionContext): ArchitecturalPattern | null {
    const { directoryStructure, filePaths } = context;
    const evidence: ArchitecturalEvidence[] = [];
    const components: ComponentMap = {};

    const cleanMatches = countMatchingDirectories(directoryStructure, CLEAN_ARCH_DIRECTORIES);

    if (cleanMatches < 3) {
      return null;
    }

    // Check each layer
    if ('domain' in directoryStructure || 'entities' in directoryStructure) {
      evidence.push({
        type: 'directory',
        description: 'Domain/Entities layer (core business logic)',
        confidence: 0.2,
      });
      components.Domain = filterFilesByDir(filePaths, 'domain').concat(filterFilesByDir(filePaths, 'entities'));
    }

    if ('application' in directoryStructure || 'usecases' in directoryStructure || 'use-cases' in directoryStructure) {
      evidence.push({
        type: 'directory',
        description: 'Application/Use Cases layer',
        confidence: 0.2,
      });
      components.Application = filterFilesByDir(filePaths, 'application')
        .concat(filterFilesByDir(filePaths, 'usecases'))
        .concat(filterFilesByDir(filePaths, 'use-cases'));
    }

    if ('infrastructure' in directoryStructure) {
      evidence.push({
        type: 'directory',
        description: 'Infrastructure layer (external dependencies)',
        confidence: 0.2,
      });
      components.Infrastructure = filterFilesByDir(filePaths, 'infrastructure');
    }

    if ('presentation' in directoryStructure || 'ui' in directoryStructure || 'api' in directoryStructure) {
      evidence.push({
        type: 'directory',
        description: 'Presentation/UI/API layer',
        confidence: 0.15,
      });
      components.Presentation = filterFilesByDir(filePaths, 'presentation')
        .concat(filterFilesByDir(filePaths, 'ui'))
        .concat(filterFilesByDir(filePaths, 'api'));
    }

    if ('core' in directoryStructure) {
      evidence.push({
        type: 'directory',
        description: 'Core layer detected',
        confidence: 0.1,
      });
      components.Core = filterFilesByDir(filePaths, 'core');
    }

    const layerCount = Object.keys(components).length;
    if (layerCount < 3) {
      return null;
    }

    const confidence = Math.min(0.9, 0.6 + layerCount * 0.08);

    return {
      patternType: 'CleanArchitecture',
      confidence,
      evidence,
      components,
      description: 'Dependency inversion with domain at center, infrastructure at edges',
    };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/** Creates a new MVC detector */
export function createMVCDetector(): MVCDetector {
  return new MVCDetector();
}

/** Creates a new MVVM detector */
export function createMVVMDetector(): MVVMDetector {
  return new MVVMDetector();
}

/** Creates a new Repository pattern detector */
export function createRepositoryDetector(): RepositoryDetector {
  return new RepositoryDetector();
}

/** Creates a new Service Layer detector */
export function createServiceLayerDetector(): ServiceLayerDetector {
  return new ServiceLayerDetector();
}

/** Creates a new Layered Architecture detector */
export function createLayeredArchitectureDetector(): LayeredArchitectureDetector {
  return new LayeredArchitectureDetector();
}

/** Creates a new Clean Architecture detector */
export function createCleanArchitectureDetector(): CleanArchitectureDetector {
  return new CleanArchitectureDetector();
}

/**
 * Creates all architectural pattern detectors.
 */
export function createAllDetectors(): ArchitecturalPatternDetector[] {
  return [
    createMVCDetector(),
    createMVVMDetector(),
    createRepositoryDetector(),
    createServiceLayerDetector(),
    createLayeredArchitectureDetector(),
    createCleanArchitectureDetector(),
  ];
}
