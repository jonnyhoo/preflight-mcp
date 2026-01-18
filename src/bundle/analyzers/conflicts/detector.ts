/**
 * Conflict Detector Module
 *
 * Detects conflicts between documentation and code sources:
 * - missing_in_docs: API exists in code but not documented
 * - missing_in_code: API documented but doesn't exist in code
 * - signature_mismatch: Different parameters/types between docs and code
 *
 * @module bundle/analyzers/conflicts/detector
 */

import { BaseAnalyzer } from '../base-analyzer.js';
import type { AnalyzerInput, AnalyzerOutput, AnalyzerErrorInfo, AnalyzerHighlight } from '../types.js';

import {
  type Conflict,
  type ConflictType,
  type ConflictSeverity,
  type ConflictReport,
  type ConflictOutput,
  type ConflictAnalyzerOptions,
  type ConflictSummary,
  type APIInfo,
  type APIParameter,
  type DocsData,
  type CodeData,
  type DocsPage,
  type DocsPageContent,
  type CodeFile,
  DEFAULT_CONFLICT_OPTIONS,
} from './types.js';

// ============================================================================
// String Similarity Utility
// ============================================================================

/**
 * Calculates similarity ratio between two strings using Levenshtein-based approach.
 * Similar to Python's difflib.SequenceMatcher.ratio()
 *
 * @param a - First string
 * @param b - Second string
 * @returns Similarity ratio between 0 and 1
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  const longerLength = longer.length;
  if (longerLength === 0) return 1;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longerLength - editDistance) / longerLength;
}

/**
 * Calculates Levenshtein edit distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  const firstRow = matrix[0];
  if (firstRow) {
    for (let j = 0; j <= a.length; j++) {
      firstRow[j] = j;
    }
  }

  for (let i = 1; i <= b.length; i++) {
    const currentRow = matrix[i];
    const prevRow = matrix[i - 1];
    if (!currentRow || !prevRow) continue;

    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        currentRow[j] = prevRow[j - 1] ?? 0;
      } else {
        const substitution = (prevRow[j - 1] ?? 0) + 1;
        const insertion = (currentRow[j - 1] ?? 0) + 1;
        const deletion = (prevRow[j] ?? 0) + 1;
        currentRow[j] = Math.min(substitution, insertion, deletion);
      }
    }
  }

  return matrix[b.length]?.[a.length] ?? 0;
}

// ============================================================================
// API Extraction Utilities
// ============================================================================

/**
 * Checks if an API name indicates private/internal usage.
 */
function isPrivateApi(name: string): boolean {
  return name.startsWith('_') || name.includes('__');
}

/**
 * Parses a parameter string into APIParameter objects.
 */
function parseParameterString(paramsStr: string): APIParameter[] {
  if (!paramsStr.trim()) return [];

  const params: APIParameter[] = [];

  for (const param of paramsStr.split(',')) {
    const trimmed = param.trim();
    if (!trimmed) continue;

    const paramInfo: APIParameter = { name: trimmed };

    // Check for type annotation (: type)
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':', 2);
      const namePart = parts[0] ?? '';
      const typePart = parts[1] ?? '';
      paramInfo.name = namePart.trim();

      // Check for default value (= value) in type part
      if (typePart.includes('=')) {
        const typeParts = typePart.split('=', 2);
        const typeStr = typeParts[0] ?? '';
        const defaultStr = typeParts[1] ?? '';
        paramInfo.type = typeStr.trim();
        paramInfo.default = defaultStr.trim();
        paramInfo.optional = true;
      } else {
        paramInfo.type = typePart.trim();
      }
    }
    // Check for default without type (= value)
    else if (trimmed.includes('=')) {
      const parts = trimmed.split('=', 2);
      const namePart = parts[0] ?? '';
      const defaultStr = parts[1] ?? '';
      paramInfo.name = namePart.trim();
      paramInfo.default = defaultStr.trim();
      paramInfo.optional = true;
    }

    params.push(paramInfo);
  }

  return params;
}

/**
 * Extracts API signatures from documentation content.
 */
