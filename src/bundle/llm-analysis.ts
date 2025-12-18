import fs from 'node:fs/promises';
import path from 'node:path';
import { type PreflightConfig } from '../config.js';
import { type BundleFacts, readFacts } from './facts.js';
import { logger } from '../logging/logger.js';
import {
  buildArchitectureAnalysisPrompt,
  buildUsageGuidePrompt,
  buildConfigurationAnalysisPrompt,
} from './prompts.js';
import {
  validateAnalysis,
  formatValidationResult,
  applyValidationCorrections,
} from './validation.js';

export type LLMAnalysisResult = {
  architecture?: any;
  usage?: any;
  configuration?: any;
  error?: string;
  provider: string;
  validation?: {
    confidence: 'high' | 'medium' | 'low';
    errors: number;
    warnings: number;
  };
};

/**
 * Call OpenAI API for analysis
 */
async function analyzeWithOpenAI(
  prompt: string,
  apiKey: string,
  model: string
): Promise<any> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a code analysis assistant. Always respond with valid JSON only. No markdown, no explanations, just JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('No content in OpenAI response');
  }

  // Try to parse JSON, handle markdown code blocks
  let jsonText = content.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
  }

  return JSON.parse(jsonText);
}

/**
 * Fallback: generate simple analysis without LLM
 */
function generateSimpleAnalysis(facts: BundleFacts): LLMAnalysisResult {
  const architecture = {
    projectType: facts.entryPoints.some((ep) => ep.type === 'package-bin')
      ? 'tool'
      : facts.dependencies.runtime.length > 10
        ? 'application'
        : 'library',
    architecturePattern: 'other',
    corePurpose: `A ${facts.languages[0]?.language || 'code'} project with ${facts.fileStructure.totalFiles} files`,
    keyComponents: facts.fileStructure.topLevelDirs.map((dir) => ({
      name: dir,
      purpose: 'Source directory',
      evidence: `Top-level directory: ${dir}`,
    })),
    technicalStack: {
      languages: facts.languages.map((l) => l.language),
      frameworks: facts.frameworks,
      testing: facts.fileStructure.hasTests ? ['unknown'] : [],
      buildTools: [],
    },
  };

  const usage = {
    installation: {
      steps:
        facts.dependencies.manager === 'npm'
          ? ['npm install']
          : facts.dependencies.manager === 'pip'
            ? ['pip install -r requirements.txt']
            : ['See project documentation'],
      evidence: `Package manager: ${facts.dependencies.manager}`,
    },
    quickStart: {
      steps: ['See project documentation'],
      mainEntryPoint: facts.entryPoints[0]?.file || 'unknown',
      evidence: facts.entryPoints.length > 0 ? 'Entry points detected' : 'No entry points found',
    },
    commonCommands: [],
  };

  const configuration = {
    configurationNeeded: facts.fileStructure.hasConfig,
    configFiles: [],
    environmentVariables: [],
    confidence: 'low' as const,
  };

  return {
    architecture,
    usage,
    configuration,
    provider: 'fallback',
  };
}

/**
 * Generate AI summary using LLM
 */
