/**
 * Modal processors module exports.
 *
 * @module modal/processors
 */

// Image Processor (OCR)
export {
  ImageProcessor,
  createImageProcessor,
  getDefaultImageProcessor,
  type OcrConfig,
  type OcrResult,
  type OcrWord,
  type ImageProcessResult,
} from './image-processor.js';

// Table Processor
export {
  TableProcessor,
  createTableProcessor,
  getDefaultTableProcessor,
  type TableProcessorConfig,
  type TableAnalysis,
  type ColumnType,
  type TableProcessResult,
} from './table-processor.js';

// Base and Generic Processors
export {
  BaseModalProcessor,
  GenericModalProcessor,
  type BaseProcessorResult,
  type ProcessingContext,
  createGenericProcessor,
} from './base-processor.js';

// Equation Processor
export {
  EquationProcessor,
  createEquationProcessor,
  type EquationProcessorConfig,
  type EquationAnalysis,
  type EquationType,
} from './equation-processor.js';