function extractApisFromContent(content: string, sourceUrl: string): Map<string, APIInfo> {
  const apis = new Map<string, APIInfo>();

  // Patterns for common API signatures
  const patterns = [
    // Python style: def name(params) -> return
    /def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(\w+))?/g,
    // JavaScript style: function name(params)
    /function\s+(\w+)\s*\(([^)]*)\)/g,
    // Method style: ClassName.method_name(params)
    /(\w+)\.(\w+)\s*\(([^)]*)\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      let name: string;
      let paramsStr: string;
      let returnType: string | undefined;

      if (pattern.source.includes('def')) {
        // Python function
        name = match[1] ?? '';
        paramsStr = match[2] ?? '';
        returnType = match[3];
      } else if (pattern.source.includes('function')) {
        // JavaScript function
        name = match[1] ?? '';
        paramsStr = match[2] ?? '';
      } else {
        // Class method
        const className = match[1] ?? '';
        const methodName = match[2] ?? '';
        name = `${className}.${methodName}`;
        paramsStr = match[3] ?? '';
      }

      const parameters = parseParameterString(paramsStr);

      apis.set(name, {
        name,
        type: 'function',
        parameters,
        returnType,
        sourceUrl,
        rawSignature: match[0],
        isPrivate: isPrivateApi(name),
      });
    }
  }

  return apis;
}

/**
 * Extracts APIs from documentation data structure.
 */
function extractDocsApis(docsData: DocsData): Map<string, APIInfo> {
  const apis = new Map<string, APIInfo>();

  // If APIs are pre-extracted
  if (docsData.apis) {
    for (const api of docsData.apis) {
      apis.set(api.name, { ...api, isPrivate: isPrivateApi(api.name) });
    }
    return apis;
  }

  const pages = docsData.pages;
  if (!pages) return apis;

  // Handle dict format: {url: pageContent, ...}
  if (!Array.isArray(pages)) {
    for (const [url, pageData] of Object.entries(pages as Record<string, DocsPageContent>)) {
      const content = pageData.content ?? '';
      const title = pageData.title ?? '';

      // Check if this is an API page
      const isApiPage = ['api', 'reference', 'class', 'function', 'method']
        .some(keyword => title.toLowerCase().includes(keyword) || url.toLowerCase().includes(keyword));

      if (isApiPage) {
        const extracted = extractApisFromContent(content, url);
        for (const [name, info] of extracted) {
          apis.set(name, info);
        }
      }
    }
    return apis;
  }

  // Handle list format: [{url, apis, ...}, ...]
  for (const page of pages as DocsPage[]) {
    const url = page.url ?? '';

    // If APIs are already extracted in the page data
    if (page.apis) {
      for (const api of page.apis) {
        apis.set(api.name, {
          ...api,
          sourceUrl: url,
          isPrivate: isPrivateApi(api.name),
        });
      }
    }
    // Otherwise try to extract from content
    else if (page.content) {
      const extracted = extractApisFromContent(page.content, url);
      for (const [name, info] of extracted) {
        apis.set(name, info);
      }
    }
  }

  return apis;
}

/**
 * Extracts APIs from code analysis data structure.
 */
function extractCodeApis(codeData: CodeData): Map<string, APIInfo> {
  const apis = new Map<string, APIInfo>();

  // If APIs are pre-extracted
  if (codeData.apis) {
    for (const api of codeData.apis) {
      apis.set(api.name, { ...api, isPrivate: isPrivateApi(api.name) });
    }
    return apis;
  }

  const codeAnalysis = codeData.code_analysis;
  if (!codeAnalysis) return apis;

  // Support both 'files' and 'analyzed_files' keys
  const files = codeAnalysis.files ?? codeAnalysis.analyzed_files ?? [];

  for (const fileInfo of files as CodeFile[]) {
    const filePath = fileInfo.file ?? 'unknown';

    // Extract classes and their methods
    for (const classInfo of fileInfo.classes ?? []) {
      const className = classInfo.name;

      // Add class itself
      apis.set(className, {
        name: className,
        type: 'class',
        source: filePath,
        line: classInfo.line_number,
        description: classInfo.docstring,
        isPrivate: isPrivateApi(className),
      });

      // Add methods
      for (const method of classInfo.methods ?? []) {
        const methodName = `${className}.${method.name}`;
        apis.set(methodName, {
          name: methodName,
          type: 'method',
          parameters: method.parameters,
          returnType: method.return_type,
          source: filePath,
          line: method.line_number,
          description: method.docstring,
          isAsync: method.is_async,
          isPrivate: isPrivateApi(method.name),
        });
      }
    }

    // Extract standalone functions
    for (const funcInfo of fileInfo.functions ?? []) {
      const funcName = funcInfo.name;
      apis.set(funcName, {
        name: funcName,
        type: 'function',
        parameters: funcInfo.parameters,
        returnType: funcInfo.return_type,
        source: filePath,
        line: funcInfo.line_number,
        description: funcInfo.docstring,
        isAsync: funcInfo.is_async,
        isPrivate: isPrivateApi(funcName),
      });
    }
  }

  return apis;
}

