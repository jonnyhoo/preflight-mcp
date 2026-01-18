/**
 * Architectural Pattern Analyzer Tests
 *
 * Tests for the architectural pattern detection module.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createArchitecturalAnalyzer,
  analyzeArchitecture,
  createMVCDetector,
  createMVVMDetector,
  createRepositoryDetector,
  createServiceLayerDetector,
  createLayeredArchitectureDetector,
  createCleanArchitectureDetector,
  type ArchitecturalDetectionContext,
  type DirectoryStructure,
} from '../../../src/bundle/analyzers/architectural/index.js';
import type { AnalyzerInput, IngestedFile, BundleManifest } from '../../../src/bundle/analyzers/types.js';

// ESM compat
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Helpers
// ============================================================================

function createMockFile(relativePath: string): IngestedFile {
  return {
    repoRelativePath: relativePath,
    bundleNormRelativePath: `repos/test/norm/${relativePath}`,
    bundleNormAbsPath: `/tmp/bundle/repos/test/norm/${relativePath}`,
    kind: 'code',
    repoId: 'test/repo',
  };
}

function createMockManifest(): BundleManifest {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    description: 'Test bundle',
    repos: {},
    layout: {
      version: 1,
      dirs: {
        root: '/tmp/bundle',
        repos: '/tmp/bundle/repos',
        analysis: '/tmp/bundle/analysis',
      },
    },
  };
}

function createMockInput(files: IngestedFile[]): AnalyzerInput {
  return {
    bundleRoot: '/tmp/bundle',
    files,
    manifest: createMockManifest(),
  };
}

function createDetectionContext(
  dirStructure: DirectoryStructure,
  filePaths: string[],
  frameworks: ('Django' | 'Flask' | 'Spring' | 'ASP.NET' | 'Rails' | 'Angular' | 'React' | 'Vue.js' | 'Express' | 'Laravel' | 'NestJS' | 'FastAPI' | 'Next.js' | 'Unknown')[] = []
): ArchitecturalDetectionContext {
  return {
    directoryStructure: dirStructure,
    filePaths,
    frameworks,
  };
}

// ============================================================================
// MVC Detector Tests
// ============================================================================

describe('MVCDetector', () => {
  const detector = createMVCDetector();

  it('should detect MVC pattern with models, views, and controllers directories', () => {
    const context = createDetectionContext(
      { models: 5, views: 10, controllers: 3 },
      [
        'src/models/user.ts',
        'src/models/product.ts',
        'src/views/home.html',
        'src/views/about.html',
        'src/controllers/userController.ts',
        'src/controllers/productController.ts',
      ]
    );

    const result = detector.detect(context);

    expect(result).not.toBeNull();
    expect(result?.patternType).toBe('MVC');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result?.components.Models.length).toBeGreaterThan(0);
    expect(result?.components.Views.length).toBeGreaterThan(0);
    expect(result?.components.Controllers.length).toBeGreaterThan(0);
  });

  it('should return null when insufficient MVC structure', () => {
    const context = createDetectionContext(
      { src: 10, lib: 5 },
      ['src/index.ts', 'lib/utils.ts']
    );

    const result = detector.detect(context);
    expect(result).toBeNull();
  });

  it('should boost confidence when MVC framework detected', () => {
    const contextWithoutFramework = createDetectionContext(
      { models: 5, views: 10, controllers: 3 },
      [
        'src/models/user.ts',
        'src/views/home.html',
        'src/controllers/userController.ts',
      ]
    );

    const contextWithFramework = createDetectionContext(
      { models: 5, views: 10, controllers: 3 },
      [
        'src/models/user.ts',
        'src/views/home.html',
        'src/controllers/userController.ts',
      ],
      ['Django']
    );

    const resultWithout = detector.detect(contextWithoutFramework);
    const resultWith = detector.detect(contextWithFramework);

    expect(resultWith).not.toBeNull();
    expect(resultWith!.confidence).toBeGreaterThan(resultWithout!.confidence);
    expect(resultWith!.framework).toBe('Django');
  });
});

// ============================================================================
// MVVM Detector Tests
// ============================================================================

describe('MVVMDetector', () => {
  const detector = createMVVMDetector();

  it('should detect MVVM pattern with viewmodels', () => {
    const context = createDetectionContext(
      { models: 3, views: 5, viewmodels: 4 },
      [
        'src/models/user.ts',
        'src/views/userView.vue',
        'src/viewmodels/userViewModel.ts',
        'src/viewmodels/productViewModel.ts',
      ]
    );

    const result = detector.detect(context);

    expect(result).not.toBeNull();
    expect(result?.patternType).toBe('MVVM');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result?.components.ViewModels.length).toBeGreaterThanOrEqual(2);
  });

  it('should return null without viewmodels', () => {
    const context = createDetectionContext(
      { models: 5, views: 10 },
      ['src/models/user.ts', 'src/views/home.html']
    );

    const result = detector.detect(context);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Repository Pattern Detector Tests
// ============================================================================

describe('RepositoryDetector', () => {
  const detector = createRepositoryDetector();

  it('should detect repository pattern', () => {
    const context = createDetectionContext(
      { repositories: 4, src: 10 },
      [
        'src/repositories/userRepository.ts',
        'src/repositories/productRepository.ts',
        'src/repositories/orderRepository.ts',
      ]
    );

    const result = detector.detect(context);

    expect(result).not.toBeNull();
    expect(result?.patternType).toBe('Repository');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result?.components.Repositories.length).toBeGreaterThanOrEqual(2);
  });

  it('should detect by naming convention even without repository directory', () => {
    const context = createDetectionContext(
      { src: 10 },
      [
        'src/data/userRepository.ts',
        'src/data/productRepository.ts',
      ]
    );

    const result = detector.detect(context);

    expect(result).not.toBeNull();
    expect(result?.patternType).toBe('Repository');
  });

  it('should return null with insufficient repositories', () => {
    const context = createDetectionContext(
      { src: 10 },
      ['src/index.ts', 'src/utils.ts']
    );

    const result = detector.detect(context);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Service Layer Detector Tests
// ============================================================================

describe('ServiceLayerDetector', () => {
  const detector = createServiceLayerDetector();

  it('should detect service layer pattern', () => {
    const context = createDetectionContext(
      { services: 5 },
      [
        'src/services/userService.ts',
        'src/services/authService.ts',
        'src/services/emailService.ts',
      ]
    );

    const result = detector.detect(context);

    expect(result).not.toBeNull();
    expect(result?.patternType).toBe('ServiceLayer');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result?.components.Services.length).toBeGreaterThanOrEqual(3);
  });

  it('should return null with insufficient services', () => {
    const context = createDetectionContext(
      { src: 10 },
      ['src/userService.ts']
    );

    const result = detector.detect(context);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Layered Architecture Detector Tests
// ============================================================================

describe('LayeredArchitectureDetector', () => {
  const detector = createLayeredArchitectureDetector();

  it('should detect layered architecture', () => {
    const context = createDetectionContext(
      { presentation: 5, business: 8, data: 6 },
      [
        'src/presentation/userController.ts',
        'src/business/userService.ts',
        'src/data/userRepository.ts',
      ]
    );

    const result = detector.detect(context);

    expect(result).not.toBeNull();
    expect(result?.patternType).toBe('LayeredArchitecture');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result?.components.Layers.length).toBeGreaterThanOrEqual(2);
  });

  it('should detect with ui/bll/dal naming', () => {
    const context = createDetectionContext(
      { ui: 3, bll: 5, dal: 4 },
      [
        'src/ui/form.ts',
        'src/bll/validation.ts',
        'src/dal/database.ts',
      ]
    );

    const result = detector.detect(context);

    expect(result).not.toBeNull();
    expect(result?.patternType).toBe('LayeredArchitecture');
  });

  it('should return null without layer structure', () => {
    const context = createDetectionContext(
      { src: 10, lib: 5 },
      ['src/index.ts']
    );

    const result = detector.detect(context);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Clean Architecture Detector Tests
// ============================================================================

describe('CleanArchitectureDetector', () => {
  const detector = createCleanArchitectureDetector();

  it('should detect clean architecture', () => {
    const context = createDetectionContext(
      { domain: 10, application: 8, infrastructure: 5, presentation: 4 },
      [
        'src/domain/entities/user.ts',
        'src/application/usecases/createUser.ts',
        'src/infrastructure/database/postgres.ts',
        'src/presentation/api/userController.ts',
      ]
    );

    const result = detector.detect(context);

    expect(result).not.toBeNull();
    expect(result?.patternType).toBe('CleanArchitecture');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('should detect with entities and usecases directories', () => {
    const context = createDetectionContext(
      { entities: 5, usecases: 8, infrastructure: 4 },
      [
        'src/entities/user.ts',
        'src/usecases/createUser.ts',
        'src/infrastructure/db.ts',
      ]
    );

    const result = detector.detect(context);

    expect(result).not.toBeNull();
    expect(result?.patternType).toBe('CleanArchitecture');
  });

  it('should return null with insufficient layers', () => {
    const context = createDetectionContext(
      { domain: 5, src: 10 },
      ['src/domain/user.ts']
    );

    const result = detector.detect(context);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Architectural Analyzer Integration Tests
// ============================================================================

describe('ArchitecturalAnalyzer', () => {
  it('should analyze MVC codebase structure', async () => {
    const files = [
      createMockFile('src/models/user.ts'),
      createMockFile('src/models/product.ts'),
      createMockFile('src/views/home.html'),
      createMockFile('src/views/about.html'),
      createMockFile('src/controllers/userController.ts'),
      createMockFile('src/controllers/productController.ts'),
    ];

    const input = createMockInput(files);
    const analyzer = createArchitecturalAnalyzer({ minConfidence: 0.5 });

    const result = await analyzer.analyze(input);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.patterns.length).toBeGreaterThan(0);
    expect(result.data!.patterns.some((p) => p.patternType === 'MVC')).toBe(true);
  });

  it('should detect multiple patterns', async () => {
    const files = [
      // MVC structure
      createMockFile('src/models/user.ts'),
      createMockFile('src/views/home.html'),
      createMockFile('src/controllers/userController.ts'),
      // Service layer
      createMockFile('src/services/userService.ts'),
      createMockFile('src/services/authService.ts'),
      createMockFile('src/services/emailService.ts'),
      // Repository
      createMockFile('src/repositories/userRepository.ts'),
      createMockFile('src/repositories/productRepository.ts'),
    ];

    const input = createMockInput(files);
    const result = await analyzeArchitecture(input, { minConfidence: 0.5 });

    expect(result.success).toBe(true);
    expect(result.data!.patterns.length).toBeGreaterThan(1);
  });

  it('should handle empty file list', async () => {
    const input = createMockInput([]);
    const analyzer = createArchitecturalAnalyzer();

    const result = await analyzer.analyze(input);

    expect(result.success).toBe(true);
    expect(result.data!.patterns).toEqual([]);
    expect(result.data!.totalFilesAnalyzed).toBe(0);
  });

  it('should respect minConfidence option', async () => {
    const files = [
      createMockFile('src/models/user.ts'),
      createMockFile('src/views/home.html'),
      createMockFile('src/controllers/userController.ts'),
    ];

    const input = createMockInput(files);
    
    const lowThreshold = await analyzeArchitecture(input, { minConfidence: 0.3 });
    const highThreshold = await analyzeArchitecture(input, { minConfidence: 0.95 });

    expect(lowThreshold.data!.patterns.length).toBeGreaterThanOrEqual(
      highThreshold.data!.patterns.length
    );
  });

  it('should filter patterns by type when specified', async () => {
    const files = [
      createMockFile('src/models/user.ts'),
      createMockFile('src/views/home.html'),
      createMockFile('src/controllers/userController.ts'),
      createMockFile('src/services/userService.ts'),
      createMockFile('src/services/authService.ts'),
      createMockFile('src/services/emailService.ts'),
    ];

    const input = createMockInput(files);
    const result = await analyzeArchitecture(input, {
      patternTypes: ['MVC'],
      minConfidence: 0.5,
    });

    expect(result.success).toBe(true);
    expect(result.data!.patterns.every((p) => p.patternType === 'MVC')).toBe(true);
  });

  it('should exclude evidence when includeEvidence is false', async () => {
    const files = [
      createMockFile('src/models/user.ts'),
      createMockFile('src/views/home.html'),
      createMockFile('src/controllers/userController.ts'),
    ];

    const input = createMockInput(files);
    const result = await analyzeArchitecture(input, {
      includeEvidence: false,
      minConfidence: 0.5,
    });

    expect(result.success).toBe(true);
    if (result.data!.patterns.length > 0) {
      expect(result.data!.patterns[0].evidence).toEqual([]);
    }
  });

  it('should set primaryArchitecture to highest confidence pattern', async () => {
    const files = [
      createMockFile('src/models/user.ts'),
      createMockFile('src/views/home.html'),
      createMockFile('src/controllers/userController.ts'),
    ];

    const input = createMockInput(files);
    const result = await analyzeArchitecture(input, { minConfidence: 0.5 });

    expect(result.success).toBe(true);
    if (result.data!.patterns.length > 0) {
      expect(result.data!.primaryArchitecture).toBe(result.data!.patterns[0].patternType);
    }
  });

  it('should return metadata with analyzer info', async () => {
    const files = [createMockFile('src/index.ts')];
    const input = createMockInput(files);
    
    const result = await analyzeArchitecture(input);

    expect(result.metadata.analyzerName).toBe('architectural-analyzer');
    expect(result.metadata.version).toBe('1.0.0');
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.filesAnalyzed).toBe(1);
  });
});
