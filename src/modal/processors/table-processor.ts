/**
 * Table processor for structured data extraction.
 *
 * This module provides capabilities for:
 * - Extracting tables from various document formats
 * - Converting tables to different formats (JSON, CSV, Markdown)
 * - Analyzing table structure
 *
 * @module modal/processors/table-processor
 */

import type { ModalContent } from '../types.js';
import type { ParsedTableData } from '../../parser/types.js';
import { createModuleLogger } from '../../logging/logger.js';

const logger = createModuleLogger('table-processor');

// ============================================================================
// Types
// ============================================================================

/**
 * Table processor configuration.
 */
export interface TableProcessorConfig {
  /** Whether to include headers in output */
  includeHeaders?: boolean;
  
  /** Output format */
  outputFormat?: 'json' | 'csv' | 'markdown' | 'text';
  
  /** Maximum rows to process */
  maxRows?: number;
  
  /** Whether to trim cell values */
  trimValues?: boolean;
}

/**
 * Table analysis result.
 */
export interface TableAnalysis {
  /** Number of rows */
  rowCount: number;
  
  /** Number of columns */
  colCount: number;
  
  /** Column types (detected) */
  columnTypes?: ColumnType[];
  
  /** Whether table has header row */
  hasHeaders: boolean;
  
  /** Table summary */
  summary?: string;
}

/**
 * Detected column type.
 */
export interface ColumnType {
  name: string;
  type: 'string' | 'number' | 'date' | 'boolean' | 'mixed';
  nullable: boolean;
}

/**
 * Processing result for table operations.
 */
export interface TableProcessResult {
  /** Whether processing succeeded */
  success: boolean;
  
  /** Extracted/formatted table content */
  extractedContext?: string;
  
  /** Confidence score (0-1) */
  confidence?: number;
  
  /** Error message if failed */
  error?: string;
  
  /** Processing time in milliseconds */
  processingTimeMs: number;
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Table Processor Implementation
// ============================================================================

/**
 * Table processor for structured data extraction.
 */
export class TableProcessor {
  private config: TableProcessorConfig;

  constructor(config: TableProcessorConfig = {}) {
    this.config = {
      includeHeaders: true,
      outputFormat: 'text',
      trimValues: true,
      ...config,
    };
  }