// ============================================================================
// Conflict Detector
// ============================================================================

/**
 * Conflict Detector Analyzer.
 *
 * Detects conflicts between documentation and code by comparing API signatures.
 *
 * @example
 * ```ts
 * const detector = createConflictDetector();
 *
 * // Prepare input with docs and code data in manifest metadata
 * const input = {
 *   bundleRoot: '/path/to/bundle',
 *   files: [],
 *   manifest: {
 *     ...manifest,
 *     metadata: {
 *       docsData: { pages: [...] },
 *       codeData: { code_analysis: { files: [...] } },
 *     },
 *   },
 * };
 *
 * const result = await detector.analyze(input);
 * console.log(result.data?.conflicts);
 * ```
 */
export class ConflictDetector extends BaseAnalyzer<ConflictOutput, ConflictAnalyzerOptions> {
  readonly name = 'conflict-detector';
  readonly version = '1.0.0';
  readonly description = 'Detects conflicts between documentation and code';

  protected getDefaultOptions(): Required<ConflictAnalyzerOptions> {
    return DEFAULT_CONFLICT_OPTIONS;
  }

  /**
   * Analyze for conflicts between documentation and code.
   */
  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput<ConflictOutput>> {
    const startTime = Date.now();
    const errors: AnalyzerErrorInfo[] = [];

    // Validate input
    const validationErrors = this.validateInput(input);
    if (validationErrors.length > 0) {
      return this.createFailureOutput(validationErrors, this.createMetadata(startTime, 0));
    }

    const logger = this.getLogger();
    logger.info('Starting conflict detection', {
      bundleRoot: input.bundleRoot,
    });

    try {
      // Extract docs and code data from manifest metadata
      const metadata = (input.manifest as { metadata?: Record<string, unknown> }).metadata ?? {};
      const docsData = (metadata.docsData ?? { pages: [], apis: [] }) as DocsData;
      const codeData = (metadata.codeData ?? { apis: [] }) as CodeData;

      // Extract APIs from both sources
      const docsApis = extractDocsApis(docsData);
      const codeApis = extractCodeApis(codeData);

      logger.info('API extraction complete', {
        docsApiCount: docsApis.size,
        codeApiCount: codeApis.size,
      });

      // Filter out private APIs if requested
      if (!this.options.includePrivateApis) {
        for (const [name, api] of docsApis) {
          if (api.isPrivate) docsApis.delete(name);
        }
        for (const [name, api] of codeApis) {
          if (api.isPrivate) codeApis.delete(name);
        }
      }

      // Detect conflicts
      const conflicts: Conflict[] = [];

      // 1. Find APIs missing in documentation
      if (this.shouldDetect('missing_in_docs')) {
        const missing = this.findMissingInDocs(docsApis, codeApis);
        conflicts.push(...missing);
      }

      // 2. Find APIs missing in code
      if (this.shouldDetect('missing_in_code')) {
        const missing = this.findMissingInCode(docsApis, codeApis);
        conflicts.push(...missing);
      }

      // 3. Find signature mismatches
      if (this.shouldDetect('signature_mismatch')) {
        const mismatches = this.findSignatureMismatches(docsApis, codeApis);
        conflicts.push(...mismatches);
      }

      // Calculate common APIs
      const commonApis = new Set<string>();
      for (const name of docsApis.keys()) {
        if (codeApis.has(name)) {
          commonApis.add(name);
        }
      }

      // Generate summary
      const summary = this.generateSummary(conflicts);

      const report: ConflictReport = {
        conflicts,
        summary,
        docsApiCount: docsApis.size,
        codeApiCount: codeApis.size,
        commonApiCount: commonApis.size,
      };

      logger.info('Conflict detection complete', {
        totalConflicts: conflicts.length,
        docsApiCount: docsApis.size,
        codeApiCount: codeApis.size,
        durationMs: Date.now() - startTime,
      });

      // Generate text summary and highlights
      const textSummary = this.generateTextSummary(summary, docsApis.size, codeApis.size);
      const highlights = this.generateHighlights(conflicts);

      return this.createSuccessOutput(
        report,
        this.createMetadata(startTime, docsApis.size + codeApis.size),
        textSummary,
        highlights,
        errors.length > 0 ? errors : undefined
      );
    } catch (err) {
      logger.error(
        'Conflict detection failed',
        err instanceof Error ? err : new Error(String(err))
      );

      return this.createFailureOutput(
        [this.errorToInfo(err)],
        this.createMetadata(startTime, 0)
      );
    }
  }

