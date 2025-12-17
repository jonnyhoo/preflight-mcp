import fs from 'node:fs/promises';

export async function writeAgentsMd(targetPath: string): Promise<void> {
  const content = `# AGENTS.md - Rules for using this Preflight Bundle

This bundle is an **evidence pack**. You must stay factual.

## Non-negotiable rules
- Only use evidence **inside this bundle**.
- Every factual claim in your answer must include an **Evidence pointer**:
  - file path (within this bundle) + line range
  - or a direct quote snippet with a pointer
- If you cannot find evidence, you must say: **"Not found in this bundle"** and suggest next steps:
  - run preflight_search_bundle
  - run preflight_update_bundle
  - expand bundle scope and rebuild

## Forbidden behavior
- Do not guess.
- Do not invent APIs, commands, file paths, or architecture.
- Avoid words like "probably", "likely", "should" unless you attach evidence.

## How to cite evidence
Use this format:
- (evidence: <bundle-relative-path>:<startLine>-<endLine>)

Example:
- The project uses TypeScript. (evidence: repos/foo/bar/norm/package.json:1-40)
`;

  await fs.writeFile(targetPath, content, 'utf8');
}

export async function writeStartHereMd(params: {
  targetPath: string;
  bundleId: string;
  repos: Array<{ id: string; headSha?: string }>;
  libraries?: Array<{ kind: string; input: string; id?: string }>;
}): Promise<void> {
  const repoLines = params.repos
    .map((r) => `- ${r.id}${r.headSha ? ` @ ${r.headSha}` : ''}`)
    .join('\n');

  const libraryLines = (params.libraries ?? [])
    .map((l) => {
      const resolved = l.id ? ` -> ${l.id}` : '';
      return `- ${l.kind}: ${l.input}${resolved}`;
    })
    .join('\n');

  const content = `# START_HERE.md - Preflight Bundle ${params.bundleId}

## What this is
This bundle is a local snapshot of selected repositories (and optionally library docs) for **evidence-based** development.

## Repositories included
${repoLines || '(none)'}

## Library docs included
${libraryLines || '(none)'}

## How to use
1) Read AGENTS.md first and follow its rules.
2) Read OVERVIEW.md for a quick, evidence-linked map.
3) Use search to find exact evidence:
   - tool: preflight_search_bundle
4) If the repo may have changed, refresh:
   - tool: preflight_update_bundle

## Tips
- Prefer quoting exact file content over paraphrasing.
- When unsure, open the referenced file resource and verify.
`;

  await fs.writeFile(params.targetPath, content, 'utf8');
}
