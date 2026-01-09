/**
 * Basic prompt templates for multimodal processing (skeleton).
 */
import type { PromptTemplate, PromptInput } from './types.js';

function fill(tpl: string, input: PromptInput): string {
  return tpl.replace(/{{(\w+)}}/g, (_, k) => String(input[k] ?? ''));
}

export function getImagePrompt(input: PromptInput): string {
  const tpl: PromptTemplate = {
    name: 'image-analysis',
    template: 'Describe the image focusing on {{focus}}. Provide key objects and relationships.',
  };
  return fill(tpl.template, input);
}

export function getTablePrompt(input: PromptInput): string {
  const tpl: PromptTemplate = {
    name: 'table-analysis',
    template: 'Summarize the table columns {{columns}} and key insights in plain text.',
  };
  return fill(tpl.template, input);
}

export function getEquationPrompt(input: PromptInput): string {
  const tpl: PromptTemplate = {
    name: 'equation-analysis',
    template: 'Explain the equation {{equation}} and define all variables.',
  };
  return fill(tpl.template, input);
}