/**
 * Architecture Summary Extractor
 *
 * Generates a high-level architectural overview of a codebase including:
 * - Module dependency graph (simplified)
 * - Interface-implementation mappings
 * - Core types and data structures
 * - Public API surface
 * - Entry points and flow
 *
 * This gives LLMs a "bird's eye view" without reading every file.
 *
 * @module analysis/architecture-summary
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('architecture-summary');

// ============================================================================
// Types
// ============================================================================

/**
 * Simplified module dependency info for overview.
 */
export interface ModuleDependency {
  /** Source module path */
  from: string;
  /** Target module path */
  to: string;
  /** Import type */
  kind: 'internal' | 'external' | 'relative';
}

/**
 * Interface-implementation mapping.
 */
export interface ImplementationMap {
  /** Interface/trait/protocol name */
  interfaceName: string;
  /** File where interface is defined */
  definedIn: string;
  /** Line number */
  line: number;
  /** Implementing types */
  implementations: Array<{
    name: string;
    file: string;
    line: number;
  }>;
}

/**
 * Core type/struct/class summary.
 */
export interface CoreType {
  /** Type name */
  name: string;
  /** Type kind */
  kind: 'class' | 'struct' | 'interface' | 'type' | 'enum';
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Number of usages/references (indicates importance) */
  usageCount: number;
  /** Brief description if available from comments */
  description?: string;
  /** Key fields/properties */
  fields?: string[];
}

/**
 * Public API entry.
 */
export interface PublicAPIEntry {
  /** Export name */
  name: string;
  /** Export kind */
  kind: 'function' | 'class' | 'type' | 'const' | 'interface' | 'module';
  /** Source file */
  file: string;
  /** Signature or brief description */
  signature?: string;
}

/**
 * Complete architecture summary.
 */
export interface ArchitectureSummary {
  /** High-level module dependency graph */
  moduleDependencies: {
    /** Internal module relationships */
    internal: ModuleDependency[];
    /** External dependencies (summarized) */
    externalDeps: string[];
    /** Key hub modules (many incoming/outgoing deps) */
    hubModules: Array<{
      module: string;
      inDegree: number;
      outDegree: number;
    }>;
  };
  /** Interface-implementation mappings */
  implementations: ImplementationMap[];
  /** Core types in the codebase */
  coreTypes: CoreType[];
  /** Public API surface */
  publicAPI: PublicAPIEntry[];
  /** Entry points */
  entryPoints: Array<{
    file: string;
    kind: 'main' | 'bin' | 'lib' | 'index';
  }>;
  /** Summary statistics */
  stats: {
    totalModules: number;
    totalInternalDeps: number;
    totalExternalDeps: number;
    totalInterfaces: number;
    totalImplementations: number;
    totalCoreTypes: number;
    totalPublicAPIs: number;
  };
}

// ============================================================================
// Architecture Summary Extractor
// ============================================================================

export class ArchitectureSummaryExtractor {
  /**
   * Extract architecture summary from analyzed files.
   */
  async extractSummary(
    files: Array<{
      absPath: string;
      relativePath: string;
      content: string;
      language: string;
    }>,
    existingAnalysis?: {
      extensionPoints?: Array<{
        kind: string;
        name: string;
        file: string;
        line: number;
      }>;
    }
  ): Promise<ArchitectureSummary> {
    const startTime = Date.now();

    // Extract imports from all files
    const allImports = this.extractAllImports(files);

    // Build module dependency graph
    const moduleDependencies = this.buildModuleDependencies(allImports, files);

    // Find interface implementations
    const implementations = this.findImplementations(files, existingAnalysis?.extensionPoints || []);

    // Identify core types
    const coreTypes = this.identifyCoreTypes(files, allImports);

    // Extract public API
    const publicAPI = this.extractPublicAPI(files);

    // Find entry points
    const entryPoints = this.findEntryPoints(files);

    const summary: ArchitectureSummary = {
      moduleDependencies,
      implementations,
      coreTypes,
      publicAPI,
      entryPoints,
      stats: {
        totalModules: files.length,
        totalInternalDeps: moduleDependencies.internal.length,
        totalExternalDeps: moduleDependencies.externalDeps.length,
        totalInterfaces: implementations.length,
        totalImplementations: implementations.reduce((sum, i) => sum + i.implementations.length, 0),
        totalCoreTypes: coreTypes.length,
        totalPublicAPIs: publicAPI.length,
      },
    };

    logger.info('Architecture summary extracted', {
      timeMs: Date.now() - startTime,
      modules: summary.stats.totalModules,
      interfaces: summary.stats.totalInterfaces,
    });

    return summary;
  }

  // ============================================================================
  // Import Extraction
  // ============================================================================