export async function generateLLMAnalysis(
  cfg: PreflightConfig,
  facts: BundleFacts
): Promise<LLMAnalysisResult> {
  // If LLM is disabled, use simple analysis
  if (cfg.llmProvider === 'none') {
    return generateSimpleAnalysis(facts);
  }

  try {
    let architecture: any;
    let usage: any;
    let configuration: any;

    if (cfg.llmProvider === 'openai' && cfg.openaiApiKey) {
      // Use OpenAI
      const archPrompt = buildArchitectureAnalysisPrompt(facts);
      const usagePrompt = buildUsageGuidePrompt(facts);
      const configPrompt = buildConfigurationAnalysisPrompt(facts);

      architecture = await analyzeWithOpenAI(archPrompt, cfg.openaiApiKey, cfg.openaiModel);
      usage = await analyzeWithOpenAI(usagePrompt, cfg.openaiApiKey, cfg.openaiModel);
      configuration = await analyzeWithOpenAI(configPrompt, cfg.openaiApiKey, cfg.openaiModel);

      return {
        architecture,
        usage,
        configuration,
        provider: 'openai',
      };
    } else if (cfg.llmProvider === 'context7') {
      // TODO: Implement Context7 MCP client integration
      logger.warn('Context7 provider not yet implemented, using fallback');
      return generateSimpleAnalysis(facts);
    } else {
      return generateSimpleAnalysis(facts);
    }
  } catch (err) {
    logger.error('LLM analysis failed', err instanceof Error ? err : undefined);
    return {
      ...generateSimpleAnalysis(facts),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Format analysis result as Markdown
 */
export function formatAnalysisAsMarkdown(
  facts: BundleFacts,
  analysis: LLMAnalysisResult
): string {
  const sections: string[] = [];

  sections.push(`# AI Analysis Summary`);
  sections.push('');
  sections.push(`Generated: ${facts.timestamp}`);
  sections.push(`Provider: ${analysis.provider}`);
  sections.push('');

  if (analysis.error) {
    sections.push(`⚠️ **Note**: Analysis encountered an error: ${analysis.error}`);
    sections.push('');
  }

  // Architecture
  if (analysis.architecture) {
    const arch = analysis.architecture;
    sections.push('## Project Overview');
    sections.push('');
    sections.push(`**Type**: ${arch.projectType || 'unknown'}`);
    sections.push(`**Pattern**: ${arch.architecturePattern || 'unknown'}`);
    sections.push('');
    if (arch.corePurpose) {
      sections.push(`**Purpose**: ${arch.corePurpose}`);
      sections.push('');
    }

    if (arch.technicalStack) {
      sections.push('### Technical Stack');
      if (arch.technicalStack.languages?.length > 0) {
        sections.push(`- **Languages**: ${arch.technicalStack.languages.join(', ')}`);
      }
      if (arch.technicalStack.frameworks?.length > 0) {
        sections.push(`- **Frameworks**: ${arch.technicalStack.frameworks.join(', ')}`);
      }
      if (arch.technicalStack.testing?.length > 0) {
        sections.push(`- **Testing**: ${arch.technicalStack.testing.join(', ')}`);
      }
      if (arch.technicalStack.buildTools?.length > 0) {
        sections.push(`- **Build Tools**: ${arch.technicalStack.buildTools.join(', ')}`);
      }
      sections.push('');
    }

    if (arch.keyComponents?.length > 0) {
      sections.push('### Key Components');
      for (const comp of arch.keyComponents) {
        sections.push(`- **${comp.name}**: ${comp.purpose}`);
        if (comp.evidence) {
          sections.push(`  - Evidence: ${comp.evidence}`);
        }
      }
      sections.push('');
    }
  }

  // Usage
  if (analysis.usage) {
    const usage = analysis.usage;
    sections.push('## Getting Started');
    sections.push('');

    if (usage.installation) {
      sections.push('### Installation');
      if (usage.installation.steps?.length > 0) {
        usage.installation.steps.forEach((step: string) => {
          sections.push(`\`\`\`bash\n${step}\n\`\`\``);
        });
      }
      if (usage.installation.evidence) {
        sections.push(`*Evidence: ${usage.installation.evidence}*`);
      }
      sections.push('');
    }

    if (usage.quickStart) {
      sections.push('### Quick Start');
      if (usage.quickStart.mainEntryPoint) {
        sections.push(`**Main Entry Point**: \`${usage.quickStart.mainEntryPoint}\``);
      }
      if (usage.quickStart.steps?.length > 0) {
        usage.quickStart.steps.forEach((step: string) => {
          sections.push(`- ${step}`);
        });
      }
      sections.push('');
    }

    if (usage.commonCommands?.length > 0) {
      sections.push('### Common Commands');
      for (const cmd of usage.commonCommands) {
        sections.push(`- \`${cmd.command}\`: ${cmd.purpose}`);
        if (cmd.condition) {
          sections.push(`  - *${cmd.condition}*`);
        }
      }
      sections.push('');
    }
  }

  // Configuration
  if (analysis.configuration) {
    const config = analysis.configuration;
    sections.push('## Configuration');
    sections.push('');

    if (config.configurationNeeded) {
      if (config.configFiles?.length > 0) {
        sections.push('### Config Files');
        config.configFiles.forEach((file: string) => {
          sections.push(`- \`${file}\``);
        });
        sections.push('');
      }

      if (config.environmentVariables?.length > 0) {
        sections.push('### Environment Variables');
        for (const envVar of config.environmentVariables) {
          sections.push(`- \`${envVar.name}\`: ${envVar.purpose}`);
          if (envVar.evidence) {
            sections.push(`  - Evidence: ${envVar.evidence}`);
          }
        }
        sections.push('');
      }
    } else {
      sections.push('No special configuration required.');
      sections.push('');
    }

    if (config.confidence) {
      sections.push(`*Confidence: ${config.confidence}*`);
      sections.push('');
    }
  }

  sections.push('---');
  sections.push('');
  sections.push('*This analysis was generated automatically. Always verify against the source code.*');

  return sections.join('\n') + '\n';
}

/**
 * Generate and save AI analysis
 */
export async function generateAndSaveAnalysis(params: {
  cfg: PreflightConfig;
  bundleRoot: string;
}): Promise<void> {
  // Read facts
  const factsPath = path.join(params.bundleRoot, 'analysis', 'FACTS.json');
  const facts = await readFacts(factsPath);

  if (!facts) {
    throw new Error('Facts not found. Run static analysis first.');
  }

  // Generate LLM analysis
  let analysis = await generateLLMAnalysis(params.cfg, facts);

  // Validate analysis
  const validation = await validateAnalysis(params.bundleRoot, facts, analysis);
  
  // Log validation results
  if (params.cfg.llmProvider !== 'none') {
    const validationReport = formatValidationResult(validation);
    logger.debug('Analysis validation', { report: validationReport });
  }

  // Apply corrections based on validation
  analysis = applyValidationCorrections(analysis, validation);

  // Add validation notice to markdown if there were issues
  let markdown = formatAnalysisAsMarkdown(facts, analysis);
  
  if (!validation.valid || validation.warnings.length > 0) {
    const validationSection = formatValidationResult(validation);
    markdown = markdown.replace(
      '---\n',
      `\n## Validation Report\n\n\`\`\`\n${validationSection}\n\`\`\`\n\n---\n`
    );
  }

  // Save to file
  const summaryPath = path.join(params.bundleRoot, 'analysis', 'AI_SUMMARY.md');
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, markdown, 'utf8');

  logger.debug(`AI analysis saved`, { path: summaryPath });
  
  if (!validation.valid) {
    logger.warn(`Analysis had validation issues`, { errors: validation.errors.length, warnings: validation.warnings.length });
  }
}
