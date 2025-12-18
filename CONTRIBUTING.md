# Contributing to preflight-mcp

Thank you for your interest in contributing to preflight-mcp! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- Node.js >= 18
- npm or yarn
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/your-username/preflight-mcp.git
cd preflight-mcp

# Install dependencies
npm install

# Build the project
npm run build

# Run in development mode
npm run dev
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm test -- --coverage

# Run specific test file
npm test -- tests/search/sqliteFts.test.ts
```

### Type Checking

```bash
npm run typecheck
```

## Code Style

### TypeScript Guidelines

- Use strict TypeScript (`strict: true` in tsconfig)
- Prefer `const` over `let`
- Use explicit return types for exported functions
- Avoid `any` type; use `unknown` and type guards when needed

### Comments

- All comments should be in **English**
- Use JSDoc comments for exported functions
- Explain "why" not "what" in inline comments

### File Organization

```
src/
├── bundle/       # Bundle-related logic
├── search/       # Search functionality
├── storage/      # Storage adapters
├── utils/        # Shared utilities
├── errors.ts     # Custom error types
└── config.ts     # Configuration
```

## Pull Request Process

### Before Submitting

1. **Run tests**: `npm test`
2. **Run type check**: `npm run typecheck`
3. **Run build**: `npm run build`
4. **Run smoke test**: `npm run smoke`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new search filter option
fix: handle empty query in search
docs: update README with new env vars
refactor: extract common utils to shared module
test: add tests for verify_claim
```

### Pull Request Template

```markdown
## Description
Brief description of changes.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Tests pass locally
- [ ] Added new tests for changes
- [ ] Smoke test passes

## Checklist
- [ ] Code follows project style
- [ ] Comments are in English
- [ ] No new TypeScript errors
- [ ] Updated relevant documentation
```

## Adding New Features

### Adding a New MCP Tool

1. Define input schema in `src/server.ts`:
```typescript
const MyToolInputSchema = {
  param1: z.string().describe('Description'),
  param2: z.number().optional(),
};
```

2. Register the tool:
```typescript
server.registerTool(
  'preflight_my_tool',
  {
    title: 'My Tool',
    description: 'What this tool does. Use when: "trigger phrase"',
    inputSchema: MyToolInputSchema,
    outputSchema: { /* ... */ },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    // Implementation
  }
);
```

### Adding a New Error Type

Add to `src/errors.ts`:
```typescript
export class MyNewError extends PreflightError {
  constructor(message: string, options?: { context?: Record<string, unknown> }) {
    super(message, 'MY_ERROR_CODE', options);
    this.name = 'MyNewError';
  }
}
```

### Adding Configuration Options

1. Add to `PreflightConfig` type in `src/config.ts`
2. Add default value in `getConfig()`
3. Document in README.md

## Architecture Decisions

### Why SQLite FTS5?

- Lightweight, embedded database
- No external dependencies
- Good performance for line-based search
- WAL mode for concurrent access

### Why Zod?

- Runtime validation for MCP tool inputs
- TypeScript type inference
- Composable schemas

### Why stdio Transport?

- MCP standard for local tools
- Simple process communication
- Works with Claude Desktop, Cursor, etc.

## Reporting Issues

### Bug Reports

Please include:
- Node.js version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs

### Feature Requests

Please describe:
- Use case
- Proposed solution
- Alternatives considered

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
