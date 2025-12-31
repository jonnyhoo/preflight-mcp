import fs from 'node:fs/promises';
import path from 'node:path';
import { readFacts, type BundleFacts } from './facts.js';

export type GuideGenerationParams = {
  targetPath: string;
  bundleId: string;
  bundleRootDir: string;
  repos: Array<{ id: string; headSha?: string }>;
  libraries?: Array<{ kind: string; input: string; id?: string }>;
};

/**
 * Generate dynamic AGENTS.md content based on bundle facts.
 */
export async function writeAgentsMd(params: GuideGenerationParams): Promise<void> {
  const factsPath = path.join(params.bundleRootDir, 'analysis', 'FACTS.json');
  const facts = await readFacts(factsPath);
  
  const sections: string[] = [];
  
  // Header
  sections.push(`# AGENTS.md - Rules for using this Preflight Bundle\n`);
  sections.push(`This bundle is an **evidence pack**. You must stay factual.\n`);
  
  // Non-negotiable rules
  sections.push(`## Non-negotiable rules`);
  sections.push(`- Only use evidence **inside this bundle**.`);
  sections.push(`- Every factual claim in your answer must include an **Evidence pointer**:`);
  sections.push(`  - file path (within this bundle) + line range`);
  sections.push(`  - or a direct quote snippet with a pointer`);
  sections.push(`- If you cannot find evidence, you must say: **"Not found in this bundle"** and suggest next steps:`);
  sections.push(`  - run preflight_search_and_read`);
  sections.push(`  - run preflight_update_bundle`);
  sections.push(`  - expand bundle scope and rebuild\n`);
  
  // Forbidden behavior
  sections.push(`## Forbidden behavior`);
  sections.push(`- Do not guess.`);
  sections.push(`- Do not invent APIs, commands, file paths, or architecture.`);
  sections.push(`- Avoid words like "probably", "likely", "should" unless you attach evidence.\n`);
  
  // How to cite evidence
  sections.push(`## How to cite evidence`);
  sections.push(`Use this format:`);
  sections.push(`- (evidence: <bundle-relative-path>:<startLine>-<endLine>)\n`);
  sections.push(`Example:`);
  sections.push(`- The project uses TypeScript. (evidence: repos/foo/bar/norm/package.json:1-40)\n`);
  
  // Dynamic: Key types and interfaces (from extension points)
  if (facts?.extensionPoints && facts.extensionPoints.length > 0) {
    sections.push(`## Key Extension Points\n`);
    sections.push(`When modifying code, be aware of these key types and interfaces:\n`);
    
    // Group by kind
    const interfaces = facts.extensionPoints.filter(ep => ep.kind === 'interface').slice(0, 10);
    const unionTypes = facts.extensionPoints.filter(ep => ep.kind === 'union-type').slice(0, 8);
    const callbacks = facts.extensionPoints.filter(ep => ep.kind === 'optional-callback').slice(0, 8);
    
    if (interfaces.length > 0) {
      sections.push(`### Interfaces/Traits/Protocols`);
      for (const ep of interfaces) {
        const shortFile = ep.file.replace(/^repos\/[^\/]+\/[^\/]+\/norm\//, '');
        sections.push(`- **${ep.name}** - ${shortFile}:${ep.line}`);
        if (ep.semantics) sections.push(`  - ${ep.semantics}`);
      }
      sections.push('');
    }
    
    if (unionTypes.length > 0) {
      sections.push(`### Union/Enum Types`);
      for (const ep of unionTypes) {
        const shortFile = ep.file.replace(/^repos\/[^\/]+\/[^\/]+\/norm\//, '');
        sections.push(`- **${ep.name}** - ${shortFile}:${ep.line}`);
        if (ep.values) sections.push(`  - Values: ${ep.values.slice(0, 5).join(', ')}${ep.values.length > 5 ? '...' : ''}`);
      }
      sections.push('');
    }
    
    if (callbacks.length > 0) {
      sections.push(`### Callback/Hook Points`);
      for (const ep of callbacks) {
        const shortFile = ep.file.replace(/^repos\/[^\/]+\/[^\/]+\/norm\//, '');
        sections.push(`- **${ep.name}** - ${shortFile}:${ep.line}`);
      }
      sections.push('');
    }
  }
  
  // Dynamic: Language-specific guidance
  if (facts?.languages && facts.languages.length > 0) {
    const primaryLang = facts.languages[0]?.language;
    
    sections.push(`## Language-specific guidance\n`);
    
    if (primaryLang === 'TypeScript' || primaryLang === 'JavaScript') {
      sections.push(`This is a **${primaryLang}** project. When citing code:`);
      sections.push(`- For imports: cite the import statement line`);
      sections.push(`- For functions: cite from function signature to closing brace`);
      sections.push(`- For types/interfaces: cite the full type definition\n`);
    } else if (primaryLang === 'Python') {
      sections.push(`This is a **Python** project. When citing code:`);
      sections.push(`- For imports: cite the import/from lines`);
      sections.push(`- For functions: cite from def to end of function body`);
      sections.push(`- For classes: cite from class definition to end of class\n`);
    } else if (primaryLang === 'Go') {
      sections.push(`This is a **Go** project. When citing code:`);
      sections.push(`- For imports: cite the import block`);
      sections.push(`- For functions: cite from func signature to closing brace`);
      sections.push(`- For interfaces: cite the full interface definition\n`);
    } else if (primaryLang === 'Rust') {
      sections.push(`This is a **Rust** project. When citing code:`);
      sections.push(`- For imports: cite the use statements`);
      sections.push(`- For functions: cite from fn signature to closing brace`);
      sections.push(`- For traits/enums: cite the full definition\n`);
    }
  }
  
  // Dynamic: Recommended search patterns
  if (facts?.patterns && facts.patterns.length > 0) {
    sections.push(`## Architecture patterns detected\n`);
    sections.push(`This project uses the following patterns:`);
    for (const pattern of facts.patterns) {
      sections.push(`- ${pattern}`);
    }
    sections.push('');
    sections.push(`Keep these patterns in mind when suggesting code changes.\n`);
  }
  
  const content = sections.join('\n');
  await fs.writeFile(params.targetPath, content, 'utf8');
}

/**
 * Generate dynamic START_HERE.md content based on bundle facts.
 */
export async function writeStartHereMd(params: GuideGenerationParams): Promise<void> {
  const factsPath = path.join(params.bundleRootDir, 'analysis', 'FACTS.json');
  const facts = await readFacts(factsPath);
  
  const repoLines = params.repos
    .map((r) => `- ${r.id}${r.headSha ? ` @ ${r.headSha}` : ''}`)
    .join('\n');

  const libraryLines = (params.libraries ?? [])
    .map((l) => {
      const resolved = l.id ? ` -> ${l.id}` : '';
      return `- ${l.kind}: ${l.input}${resolved}`;
    })
    .join('\n');

  const sections: string[] = [];
  
  // Header
  sections.push(`# START_HERE.md - Preflight Bundle ${params.bundleId}\n`);
  
  // Dynamic: Project summary (if facts available)
  if (facts) {
    sections.push(`## Project Summary\n`);
    
    // Language and framework info
    if (facts.languages && facts.languages.length > 0) {
      const langInfo = facts.languages.slice(0, 3).map(l => `${l.language} (${l.fileCount} files)`).join(', ');
      sections.push(`**Languages**: ${langInfo}`);
    }
    
    if (facts.frameworks && facts.frameworks.length > 0) {
      sections.push(`**Frameworks**: ${facts.frameworks.join(', ')}`);
    }
    
    if (facts.techStack) {
      if (facts.techStack.runtime) {
        sections.push(`**Runtime**: ${facts.techStack.runtime}`);
      }
      if (facts.techStack.packageManager) {
        sections.push(`**Package Manager**: ${facts.techStack.packageManager}`);
      }
    }
    
    sections.push('');
    
    // Entry points
    if (facts.entryPoints && facts.entryPoints.length > 0) {
      sections.push(`### Entry Points`);
      for (const ep of facts.entryPoints.slice(0, 5)) {
        const shortFile = ep.file.replace(/^repos\/[^\/]+\/[^\/]+\/norm\//, '');
        sections.push(`- \`${shortFile}\` (${ep.type})`);
      }
      sections.push('');
    }
    
    // Architecture patterns
    if (facts.patterns && facts.patterns.length > 0) {
      sections.push(`### Architecture`);
      sections.push(`Detected patterns: ${facts.patterns.join(', ')}`);
      sections.push('');
    }
    
    // File structure summary
    if (facts.fileStructure) {
      sections.push(`### Structure`);
      sections.push(`- Total files: ${facts.fileStructure.totalFiles}`);
      sections.push(`- Code files: ${facts.fileStructure.totalCode}`);
      sections.push(`- Documentation: ${facts.fileStructure.totalDocs}`);
      sections.push(`- Has tests: ${facts.fileStructure.hasTests ? 'Yes' : 'No'}`);
      if (facts.fileStructure.topLevelDirs.length > 0) {
        sections.push(`- Key directories: ${facts.fileStructure.topLevelDirs.slice(0, 8).join(', ')}`);
      }
      sections.push('');
    }
  }
  
  // What this is
  sections.push(`## What this is\n`);
  sections.push(`This bundle is a local snapshot of selected repositories (and optionally library docs) for **evidence-based** development.\n`);
  
  // Repositories
  sections.push(`## Repositories included`);
  sections.push(repoLines || '(none)');
  sections.push('');
  
  // Libraries
  sections.push(`## Library docs included`);
  sections.push(libraryLines || '(none)');
  sections.push('');
  
  // Dynamic: Quick start based on project type
  if (facts) {
    sections.push(`## Quick Start\n`);
    
    const primaryLang = facts.languages?.[0]?.language;
    const hasTests = facts.fileStructure?.hasTests;
    
    sections.push(`1. Read **AGENTS.md** for evidence citation rules`);
    sections.push(`2. Read **OVERVIEW.md** for architecture overview`);
    sections.push(`3. Use **preflight_search_and_read** to find specific code`);
    
    if (facts.entryPoints && facts.entryPoints.length > 0) {
      const mainEntry = facts.entryPoints[0];
      const shortFile = mainEntry?.file.replace(/^repos\/[^\/]+\/[^\/]+\/norm\//, '');
      sections.push(`4. Start exploring from \`${shortFile}\``);
    }
    
    sections.push('');
    
    // Search suggestions based on project type
    sections.push(`### Suggested searches\n`);
    sections.push(`Try these searches to understand the codebase:\n`);
    
    if (primaryLang === 'TypeScript' || primaryLang === 'JavaScript') {
      sections.push(`- \`export function\` - find public APIs`);
      sections.push(`- \`interface\` or \`type\` - find type definitions`);
      sections.push(`- \`import { ... } from\` - trace dependencies`);
    } else if (primaryLang === 'Python') {
      sections.push(`- \`def \` - find function definitions`);
      sections.push(`- \`class \` - find class definitions`);
      sections.push(`- \`from ... import\` - trace dependencies`);
    } else if (primaryLang === 'Go') {
      sections.push(`- \`func \` - find function definitions`);
      sections.push(`- \`type ... interface\` - find interfaces`);
      sections.push(`- \`package \` - find package declarations`);
    } else if (primaryLang === 'Rust') {
      sections.push(`- \`pub fn\` - find public functions`);
      sections.push(`- \`pub trait\` - find traits`);
      sections.push(`- \`pub enum\` - find enums`);
    }
    
    if (hasTests) {
      sections.push(`- \`test\` - find test files and test cases`);
    }
    
    sections.push('');
  } else {
    // Fallback to basic instructions
    sections.push(`## How to use\n`);
    sections.push(`1) Read AGENTS.md first and follow its rules.`);
    sections.push(`2) Read OVERVIEW.md for a quick, evidence-linked map.`);
    sections.push(`3) Use search to find exact evidence:`);
    sections.push(`   - tool: preflight_search_and_read`);
    sections.push(`4) If the repo may have changed, refresh:`);
    sections.push(`   - tool: preflight_update_bundle\n`);
  }
  
  // Tips
  sections.push(`## Tips\n`);
  sections.push(`- Prefer quoting exact file content over paraphrasing.`);
  sections.push(`- When unsure, open the referenced file resource and verify.`);
  sections.push(`- Use \`preflight_repo_tree\` to explore directory structure.`);
  sections.push(`- Use \`preflight_read_file\` to read specific files.\n`);

  const content = sections.join('\n');
  await fs.writeFile(params.targetPath, content, 'utf8');
}