  /**
   * Checks if a conflict type should be detected.
   */
  private shouldDetect(type: ConflictType): boolean {
    const { conflictTypes } = this.options;
    return conflictTypes.length === 0 || conflictTypes.includes(type);
  }

  /**
   * Finds APIs that exist in code but not in documentation.
   */
  private findMissingInDocs(
    docsApis: Map<string, APIInfo>,
    codeApis: Map<string, APIInfo>
  ): Conflict[] {
    const conflicts: Conflict[] = [];

    for (const [apiName, codeInfo] of codeApis) {
      if (!docsApis.has(apiName)) {
        const isPrivate = codeInfo.isPrivate ?? false;
        const severity: ConflictSeverity = this.options.lowerPrivateSeverity && isPrivate
          ? 'low'
          : 'medium';

        const conflict: Conflict = {
          type: 'missing_in_docs',
          severity,
          apiName,
          codeInfo,
          difference: `API exists in code (${codeInfo.source ?? 'unknown'}) but not found in documentation`,
        };

        if (this.options.includeSuggestions) {
          conflict.suggestion = isPrivate
            ? 'Consider if this internal API should be documented'
            : 'Add documentation for this API';
        }

        conflicts.push(conflict);
      }
    }

    this.getLogger().debug('Missing in docs detection complete', { count: conflicts.length });
    return conflicts;
  }

  /**
   * Finds APIs that are documented but don't exist in code.
   */
  private findMissingInCode(
    docsApis: Map<string, APIInfo>,
    codeApis: Map<string, APIInfo>
  ): Conflict[] {
    const conflicts: Conflict[] = [];

    for (const [apiName, docsInfo] of docsApis) {
      if (!codeApis.has(apiName)) {
        const conflict: Conflict = {
          type: 'missing_in_code',
          severity: 'high', // This is serious - documented but doesn't exist
          apiName,
          docsInfo,
          difference: `API documented (${docsInfo.sourceUrl ?? 'unknown'}) but not found in code`,
        };

        if (this.options.includeSuggestions) {
          conflict.suggestion = 'Update documentation to remove this API, or add it to codebase';
        }

        conflicts.push(conflict);
      }
    }

    this.getLogger().debug('Missing in code detection complete', { count: conflicts.length });
    return conflicts;
  }

  /**
   * Finds APIs where signature differs between docs and code.
   */
  private findSignatureMismatches(
    docsApis: Map<string, APIInfo>,
    codeApis: Map<string, APIInfo>
  ): Conflict[] {
    const conflicts: Conflict[] = [];

    // Find APIs that exist in both
    for (const [apiName, docsInfo] of docsApis) {
      const codeInfo = codeApis.get(apiName);
      if (!codeInfo) continue;

      const mismatch = this.compareSignatures(docsInfo, codeInfo);
      if (mismatch) {
        const conflict: Conflict = {
          type: 'signature_mismatch',
          severity: mismatch.severity,
          apiName,
          docsInfo,
          codeInfo,
          difference: mismatch.difference,
        };

        if (this.options.includeSuggestions) {
          conflict.suggestion = mismatch.suggestion;
        }

        conflicts.push(conflict);
      }
    }

    this.getLogger().debug('Signature mismatch detection complete', { count: conflicts.length });
    return conflicts;
  }

