/**
 * preflight_read_file - Read file(s) from bundle.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { shouldRegisterTool } from './types.js';
import { findBundleStorageDir, getBundlePathsForId } from '../../../bundle/service.js';
import { readManifest } from '../../../bundle/manifest.js';
import { safeJoin } from '../../../mcp/uris.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';
import { BundleNotFoundError } from '../../../errors.js';
import { extractOutlineWasm, type SymbolOutline } from '../../../ast/index.js';

// ==========================================================================
// preflight_read_file
// ==========================================================================

/**
 * Register preflight_read_file tool.
 */
export function registerReadFileTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_read_file', coreOnly)) return;

  server.registerTool(
    'preflight_read_file',
    {
      title: 'Read bundle file(s)',
      description:
        'Read specific file(s) from a bundle.\n\n' +
        '**Common usage:**\n' +
        '- Read code: `{bundleId, file: "repos/owner/repo/norm/src/main.ts"}`\n' +
        '- Read PDF content: `{bundleId, file: "pdf_xxx.md"}`\n' +
        '- Read web page: `{bundleId, file: "repos/web/.../norm/docs/intro.md"}`\n' +
        '- Read specific lines: `{bundleId, file: "...", ranges: ["50-100"]}`\n\n' +
        '**When to use:** You know the exact file path (from search results or tree)\n\n' +
        '**Use `preflight_get_overview` instead if:** you want overview first\n' +
        '**Use `preflight_search_and_read` instead if:** you need to find content first\n\n' +
        'Triggers: "读取", "read", "查看", "阅读页面", "read page"',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to read.'),
        file: z.string().optional().describe('Specific file to read (e.g., "deps/dependency-graph.json"). If omitted, uses mode-based batch reading.'),
        mode: z.enum(['light', 'full', 'core']).optional().default('light').describe(
          'Batch reading mode (used when file param is omitted). ' +
          'light: OVERVIEW + START_HERE + AGENTS + manifest only (recommended, saves tokens). ' +
          'full: includes README and deps graph too. ' +
          'core: ⭐ NEW - reads core source files (top imported + entry points) with outline and content.'
        ),
        coreOptions: z.object({
          maxFiles: z.number().int().min(1).max(10).default(5).describe('Max core files to read.'),
          includeOutline: z.boolean().default(true).describe('Include symbol outline for each file.'),
          includeContent: z.boolean().default(true).describe('Include full file content.'),
          tokenBudget: z.number().int().optional().describe('Approximate token budget (chars/4). Files exceeding budget return outline only.'),
        }).optional().describe('Options for mode="core". Controls which files and how much content to return.'),
        includeReadme: z.boolean().optional().default(false).describe('Include repo README files in batch mode (can be large).'),
        includeDepsGraph: z.boolean().optional().default(false).describe('Include deps/dependency-graph.json in batch mode.'),
        withLineNumbers: z.boolean().optional().default(false).describe('If true, prefix each line with line number in "N|" format for evidence citation.'),
        ranges: z.array(z.string()).optional().describe('Line ranges to read, e.g. ["20-80", "100-120"]. Each range is "start-end" (1-indexed, inclusive). If omitted, reads entire file.'),
        outline: z.boolean().optional().default(false).describe(
          'If true, return symbol outline instead of file content. ' +
          'Returns function/class/method/interface/type/enum with line ranges. ' +
          'Saves tokens by showing code structure without full content. ' +
          'Supports: .ts, .tsx, .js, .jsx, .py, .go, .rs files.'
        ),
        symbol: z.string().optional().describe(
          'Read a specific symbol (function/class/method) by name. ' +
          'Format: "functionName" or "ClassName" or "ClassName.methodName". ' +
          'Automatically locates and returns the symbol\'s code with context. ' +
          'Requires outline-supported file types (.ts, .tsx, .js, .jsx, .py).'
        ),
      },
      outputSchema: {
        bundleId: z.string(),
        mode: z.enum(['light', 'full']).optional(),
        file: z.string().optional(),
        content: z.string().optional(),
        files: z.record(z.string(), z.string().nullable()).optional(),
        sections: z.array(z.string()).optional(),
        lineInfo: z.object({
          totalLines: z.number(),
          ranges: z.array(z.object({ start: z.number(), end: z.number() })),
        }).optional(),
        outline: z.array(z.object({
          kind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'variable']),
          name: z.string(),
          signature: z.string().optional(),
          range: z.object({ startLine: z.number(), endLine: z.number() }),
          exported: z.boolean(),
          children: z.array(z.any()).optional(),
        })).optional(),
        language: z.string().optional(),
        coreFiles: z.array(z.object({
          path: z.string(),
          reason: z.string(),
          outline: z.array(z.any()).optional(),
          content: z.string().optional(),
          language: z.string().optional(),
          charCount: z.number(),
        })).optional(),
        coreStats: z.object({
          totalFiles: z.number(),
          totalChars: z.number(),
          truncatedFiles: z.number(),
        }).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }

        const paths = getBundlePathsForId(storageDir, args.bundleId);
        const bundleRoot = paths.rootDir;

        // Helper: parse range string "start-end" into { start, end }
        const parseRange = (rangeStr: string): { start: number; end: number } | null => {
          const match = rangeStr.match(/^(\d+)-(\d+)$/);
          if (!match) return null;
          const start = parseInt(match[1]!, 10);
          const end = parseInt(match[2]!, 10);
          if (start < 1 || end < start) return null;
          return { start, end };
        };

        // Helper: format content with optional line numbers and ranges
        const formatContent = (
          rawContent: string,
          withLineNumbers: boolean,
          ranges?: Array<{ start: number; end: number }>
        ): { content: string; lineInfo: { totalLines: number; ranges: Array<{ start: number; end: number }> } } => {
          const lines = rawContent.replace(/\r\n/g, '\n').split('\n');
          const totalLines = lines.length;

          let selectedLines: Array<{ lineNo: number; text: string }> = [];

          if (ranges && ranges.length > 0) {
            for (const range of ranges) {
              const start = Math.max(1, range.start);
              const end = Math.min(totalLines, range.end);
              for (let i = start; i <= end; i++) {
                selectedLines.push({ lineNo: i, text: lines[i - 1] ?? '' });
              }
            }
          } else {
            selectedLines = lines.map((text, idx) => ({ lineNo: idx + 1, text }));
          }

          const formatted = withLineNumbers
            ? selectedLines.map((l) => `${l.lineNo}|${l.text}`).join('\n')
            : selectedLines.map((l) => l.text).join('\n');

          const actualRanges = ranges && ranges.length > 0
            ? ranges.map((r) => ({ start: Math.max(1, r.start), end: Math.min(totalLines, r.end) }))
            : [{ start: 1, end: totalLines }];

          return { content: formatted, lineInfo: { totalLines, ranges: actualRanges } };
        };

        // Single file mode
        if (args.file) {
          const absPath = safeJoin(bundleRoot, args.file);
          const rawContent = await fs.readFile(absPath, 'utf8');
          const normalizedContent = rawContent.replace(/\r\n/g, '\n');

          // Outline mode
          if (args.outline) {
            const outlineResult = await extractOutlineWasm(args.file, normalizedContent);
            
            if (!outlineResult) {
              return {
                content: [{ type: 'text', text: `[${args.file}] Outline not supported for this file type. Supported: .ts, .tsx, .js, .jsx` }],
                structuredContent: {
                  bundleId: args.bundleId,
                  file: args.file,
                  outline: null,
                  language: null,
                },
              };
            }
            
            const formatOutlineText = (symbols: SymbolOutline[], indent = ''): string[] => {
              const lines: string[] = [];
              for (let i = 0; i < symbols.length; i++) {
                const sym = symbols[i]!;
                const isLast = i === symbols.length - 1;
                const prefix = indent + (isLast ? '└── ' : '├── ');
                const exportMark = sym.exported ? '⚡' : '';
                const sig = sym.signature ? sym.signature : '';
                lines.push(`${prefix}${exportMark}${sym.kind} ${sym.name}${sig} :${sym.range.startLine}-${sym.range.endLine}`);
                
                if (sym.children && sym.children.length > 0) {
                  const childIndent = indent + (isLast ? '    ' : '│   ');
                  lines.push(...formatOutlineText(sym.children, childIndent));
                }
              }
              return lines;
            };
            
            const outlineText = formatOutlineText(outlineResult.outline);
            const totalSymbols = outlineResult.outline.length;
            const header = `[${args.file}] Outline (${totalSymbols} top-level symbols, ${outlineResult.language}):\n`;
            
            return {
              content: [{ type: 'text', text: header + outlineText.join('\n') }],
              structuredContent: {
                bundleId: args.bundleId,
                file: args.file,
                outline: outlineResult.outline,
                language: outlineResult.language,
              },
            };
          }

          // Symbol-based reading
          if (args.symbol) {
            const outlineResult = await extractOutlineWasm(args.file, normalizedContent);
            
            if (!outlineResult) {
              return {
                content: [{ type: 'text', text: `[${args.file}] Symbol lookup not supported for this file type. Supported: .ts, .tsx, .js, .jsx, .py` }],
                structuredContent: { bundleId: args.bundleId, file: args.file, error: 'unsupported_file_type' },
              };
            }
            
            const parts = args.symbol.split('.');
            const targetName = parts[0]!;
            const methodName = parts[1];
            
            let foundSymbol: SymbolOutline | undefined;
            
            for (const sym of outlineResult.outline) {
              if (sym.name === targetName) {
                if (methodName && sym.children) {
                  const method = sym.children.find(c => c.name === methodName);
                  if (method) {
                    foundSymbol = method;
                    break;
                  }
                } else {
                  foundSymbol = sym;
                  break;
                }
              }
            }
            
            if (!foundSymbol) {
              const available = outlineResult.outline.map(s => {
                if (s.children && s.children.length > 0) {
                  return `${s.name} (${s.kind}, methods: ${s.children.map(c => c.name).join(', ')})`;
                }
                return `${s.name} (${s.kind})`;
              }).join(', ');
              
              return {
                content: [{ type: 'text', text: `[${args.file}] Symbol "${args.symbol}" not found.\n\nAvailable symbols: ${available}` }],
                structuredContent: { bundleId: args.bundleId, file: args.file, error: 'symbol_not_found', available: outlineResult.outline.map(s => s.name) },
              };
            }
            
            const contextLines = 2;
            const startLine = Math.max(1, foundSymbol.range.startLine - contextLines);
            const endLine = foundSymbol.range.endLine;
            
            const { content, lineInfo } = formatContent(rawContent, true, [{ start: startLine, end: endLine }]);
            
            const header = `[${args.file}:${startLine}-${endLine}] ${foundSymbol.kind} ${foundSymbol.name}${foundSymbol.signature || ''}\n\n`;
            
            return {
              content: [{ type: 'text', text: header + content }],
              structuredContent: {
                bundleId: args.bundleId,
                file: args.file,
                symbol: foundSymbol,
                content,
                lineInfo,
              },
            };
          }

          // Parse ranges if provided
          let parsedRanges: Array<{ start: number; end: number }> | undefined;
          if (args.ranges && args.ranges.length > 0) {
            parsedRanges = [];
            for (const rangeStr of args.ranges) {
              const parsed = parseRange(rangeStr);
              if (!parsed) {
                throw new Error(`Invalid range format: "${rangeStr}". Expected "start-end" (e.g., "20-80").`);
              }
              parsedRanges.push(parsed);
            }
            parsedRanges.sort((a, b) => a.start - b.start);
          }

          const { content, lineInfo } = formatContent(rawContent, args.withLineNumbers ?? false, parsedRanges);

          const out = {
            bundleId: args.bundleId,
            file: args.file,
            content,
            lineInfo,
          };

          let textOutput = content;
          if (parsedRanges && parsedRanges.length > 0) {
            const rangeStr = parsedRanges.map((r) => `${r.start}-${r.end}`).join(', ');
            textOutput = `[${args.file}:${rangeStr}] (${lineInfo.totalLines} total lines)\n\n${content}`;
          }

          return {
            content: [{ type: 'text', text: textOutput }],
            structuredContent: out,
          };
        }

        // Batch mode: read key files based on mode
        const mode = args.mode ?? 'light';
        
        // MODE: CORE
        if (mode === 'core') {
          const coreOpts = (args.coreOptions ?? {}) as {
            maxFiles?: number;
            includeOutline?: boolean;
            includeContent?: boolean;
            tokenBudget?: number;
          };
          const maxFiles = coreOpts.maxFiles ?? 5;
          const includeOutline = coreOpts.includeOutline ?? true;
          const includeContent = coreOpts.includeContent ?? true;
          const tokenBudget = coreOpts.tokenBudget;
          const charBudget = tokenBudget ? tokenBudget * 4 : undefined;
          
          const coreFileCandidates: Array<{ path: string; reason: string; score: number }> = [];
          
          const entryPointPatterns = [
            { pattern: /\/(index|main)\.(ts|js|tsx|jsx)$/i, reason: 'Entry point', score: 50 },
            { pattern: /\/app\.(ts|js|tsx|jsx)$/i, reason: 'App entry', score: 40 },
            { pattern: /\/server\.(ts|js)$/i, reason: 'Server entry', score: 40 },
            { pattern: /\/types\.(ts|d\.ts)$/i, reason: 'Type definitions', score: 30 },
          ];
          
          const scanEntryPoints = async (dir: string, relPath: string): Promise<void> => {
            try {
              const entries = await fs.readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.name.startsWith('.') || ['node_modules', '__pycache__', 'dist', 'build'].includes(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);
                const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
                
                if (entry.isFile()) {
                  for (const ep of entryPointPatterns) {
                    if (ep.pattern.test('/' + entryRelPath)) {
                      const existing = coreFileCandidates.find(c => c.path.endsWith(entry.name) || c.path === entryRelPath);
                      if (!existing) {
                        coreFileCandidates.push({ path: entryRelPath, reason: ep.reason, score: ep.score });
                      }
                    }
                  }
                } else if (entry.isDirectory() && relPath.split('/').length < 6) {
                  await scanEntryPoints(fullPath, entryRelPath);
                }
              }
            } catch { /* ignore */ }
          };
          
          await scanEntryPoints(paths.reposDir, 'repos');
          
          coreFileCandidates.sort((a, b) => b.score - a.score);
          const seenPaths = new Set<string>();
          const uniqueCandidates = coreFileCandidates.filter(c => {
            const key = c.path.split('/').pop() ?? c.path;
            if (seenPaths.has(key)) return false;
            seenPaths.add(key);
            return true;
          }).slice(0, maxFiles);
          
          const coreFilesResult: Array<{
            path: string;
            reason: string;
            outline?: SymbolOutline[];
            content?: string;
            language?: string;
            charCount: number;
          }> = [];
          
          let totalChars = 0;
          let truncatedFiles = 0;
          
          for (const candidate of uniqueCandidates) {
            let actualPath = candidate.path;
            let absPath: string;
            
            const pathsToTry = [
              candidate.path,
              `repos/${candidate.path}`,
              candidate.path.startsWith('repos/') ? candidate.path : null,
            ].filter(Boolean) as string[];
            
            let fileContent: string | null = null;
            for (const tryPath of pathsToTry) {
              try {
                absPath = safeJoin(bundleRoot, tryPath);
                fileContent = await fs.readFile(absPath, 'utf8');
                actualPath = tryPath;
                break;
              } catch { /* try next */ }
            }
            
            if (!fileContent) continue;
            
            const charCount = fileContent.length;
            const withinBudget = !charBudget || (totalChars + charCount <= charBudget);
            
            const result: typeof coreFilesResult[number] = {
              path: actualPath,
              reason: candidate.reason,
              charCount,
            };
            
            if (includeOutline) {
              const outlineResult = await extractOutlineWasm(actualPath, fileContent);
              if (outlineResult) {
                result.outline = outlineResult.outline;
                result.language = outlineResult.language;
              }
            }
            
            if (includeContent && withinBudget) {
              result.content = fileContent;
              totalChars += charCount;
            } else if (includeContent && !withinBudget) {
              truncatedFiles++;
            }
            
            coreFilesResult.push(result);
          }
          
          const textParts: string[] = [];
          textParts.push(`[Mode: core] ${coreFilesResult.length} core files identified`);
          textParts.push(`Total: ${totalChars} chars (~${Math.round(totalChars / 4)} tokens)`);
          if (truncatedFiles > 0) {
            textParts.push(`⚠️ ${truncatedFiles} file(s) exceeded token budget - showing outline only`);
          }
          textParts.push('');
          
          for (const cf of coreFilesResult) {
            textParts.push(`=== ${cf.path} (${cf.reason}) ===`);
            
            if (cf.outline && cf.outline.length > 0) {
              textParts.push(`[Outline - ${cf.outline.length} symbols]`);
              for (const sym of cf.outline.slice(0, 10)) {
                const exp = sym.exported ? '⚡' : '';
                textParts.push(`  ${exp}${sym.kind} ${sym.name}${sym.signature || ''} :${sym.range.startLine}-${sym.range.endLine}`);
              }
              if (cf.outline.length > 10) {
                textParts.push(`  ... and ${cf.outline.length - 10} more symbols`);
              }
            }
            
            if (cf.content) {
              textParts.push(`[Content - ${cf.charCount} chars]`);
              textParts.push('```' + (cf.language || ''));
              textParts.push(cf.content);
              textParts.push('```');
            }
            textParts.push('');
          }
          
          const out = {
            bundleId: args.bundleId,
            mode: 'core' as const,
            coreFiles: coreFilesResult,
            coreStats: {
              totalFiles: coreFilesResult.length,
              totalChars,
              truncatedFiles,
            },
          };
          
          return {
            content: [{ type: 'text', text: textParts.join('\n') }],
            structuredContent: out,
          };
        }
        
        // MODE: LIGHT / FULL
        const includeReadme = args.includeReadme ?? (mode === 'full');
        const includeDepsGraph = args.includeDepsGraph ?? (mode === 'full');
        
        // Check if this is a document bundle (has docs/ directory)
        const manifest = await readManifest(paths.manifestPath);
        const isDocumentBundle = manifest.type === 'document';
        
        if (isDocumentBundle) {
          // For document bundles, read docs/*.md files directly
          const docsDir = safeJoin(bundleRoot, 'docs');
          const files: Record<string, string | null> = {};
          const sections: string[] = ['manifest.json'];
          
          files['manifest.json'] = JSON.stringify(manifest, null, 2);
          
          try {
            const docFiles = await fs.readdir(docsDir);
            for (const docFile of docFiles) {
              if (docFile.endsWith('.md')) {
                const docPath = `docs/${docFile}`;
                try {
                  const absPath = safeJoin(bundleRoot, docPath);
                  const content = await fs.readFile(absPath, 'utf8');
                  files[docPath] = content;
                  sections.push(docPath);
                } catch {
                  files[docPath] = null;
                }
              }
            }
          } catch {
            // docs dir doesn't exist
          }
          
          const textParts: string[] = [];
          textParts.push(`[Document Bundle] ${sections.length} file(s)`);
          textParts.push('');
          
          for (const [filePath, content] of Object.entries(files)) {
            if (content) {
              // For large docs, show first 500 lines
              const lines = content.split('\n');
              const preview = lines.length > 500 ? lines.slice(0, 500).join('\n') + `\n\n... (${lines.length - 500} more lines, use file="${filePath}" to read full)` : content;
              textParts.push(`=== ${filePath} ===\n${preview}`);
            }
          }
          
          const out = { bundleId: args.bundleId, mode, files, sections, isDocumentBundle: true };
          return {
            content: [{ type: 'text', text: textParts.join('\n') || '(no files found)' }],
            structuredContent: out,
          };
        }
        
        const coreFiles = ['OVERVIEW.md', 'START_HERE.md', 'AGENTS.md', 'manifest.json'];
        const keyFiles = [...coreFiles];
        
        if (includeDepsGraph) {
          keyFiles.push('deps/dependency-graph.json');
        }
        
        const files: Record<string, string | null> = {};
        const sections: string[] = [];

        for (const file of keyFiles) {
          try {
            const absPath = safeJoin(bundleRoot, file);
            files[file] = await fs.readFile(absPath, 'utf8');
            sections.push(file);
          } catch {
            files[file] = null;
          }
        }

        if (includeReadme) {
          try {
            const manifest = await readManifest(paths.manifestPath);
            for (const repo of manifest.repos ?? []) {
              if (!repo.id) continue;
              const [owner, repoName] = repo.id.split('/');
              if (!owner || !repoName) continue;

              const readmeNames = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
              for (const readmeName of readmeNames) {
                const readmePath = `repos/${owner}/${repoName}/norm/${readmeName}`;
                try {
                  const absPath = safeJoin(bundleRoot, readmePath);
                  files[readmePath] = await fs.readFile(absPath, 'utf8');
                  sections.push(readmePath);
                  break;
                } catch {
                  // Try next
                }
              }
            }
          } catch {
            // Ignore manifest read errors
          }
        }

        const textParts: string[] = [];
        textParts.push(`[Mode: ${mode}] Sections: ${sections.join(', ')}`);
        textParts.push('');
        
        for (const [filePath, content] of Object.entries(files)) {
          if (content) {
            textParts.push(`=== ${filePath} ===\n${content}`);
          }
        }
        
        if (mode === 'light') {
          textParts.push('');
          textParts.push('---');
          textParts.push('💡 To include README: set includeReadme=true');
          textParts.push('💡 To include dependency graph: set includeDepsGraph=true');
          textParts.push('💡 For all content: set mode="full"');
          textParts.push('💡 ⭐ For core source code: set mode="core"');
        }

        const out = { bundleId: args.bundleId, mode, files, sections };
        return {
          content: [{ type: 'text', text: textParts.join('\n') || '(no files found)' }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
