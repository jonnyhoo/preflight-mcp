import { type BundleFacts } from './facts.js';

export function buildArchitectureAnalysisPrompt(facts: BundleFacts): string {
  return `You are analyzing a code repository. Based on the following VERIFIED FACTS, provide a high-level architecture summary.

## VERIFIED FACTS

### Languages
${facts.languages.map((l) => `- ${l.language}: ${l.fileCount} files`).join('\n')}

### Frameworks Detected
${facts.frameworks.length > 0 ? facts.frameworks.map((f) => `- ${f}`).join('\n') : '(none)'}

### Entry Points
${facts.entryPoints.length > 0 ? facts.entryPoints.map((ep) => `- [${ep.type}] ${ep.file}`).join('\n') : '(none)'}

### Dependencies (${facts.dependencies.manager})
Runtime: ${facts.dependencies.runtime.length} packages
Dev: ${facts.dependencies.dev.length} packages

### File Structure
- Total files: ${facts.fileStructure.totalFiles}
- Docs: ${facts.fileStructure.totalDocs}
- Code: ${facts.fileStructure.totalCode}
- Top-level dirs: ${facts.fileStructure.topLevelDirs.join(', ')}
- Has tests: ${facts.fileStructure.hasTests}

## TASK

Provide a JSON response with the following structure:

{
  "projectType": "library" | "application" | "tool" | "framework" | "unknown",
  "architecturePattern": "mvc" | "microservices" | "plugin" | "monolith" | "library" | "cli-tool" | "other",
  "corePurpose": "Brief description of what this project does (1-2 sentences)",
  "keyComponents": [
    {
      "name": "Component name",
      "purpose": "What it does",
      "evidence": "file path from entry points or top-level dirs"
    }
  ],
  "technicalStack": {
    "languages": ["TypeScript", "JavaScript"],
    "frameworks": ["React", "Express"],
    "testing": ["Jest"],
    "buildTools": ["tsc", "webpack"]
  }
}

## RULES

1. ONLY reference information from the VERIFIED FACTS above
2. DO NOT invent file paths, APIs, or functionality
3. Keep descriptions factual and brief
4. If uncertain about something, use "unknown" or omit it
5. All evidence MUST point to actual files or directories from the facts`;
}

export function buildUsageGuidePrompt(facts: BundleFacts): string {
  const hasCLI = facts.entryPoints.some((ep) => ep.type === 'package-bin');
  const hasTests = facts.fileStructure.hasTests;
  
  return `Based on these VERIFIED FACTS about a repository, generate a usage guide.

## VERIFIED FACTS

### Entry Points
${facts.entryPoints.length > 0 ? facts.entryPoints.map((ep) => `- [${ep.type}] ${ep.file}`).join('\n') : '(none)'}

### Dependencies
${facts.dependencies.runtime.slice(0, 10).map((d) => `- ${d.name}${d.version ? ` ${d.version}` : ''}`).join('\n')}

### Package Manager
${facts.dependencies.manager}

### Has Tests
${hasTests ? 'Yes' : 'No'}

### Has CLI
${hasCLI ? 'Yes' : 'No'}

## TASK

Generate a JSON response:

{
  "installation": {
    "steps": ["npm install", "..."],
    "evidence": "Based on package manager: ${facts.dependencies.manager}"
  },
  "quickStart": {
    "steps": ["Brief steps to get started"],
    "mainEntryPoint": "${facts.entryPoints[0]?.file || 'unknown'}",
    "evidence": "entry points from facts"
  },
  "commonCommands": [
    {
      "command": "npm test",
      "purpose": "Run tests",
      "condition": "${hasTests ? 'Tests detected' : 'No tests found'}"
    }
  ]
}

## RULES

1. Base ALL information on the facts above
2. DO NOT assume commands or scripts that aren't verified
3. Keep it practical and minimal`;
}

export function buildConfigurationAnalysisPrompt(facts: BundleFacts): string {
  const configDeps = facts.dependencies.runtime
    .concat(facts.dependencies.dev)
    .filter((d) => 
      d.name.includes('config') || 
      d.name.includes('dotenv') || 
      d.name.includes('env')
    );

  return `Analyze configuration requirements based on these VERIFIED FACTS.

## VERIFIED FACTS

### Dependencies Related to Configuration
${configDeps.length > 0 ? configDeps.map((d) => `- ${d.name}`).join('\n') : '(none detected)'}

### Has Config Files
${facts.fileStructure.hasConfig ? 'Yes' : 'No'}

### Frameworks
${facts.frameworks.join(', ') || '(none)'}

## TASK

Generate JSON response:

{
  "configurationNeeded": true | false,
  "configFiles": ["list of common config files for this stack"],
  "environmentVariables": [
    {
      "name": "SUGGESTED_VAR",
      "purpose": "Why it might be needed",
      "evidence": "Based on framework X or dependency Y"
    }
  ],
  "confidence": "high" | "medium" | "low"
}

## RULES

1. Only suggest config based on detected frameworks and dependencies
2. Mark confidence as 'low' if mostly guessing
3. DO NOT invent config variables without evidence`;
}