  private extractAllImports(
    files: Array<{ relativePath: string; content: string; language: string }>
  ): Array<{ from: string; imports: string[]; isExternal: boolean }> {
    const results: Array<{ from: string; imports: string[]; isExternal: boolean }> = [];

    for (const file of files) {
      const imports = this.extractImportsFromContent(file.content, file.language);
      for (const imp of imports) {
        results.push({
          from: file.relativePath,
          imports: [imp.module],
          isExternal: !imp.module.startsWith('.') && !imp.module.startsWith('/'),
        });
      }
    }

    return results;
  }

  private extractImportsFromContent(
    content: string,
    language: string
  ): Array<{ module: string; names?: string[] }> {
    const imports: Array<{ module: string; names?: string[] }> = [];

    switch (language) {
      case 'typescript':
      case 'javascript': {
        // ES imports: import { x } from 'module'
        const esImportRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = esImportRegex.exec(content)) !== null) {
          imports.push({ module: match[1]! });
        }
        // require()
        const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((match = requireRegex.exec(content)) !== null) {
          imports.push({ module: match[1]! });
        }
        break;
      }
      case 'python': {
        // import x / from x import y
        const importRegex = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          imports.push({ module: match[1] || match[2]! });
        }
        break;
      }
      case 'go': {
        // import "package" or import ( "package" )
        const importRegex = /import\s+(?:\(\s*)?["']([^"']+)["']/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          imports.push({ module: match[1]! });
        }
        break;
      }
      case 'rust': {
        // use crate::module or use external::module
        const useRegex = /use\s+(\w+(?:::\w+)*)/g;
        let match;
        while ((match = useRegex.exec(content)) !== null) {
          imports.push({ module: match[1]! });
        }
        break;
      }
    }

    return imports;
  }

  // ============================================================================
  // Module Dependencies
  // ============================================================================

  private buildModuleDependencies(
    allImports: Array<{ from: string; imports: string[]; isExternal: boolean }>,
    files: Array<{ relativePath: string }>
  ): ArchitectureSummary['moduleDependencies'] {
    const internal: ModuleDependency[] = [];
    const externalSet = new Set<string>();
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();

    const fileSet = new Set(files.map((f) => f.relativePath));

    for (const imp of allImports) {
      for (const module of imp.imports) {
        if (imp.isExternal) {
          // Extract package name (first part)
          const pkgName = module.split('/')[0]!.replace(/^@[^/]+\//, '@scope/');
          externalSet.add(pkgName);
        } else {
          // Internal dependency
          const resolved = this.resolveRelativeImport(imp.from, module);
          
          internal.push({
            from: imp.from,
            to: resolved,
            kind: module.startsWith('.') ? 'relative' : 'internal',
          });

          // Track degrees
          outDegree.set(imp.from, (outDegree.get(imp.from) || 0) + 1);
          inDegree.set(resolved, (inDegree.get(resolved) || 0) + 1);
        }
      }
    }

    // Find hub modules (high connectivity)
    const hubModules: Array<{ module: string; inDegree: number; outDegree: number }> = [];
    const allModules = new Set([...inDegree.keys(), ...outDegree.keys()]);

    for (const module of allModules) {
      const inD = inDegree.get(module) || 0;
      const outD = outDegree.get(module) || 0;
      const total = inD + outD;

      // Hub if total degree > 5
      if (total > 5) {
        hubModules.push({ module, inDegree: inD, outDegree: outD });
      }
    }

    // Sort hubs by total degree
    hubModules.sort((a, b) => (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree));

    return {
      internal: internal.slice(0, 200), // Limit for FACTS.json size
      externalDeps: Array.from(externalSet).sort(),
      hubModules: hubModules.slice(0, 10),
    };
  }

  private resolveRelativeImport(fromFile: string, importPath: string): string {
    if (!importPath.startsWith('.')) return importPath;

    const fromDir = path.dirname(fromFile);
    const resolved = path.posix.normalize(path.posix.join(fromDir, importPath));

    // Try common extensions
    return resolved.replace(/\.(js|ts|tsx|jsx|mjs)$/, '');
  }

  // ============================================================================
  // Interface Implementations
  // ============================================================================

  private findImplementations(
    files: Array<{ relativePath: string; content: string; language: string }>,
    extensionPoints: Array<{ kind: string; name: string; file: string; line: number }>
  ): ImplementationMap[] {
    const interfaces = extensionPoints.filter((ep) => ep.kind === 'interface');
    const implementations: ImplementationMap[] = [];

    for (const iface of interfaces) {
      const impls = this.findImplementorsOf(iface.name, files);

      implementations.push({
        interfaceName: iface.name,
        definedIn: iface.file,
        line: iface.line,
        implementations: impls,
      });
    }

    // Sort by number of implementations (most important first)
    implementations.sort((a, b) => b.implementations.length - a.implementations.length);

    return implementations.slice(0, 30); // Top 30 interfaces
  }

  private findImplementorsOf(
    interfaceName: string,
    files: Array<{ relativePath: string; content: string; language: string }>
  ): Array<{ name: string; file: string; line: number }> {
    const implementors: Array<{ name: string; file: string; line: number }> = [];

    for (const file of files) {
      const impls = this.findImplementorsInFile(interfaceName, file.content, file.language);
      for (const impl of impls) {
        implementors.push({
          name: impl.name,
          file: file.relativePath,
          line: impl.line,
        });
      }
    }

    return implementors;
  }

  private findImplementorsInFile(
    interfaceName: string,
    content: string,
    language: string
  ): Array<{ name: string; line: number }> {
    const results: Array<{ name: string; line: number }> = [];
    const lines = content.split('\n');

    switch (language) {
      case 'typescript':
      case 'javascript': {
        // class X implements Interface
        const implRegex = new RegExp(`class\\s+(\\w+)(?:\\s+extends\\s+\\w+)?\\s+implements\\s+[^{]*\\b${interfaceName}\\b`, 'g');
        let match;
        while ((match = implRegex.exec(content)) !== null) {
          const line = content.substring(0, match.index).split('\n').length;
          results.push({ name: match[1]!, line });
        }
        break;
      }
      case 'python': {
        // class X(Interface): or class X(ABC, Interface):
        const classRegex = new RegExp(`class\\s+(\\w+)\\s*\\([^)]*\\b${interfaceName}\\b[^)]*\\)`, 'g');
        let match;
        while ((match = classRegex.exec(content)) !== null) {
          const line = content.substring(0, match.index).split('\n').length;
          results.push({ name: match[1]!, line });
        }
        break;
      }
      case 'go': {
        // Go uses structural typing - look for types that have the same methods
        // This is a simplified heuristic
        break;
      }
      case 'rust': {
        // impl Trait for Type
        const implRegex = new RegExp(`impl\\s+${interfaceName}\\s+for\\s+(\\w+)`, 'g');
        let match;
        while ((match = implRegex.exec(content)) !== null) {
          const line = content.substring(0, match.index).split('\n').length;
          results.push({ name: match[1]!, line });
        }
        break;
      }
    }

    return results;
  }

  // ============================================================================
  // Core Types
  // ============================================================================

  private identifyCoreTypes(
    files: Array<{ relativePath: string; content: string; language: string }>,
    allImports: Array<{ from: string; imports: string[] }>
  ): CoreType[] {
    const typeUsage = new Map<string, number>();
    const typeDefinitions = new Map<string, CoreType>();

    // First pass: find all type definitions
    for (const file of files) {
      const types = this.extractTypeDefinitions(file.content, file.language, file.relativePath);
      for (const type of types) {
        typeDefinitions.set(type.name, type);
        typeUsage.set(type.name, 0);
      }
    }

    // Second pass: count usages
    for (const file of files) {
      for (const [typeName] of typeDefinitions) {
        const regex = new RegExp(`\\b${typeName}\\b`, 'g');
        const matches = file.content.match(regex);
        if (matches) {
          typeUsage.set(typeName, (typeUsage.get(typeName) || 0) + matches.length);
        }
      }
    }

    // Build result with usage counts
    const coreTypes: CoreType[] = [];
    for (const [name, type] of typeDefinitions) {
      type.usageCount = typeUsage.get(name) || 0;
      coreTypes.push(type);
    }

    // Sort by usage count (most used = most important)
    coreTypes.sort((a, b) => b.usageCount - a.usageCount);

    return coreTypes.slice(0, 50); // Top 50 types
  }

  private extractTypeDefinitions(
    content: string,
    language: string,
    file: string
  ): CoreType[] {
    const types: CoreType[] = [];
    const lines = content.split('\n');

    switch (language) {
      case 'typescript':
      case 'javascript': {
        // interface, type, class, enum
        const patterns = [
          { regex: /^export\s+(?:interface|type)\s+(\w+)/gm, kind: 'interface' as const },
          { regex: /^export\s+class\s+(\w+)/gm, kind: 'class' as const },
          { regex: /^export\s+enum\s+(\w+)/gm, kind: 'enum' as const },
        ];

        for (const { regex, kind } of patterns) {
          let match;
          while ((match = regex.exec(content)) !== null) {
            const line = content.substring(0, match.index).split('\n').length;
            types.push({
              name: match[1]!,
              kind,
              file,
              line,
              usageCount: 0,
            });
          }
        }
        break;
      }
      case 'python': {
        // class definitions
        const classRegex = /^class\s+(\w+)/gm;
        let match;
        while ((match = classRegex.exec(content)) !== null) {
          const line = content.substring(0, match.index).split('\n').length;
          types.push({
            name: match[1]!,
            kind: 'class',
            file,
            line,
            usageCount: 0,
          });
        }
        break;
      }
      case 'go': {
        // type X struct/interface
        const typeRegex = /^type\s+(\w+)\s+(struct|interface)/gm;
        let match;
        while ((match = typeRegex.exec(content)) !== null) {
          const line = content.substring(0, match.index).split('\n').length;
          types.push({
            name: match[1]!,
            kind: match[2] === 'struct' ? 'struct' : 'interface',
            file,
            line,
            usageCount: 0,
          });
        }
        break;
      }
      case 'rust': {
        // struct, enum, trait
        const patterns = [
          { regex: /^pub\s+struct\s+(\w+)/gm, kind: 'struct' as const },
          { regex: /^pub\s+enum\s+(\w+)/gm, kind: 'enum' as const },
          { regex: /^pub\s+trait\s+(\w+)/gm, kind: 'interface' as const },
        ];

        for (const { regex, kind } of patterns) {
          let match;
          while ((match = regex.exec(content)) !== null) {
            const line = content.substring(0, match.index).split('\n').length;
            types.push({
              name: match[1]!,
              kind,
              file,
              line,
              usageCount: 0,
            });
          }
        }
        break;
      }
    }

    return types;
  }

  // ============================================================================
  // Public API
  // ============================================================================

  private extractPublicAPI(
    files: Array<{ relativePath: string; content: string; language: string }>
  ): PublicAPIEntry[] {
    const apis: PublicAPIEntry[] = [];

    // Focus on entry point files
    const entryFiles = files.filter((f) =>
      f.relativePath.includes('index.') ||
      f.relativePath.includes('lib.') ||
      f.relativePath.includes('main.') ||
      f.relativePath.includes('mod.')
    );

    for (const file of entryFiles) {
      const exports = this.extractExportsFromFile(file.content, file.language, file.relativePath);
      apis.push(...exports);
    }

    // Limit size
    return apis.slice(0, 100);
  }

  private extractExportsFromFile(
    content: string,
    language: string,
    file: string
  ): PublicAPIEntry[] {
    const exports: PublicAPIEntry[] = [];

    switch (language) {
      case 'typescript':
      case 'javascript': {
        // export function/class/const/type
        const exportRegex = /^export\s+(?:async\s+)?(?:function|class|const|let|type|interface|enum)\s+(\w+)/gm;
        let match;
        while ((match = exportRegex.exec(content)) !== null) {
          exports.push({
            name: match[1]!,
            kind: 'function',
            file,
          });
        }
        // export { x, y }
        const namedExportRegex = /^export\s*\{([^}]+)\}/gm;
        while ((match = namedExportRegex.exec(content)) !== null) {
          const names = match[1]!.split(',').map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
          for (const name of names) {
            if (name) {
              exports.push({ name, kind: 'module', file });
            }
          }
        }
        break;
      }
      case 'python': {
        // __all__ or top-level public definitions
        const allMatch = content.match(/__all__\s*=\s*\[([^\]]+)\]/);
        if (allMatch) {
          const names = allMatch[1]!.split(',').map((n) => n.trim().replace(/['"]/g, ''));
          for (const name of names) {
            if (name) {
              exports.push({ name, kind: 'module', file });
            }
          }
        }
        break;
      }
      case 'rust': {
        // pub fn, pub struct, pub enum, pub trait
        const pubRegex = /^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+(\w+)/gm;
        let match;
        while ((match = pubRegex.exec(content)) !== null) {
          exports.push({
            name: match[1]!,
            kind: 'function',
            file,
          });
        }
        break;
      }
    }

    return exports;
  }

  // ============================================================================
  // Entry Points
  // ============================================================================

  private findEntryPoints(
    files: Array<{ relativePath: string; content: string }>
  ): ArchitectureSummary['entryPoints'] {
    const entryPoints: ArchitectureSummary['entryPoints'] = [];

    for (const file of files) {
      const filename = path.basename(file.relativePath);
      const dir = path.dirname(file.relativePath);

      if (filename === 'main.ts' || filename === 'main.js' || filename === 'main.py' || filename === 'main.go' || filename === 'main.rs') {
        entryPoints.push({ file: file.relativePath, kind: 'main' });
      } else if (filename === 'index.ts' || filename === 'index.js' || filename === '__init__.py' || filename === 'mod.rs' || filename === 'lib.rs') {
        entryPoints.push({ file: file.relativePath, kind: 'lib' });
      } else if (dir.includes('/bin/') || dir.includes('/cmd/')) {
        entryPoints.push({ file: file.relativePath, kind: 'bin' });
      }
    }

    return entryPoints;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createArchitectureSummaryExtractor(): ArchitectureSummaryExtractor {
  return new ArchitectureSummaryExtractor();
}