  /**
   * Process table content for modal pipeline.
   */
  async processTable(content: ModalContent): Promise<TableProcessResult> {
    const startTime = Date.now();

    try {
      if (content.type !== 'table') {
        return {
          success: false,
          error: 'Content is not a table',
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Parse table data
      let tableData: ParsedTableData;
      
      if (typeof content.content === 'object' && content.content !== null && 'rows' in content.content) {
        tableData = content.content as unknown as ParsedTableData;
      } else if (typeof content.content === 'string') {
        // Try to parse as JSON
        try {
          tableData = JSON.parse(content.content);
        } catch {
          // Try to parse as text table
          tableData = this.parseTextTable(content.content);
        }
      } else {
        return {
          success: false,
          error: 'Invalid table content format',
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Analyze table
      const analysis = this.analyzeTable(tableData);

      // Convert to output format
      const extractedContext = this.formatTable(tableData);

      // Generate summary
      const summary = this.generateTableSummary(tableData, analysis);

      return {
        success: true,
        extractedContext,
        confidence: 1.0,
        processingTimeMs: Date.now() - startTime,
        metadata: {
          analysis,
          summary,
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Table processing failed: ${errMsg}`);
      
      return {
        success: false,
        error: errMsg,
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Parse text-based table content.
   */
  private parseTextTable(text: string): ParsedTableData {
    const lines = text.split('\n').filter(l => l.trim());
    const rows: string[][] = [];
    
    // Detect delimiter (tab, comma, or multiple spaces)
    const firstLine = lines[0] || '';
    let delimiter: RegExp;
    
    if (firstLine.includes('\t')) {
      delimiter = /\t/;
    } else if (firstLine.includes(',')) {
      delimiter = /,/;
    } else {
      delimiter = /\s{2,}/;
    }

    for (const line of lines) {
      const cells = line.split(delimiter).map(c => 
        this.config.trimValues ? c.trim() : c
      );
      if (cells.some(c => c.length > 0)) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) {
      return {
        rows: [],
        rowCount: 0,
        colCount: 0,
      };
    }

    // Assume first row is header
    const headers = rows[0];
    const dataRows = rows.slice(1);

    return {
      headers,
      rows: dataRows,
      rowCount: dataRows.length,
      colCount: headers?.length ?? 0,
    };
  }

  /**
   * Analyze table structure and content.
   */
  analyzeTable(table: ParsedTableData): TableAnalysis {
    const columnTypes: ColumnType[] = [];
    const colCount = table.headers?.length || table.rows[0]?.length || 0;

    // Analyze each column
    for (let col = 0; col < colCount; col++) {
      const columnName = table.headers?.[col] ?? `Column ${col + 1}`;
      const values = table.rows.map(row => row[col]).filter((v): v is string => v !== undefined);
      
      const type = this.detectColumnType(values);
      const nullable = values.some(v => !v || v.trim() === '');

      columnTypes.push({
        name: columnName,
        type,
        nullable,
      });
    }

    return {
      rowCount: table.rowCount,
      colCount: table.colCount,
      columnTypes,
      hasHeaders: !!table.headers && table.headers.length > 0,
    };
  }

  /**
   * Detect the predominant type of values in a column.
   */
  private detectColumnType(values: string[]): 'string' | 'number' | 'date' | 'boolean' | 'mixed' {
    const types = new Set<string>();

    for (const value of values) {
      if (!value || value.trim() === '') continue;
      
      const trimmed = value.trim();
      
      // Check boolean
      if (/^(true|false|yes|no|1|0)$/i.test(trimmed)) {
        types.add('boolean');
        continue;
      }
      
      // Check number
      if (/^-?\d+(\.\d+)?$/.test(trimmed) || /^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(trimmed)) {
        types.add('number');
        continue;
      }
      
      // Check date
      if (/^\d{4}-\d{2}-\d{2}/.test(trimmed) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(trimmed)) {
        types.add('date');
        continue;
      }
      
      types.add('string');
    }

    if (types.size === 0) return 'string';
    if (types.size === 1) return types.values().next().value as 'string' | 'number' | 'date' | 'boolean';
    return 'mixed';
  }

  /**
   * Format table to the configured output format.
   */
  formatTable(table: ParsedTableData): string {
    switch (this.config.outputFormat) {
      case 'json':
        return this.toJson(table);
      case 'csv':
        return this.toCsv(table);
      case 'markdown':
        return this.toMarkdown(table);
      case 'text':
      default:
        return this.toText(table);
    }
  }

  /**
   * Convert table to JSON format.
   */
  toJson(table: ParsedTableData): string {
    const headers = table.headers;
    if (!headers || headers.length === 0) {
      return JSON.stringify(table.rows, null, 2);
    }

    const objects = table.rows.map(row => {
      const obj: Record<string, string> = {};
      headers.forEach((header, idx) => {
        obj[header] = row[idx] ?? '';
      });
      return obj;
    });

    return JSON.stringify(objects, null, 2);
  }

  /**
   * Convert table to CSV format.
   */
  toCsv(table: ParsedTableData): string {
    const lines: string[] = [];
    
    if (this.config.includeHeaders && table.headers) {
      lines.push(table.headers.map(h => this.escapeCsvField(h)).join(','));
    }

    for (const row of table.rows) {
      lines.push(row.map(cell => this.escapeCsvField(cell)).join(','));
    }

    return lines.join('\n');
  }

  /**
   * Escape CSV field value.
   */
  private escapeCsvField(value: string): string {
    if (!value) return '';
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Convert table to Markdown format.
   */
  toMarkdown(table: ParsedTableData): string {
    const lines: string[] = [];
    
    if (table.headers && table.headers.length > 0) {
      lines.push('| ' + table.headers.join(' | ') + ' |');
      lines.push('| ' + table.headers.map(() => '---').join(' | ') + ' |');
    }

    for (const row of table.rows) {
      lines.push('| ' + row.map(cell => cell || '').join(' | ') + ' |');
    }

    return lines.join('\n');
  }

  /**
   * Convert table to plain text format.
   */
  toText(table: ParsedTableData): string {
    const lines: string[] = [];
    
    if (this.config.includeHeaders && table.headers) {
      lines.push(table.headers.join('\t'));
      lines.push('-'.repeat(table.headers.join('\t').length));
    }

    for (const row of table.rows) {
      lines.push(row.map(cell => cell || '').join('\t'));
    }

    return lines.join('\n');
  }

  /**
   * Generate a natural language summary of the table.
   */
  generateTableSummary(table: ParsedTableData, analysis: TableAnalysis): string {
    const parts: string[] = [];
    
    parts.push(`Table with ${analysis.rowCount} rows and ${analysis.colCount} columns.`);
    
    if (analysis.hasHeaders && table.headers) {
      parts.push(`Columns: ${table.headers.join(', ')}.`);
    }

    if (analysis.columnTypes) {
      const numericCols = analysis.columnTypes.filter(c => c.type === 'number').length;
      const dateCols = analysis.columnTypes.filter(c => c.type === 'date').length;
      
      if (numericCols > 0) {
        parts.push(`Contains ${numericCols} numeric column(s).`);
      }
      if (dateCols > 0) {
        parts.push(`Contains ${dateCols} date column(s).`);
      }
    }

    return parts.join(' ');
  }

  /**
   * Extract tables from text content.
   */
  extractTablesFromText(text: string): ParsedTableData[] {
    const tables: ParsedTableData[] = [];
    const lines = text.split('\n');
    
    let tableLines: string[] = [];
    let inTable = false;

    for (const line of lines) {
      // Detect table-like patterns
      const hasTabs = line.includes('\t');
      const columns = hasTabs 
        ? line.split('\t').filter(c => c.trim())
        : line.split(/\s{2,}/).filter(c => c.trim());
      
      if (columns.length >= 2) {
        if (!inTable) {
          inTable = true;
          tableLines = [];
        }
        tableLines.push(line);
      } else if (inTable && line.trim() === '') {
        if (tableLines.length >= 2) {
          const table = this.parseTextTable(tableLines.join('\n'));
          if (table.rows.length > 0) {
            tables.push(table);
          }
        }
        inTable = false;
        tableLines = [];
      } else if (inTable) {
        if (tableLines.length >= 2) {
          const table = this.parseTextTable(tableLines.join('\n'));
          if (table.rows.length > 0) {
            tables.push(table);
          }
        }
        inTable = false;
        tableLines = [];
      }
    }

    // Handle table at end
    if (inTable && tableLines.length >= 2) {
      const table = this.parseTextTable(tableLines.join('\n'));
      if (table.rows.length > 0) {
        tables.push(table);
      }
    }

    return tables;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new table processor instance.
 */
export function createTableProcessor(config?: TableProcessorConfig): TableProcessor {
  return new TableProcessor(config);
}

/**
 * Default table processor instance.
 */
let defaultProcessor: TableProcessor | null = null;

/**
 * Get or create the default table processor.
 */
export function getDefaultTableProcessor(): TableProcessor {
  if (!defaultProcessor) {
    defaultProcessor = new TableProcessor();
  }
  return defaultProcessor;
}

// Default export
export default TableProcessor;