  /**
   * Compares signatures between docs and code.
   * Returns mismatch details if conflict found, null otherwise.
   */
  private compareSignatures(
    docsInfo: APIInfo,
    codeInfo: APIInfo
  ): { severity: ConflictSeverity; difference: string; suggestion: string } | null {
    const docsParams = docsInfo.parameters ?? [];
    const codeParams = codeInfo.parameters ?? [];

    // Compare parameter counts
    if (docsParams.length !== codeParams.length) {
      return {
        severity: 'medium',
        difference: `Parameter count mismatch: docs has ${docsParams.length}, code has ${codeParams.length}`,
        suggestion: `Documentation shows ${docsParams.length} parameters, but code has ${codeParams.length}`,
      };
    }

    // Compare parameter names and types
    for (let i = 0; i < docsParams.length; i++) {
      const docParam = docsParams[i];
      const codeParam = codeParams[i];
      if (!docParam || !codeParam) continue;

      const docName = docParam.name;
      const codeName = codeParam.name;

      // Parameter name mismatch
      if (docName !== codeName) {
        // Use fuzzy matching for slight variations
        const similarity = stringSimilarity(docName, codeName);
        if (similarity < this.options.nameSimilarityThreshold) {
          return {
            severity: 'medium',
            difference: `Parameter ${i + 1} name mismatch: '${docName}' in docs vs '${codeName}' in code`,
            suggestion: `Update documentation to use parameter name '${codeName}'`,
          };
        }
      }

      // Type mismatch
      const docType = docParam.type;
      const codeType = codeParam.type;

      if (docType && codeType && docType !== codeType) {
        return {
          severity: 'low',
          difference: `Parameter '${docName}' type mismatch: '${docType}' in docs vs '${codeType}' in code`,
          suggestion: `Verify correct type for parameter '${docName}'`,
        };
      }
    }

    // Compare return types if both have them
    const docsReturn = docsInfo.returnType;
    const codeReturn = codeInfo.returnType;

    if (docsReturn && codeReturn && docsReturn !== codeReturn) {
      return {
        severity: 'low',
        difference: `Return type mismatch: '${docsReturn}' in docs vs '${codeReturn}' in code`,
        suggestion: 'Verify correct return type',
      };
    }

    return null;
  }

  /**
   * Generates summary statistics for conflicts.
   */
  private generateSummary(conflicts: Conflict[]): ConflictSummary {
    const byType: Record<ConflictType, number> = {
      missing_in_docs: 0,
      missing_in_code: 0,
      signature_mismatch: 0,
    };

    const bySeverity: Record<ConflictSeverity, number> = {
      low: 0,
      medium: 0,
      high: 0,
    };

    const apisAffected = new Set<string>();

    for (const conflict of conflicts) {
      byType[conflict.type]++;
      bySeverity[conflict.severity]++;
      apisAffected.add(conflict.apiName);
    }

    return {
      total: conflicts.length,
      byType,
      bySeverity,
      apisAffected: apisAffected.size,
    };
  }

  /**
   * Generate a text summary for the output.
   */
  private generateTextSummary(
    summary: ConflictSummary,
    docsApiCount: number,
    codeApiCount: number
  ): string {
    if (summary.total === 0) {
      return `No conflicts detected between ${docsApiCount} documented APIs and ${codeApiCount} code APIs.`;
    }

    const parts: string[] = [];
    parts.push(`Found ${summary.total} conflicts affecting ${summary.apisAffected} APIs.`);

    const highSeverity = summary.bySeverity.high ?? 0;
    if (highSeverity > 0) {
      parts.push(`${highSeverity} high severity issues require attention.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate highlights from high-severity conflicts.
   */
  private generateHighlights(conflicts: Conflict[]): AnalyzerHighlight[] {
    // Sort by severity (high > medium > low)
    const severityOrder: Record<ConflictSeverity, number> = {
      high: 3,
      medium: 2,
      low: 1,
    };

    const sorted = [...conflicts].sort(
      (a, b) => severityOrder[b.severity] - severityOrder[a.severity]
    );

    // Convert to highlights (top 5)
    return sorted.slice(0, 5).map((c) => ({
      type: c.type,
      description: `${c.apiName}: ${c.difference}`,
      confidence: severityOrder[c.severity] / 3,
      file: c.codeInfo?.source ?? c.docsInfo?.sourceUrl,
      line: c.codeInfo?.line,
      context: {
        severity: c.severity,
        suggestion: c.suggestion,
      },
    }));
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ConflictDetector instance.
 *
 * @param options - Optional configuration options
 * @returns New detector instance
 *
 * @example
 * ```ts
 * const detector = createConflictDetector({
 *   conflictTypes: ['missing_in_code', 'signature_mismatch'],
 *   includeSuggestions: true,
 * });
 * const result = await detector.analyze(input);
 * ```
 */
export function createConflictDetector(
  options?: Partial<ConflictAnalyzerOptions>
): ConflictDetector {
  return new ConflictDetector(options);
}

/**
 * Convenience function to detect conflicts.
 * Creates a detector instance and runs analysis in one call.
 *
 * @param input - Analyzer input
 * @param options - Optional configuration options
 * @returns Analysis result
 */
export async function detectConflicts(
  input: AnalyzerInput,
  options?: Partial<ConflictAnalyzerOptions>
): Promise<AnalyzerOutput<ConflictOutput>> {
  const detector = createConflictDetector(options);
  return detector.analyze(input);
}
