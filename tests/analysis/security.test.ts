/**
 * Tests for Security Rules
 *
 * Tests:
 * - HardcodedCredentials: Detection of hardcoded secrets
 * - InsecureRandom: Math.random() (JS/TS) and java.util.Random (Java)
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AnalysisContext } from '../../src/analysis/cache/index.js';
import { checkSecurity } from '../../src/analysis/check/security/index.js';
import { looksLikeCredential, isCredentialName } from '../../src/analysis/check/security/types.js';
import type { SecurityOptions } from '../../src/analysis/check/types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const FIXTURES = {
  // HardcodedCredentials - Should detect
  hardcodedTs: `
const password = "SuperSecretP@ss123";
const apiKey = "sk_test_1234567890abcdef";
const config = {
  secret: "MyS3cr3tK3y!xyz",
  accessToken: "ghp_xxxxxxxxxxxx123"
};
`,

  hardcodedJs: `
let dbPassword = "ProductionDB#2024";
const API_KEY = "AKIA_TEST_1234567890";
module.exports = {
  clientSecret: "abc123XYZ!@#def"
};
`,

  hardcodedJava: `
public class Config {
  private static final String PASSWORD = "AdminP@ssw0rd!";
  private String apiKey = "api-key-12345-xyz";
  
  public void setSecret() {
    String token = "bearer-token-abcdef";
  }
}
`,

  hardcodedPython: `
PASSWORD = "MySecretP@ss!123"
api_key = "sk_live_1234567890"
config = {
    "secret_key": "django-secret-xyz123",
    "auth_token": "token_abcdefghij"
}
`,

  // HardcodedCredentials - Should NOT detect (placeholders/short values)
  placeholdersTs: `
const password = "changeme";
const apiKey = "your_api_key_here";
const secret = "example";
const token = "test";
const key = "\${ENV_VAR}";
const auth = "{{placeholder}}";
const pwd = "dummy";
const credential = "xxx";
const short = "abc";
`,

  // HardcodedCredentials - Should NOT detect (non-credential names)
  nonCredentialTs: `
const username = "SuperSecretP@ss123";
const message = "This is a long message with numbers 123";
const description = "Some text with special chars !@#";
`,

  // InsecureRandom - JS/TS - Should detect
  insecureRandomTs: `
function generateId(): string {
  return Math.random().toString(36);
}

const randomValue = Math.random() * 100;
`,

  insecureRandomJs: `
function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

const dice = Math.floor(Math.random() * 6) + 1;
`,

  // InsecureRandom - Java - Should detect
  insecureRandomJava: `
import java.util.Random;

public class RandomUtil {
  private Random random = new Random();
  
  public int getRandomInt() {
    Random r = new Random();
    return r.nextInt(100);
  }
  
  public double getRandomDouble() {
    return random.nextDouble();
  }
}
`,

  // InsecureRandom - Should NOT detect (secure alternatives)
  secureRandomTs: `
import { randomUUID, randomBytes } from 'crypto';

const uuid = randomUUID();
const bytes = randomBytes(16);
const values = crypto.getRandomValues(new Uint8Array(16));
`,

  secureRandomJava: `
import java.security.SecureRandom;

public class SecureUtil {
  private SecureRandom secureRandom = new SecureRandom();
  
  public int getSecureInt() {
    return secureRandom.nextInt(100);
  }
}
`,

  // Clean code - no issues
  cleanTs: `
const username = "admin";
const count = 42;
const message = "Hello, World!";

function getConfig() {
  return {
    host: "localhost",
    port: 3000
  };
}
`,
};

// ============================================================================
// Helper Functions
// ============================================================================

async function analyzeFixture(
  content: string,
  ext: string,
  subdir?: string,
  securityOptions?: SecurityOptions
): Promise<ReturnType<typeof checkSecurity>> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'security-test-'));
  const targetDir = subdir ? path.join(tmpDir, subdir) : tmpDir;

  if (subdir) {
    await fs.mkdir(targetDir, { recursive: true });
  }

  const filePath = path.join(targetDir, `test${ext}`);

  try {
    await fs.writeFile(filePath, content, 'utf8');

    const context = new AnalysisContext({
      rootPath: tmpDir,
    });

    try {
      return await checkSecurity(tmpDir, [], context, securityOptions);
    } finally {
      context.dispose();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Security Rules', () => {
  describe('HardcodedCredentials', () => {
    it('should detect hardcoded credentials in TypeScript', async () => {
      const result = await analyzeFixture(FIXTURES.hardcodedTs, '.ts');

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      expect(credIssues.length).toBeGreaterThanOrEqual(3);
      expect(credIssues.some((i) => i.message.includes('password'))).toBe(true);
      expect(credIssues.some((i) => i.message.includes('apiKey'))).toBe(true);
    });

    it('should detect hardcoded credentials in JavaScript', async () => {
      const result = await analyzeFixture(FIXTURES.hardcodedJs, '.js');

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      expect(credIssues.length).toBeGreaterThanOrEqual(2);
    });

    it('should detect hardcoded credentials in Java', async () => {
      const result = await analyzeFixture(FIXTURES.hardcodedJava, '.java');

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      expect(credIssues.length).toBeGreaterThanOrEqual(2);
    });

    it('should detect hardcoded credentials in Python', async () => {
      const result = await analyzeFixture(FIXTURES.hardcodedPython, '.py');

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      expect(credIssues.length).toBeGreaterThanOrEqual(2);
    });

    it('should NOT detect placeholders', async () => {
      const result = await analyzeFixture(FIXTURES.placeholdersTs, '.ts');

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      expect(credIssues.length).toBe(0);
    });

    it('should NOT detect non-credential variable names', async () => {
      const result = await analyzeFixture(FIXTURES.nonCredentialTs, '.ts');

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      expect(credIssues.length).toBe(0);
    });

    it('should skip test directories by default', async () => {
      const result = await analyzeFixture(FIXTURES.hardcodedTs, '.ts', 'tests');

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      expect(credIssues.length).toBe(0);
    });

    it('should skip fixture directories by default', async () => {
      const result = await analyzeFixture(FIXTURES.hardcodedTs, '.ts', 'fixtures');

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      expect(credIssues.length).toBe(0);
    });

    it('should respect ignoreNamePatterns configuration', async () => {
      const content = `
const testPassword = "SuperSecretP@ss123";
const mockApiKey = "sk_test_1234567890abcdef";
const realSecret = "ActualSecretValue!";
`;
      const result = await analyzeFixture(content, '.ts', undefined, {
        ignoreNamePatterns: ['test', 'mock'],
      });

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      // Only realSecret should be detected (testPassword and mockApiKey ignored)
      expect(credIssues.length).toBe(1);
      expect(credIssues[0]!.message).toContain('realSecret');
    });

    it('should respect ignoreValuePatterns configuration', async () => {
      const content = `
const password = "fake_password_12345";
const apiKey = "localhost_key_abcdef";
const secret = "RealProductionSecret!";
`;
      const result = await analyzeFixture(content, '.ts', undefined, {
        ignoreValuePatterns: ['^fake_', 'localhost'],
      });

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      // Only secret should be detected (password and apiKey values ignored)
      expect(credIssues.length).toBe(1);
      expect(credIssues[0]!.message).toContain('secret');
    });

    it('should respect both ignoreNamePatterns and ignoreValuePatterns', async () => {
      const content = `
const testPassword = "fake_password_12345";
const apiKey = "RealProductionKey123!";
`;
      const result = await analyzeFixture(content, '.ts', undefined, {
        ignoreNamePatterns: ['test'],
        ignoreValuePatterns: ['^fake_'],
      });

      expect(result.success).toBe(true);
      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');

      // Only apiKey should be detected (testPassword name ignored, apiKey value not ignored)
      expect(credIssues.length).toBe(1);
      expect(credIssues[0]!.message).toContain('apiKey');
    });
  });

  describe('InsecureRandom', () => {
    it('should detect Math.random() in TypeScript', async () => {
      const result = await analyzeFixture(FIXTURES.insecureRandomTs, '.ts');

      expect(result.success).toBe(true);
      const randomIssues = result.issues.filter((i) => i.ruleId === 'insecure-random');

      expect(randomIssues.length).toBe(2);
      expect(randomIssues[0]!.message).toContain('Math.random()');
    });

    it('should detect Math.random() in JavaScript', async () => {
      const result = await analyzeFixture(FIXTURES.insecureRandomJs, '.js');

      expect(result.success).toBe(true);
      const randomIssues = result.issues.filter((i) => i.ruleId === 'insecure-random');

      expect(randomIssues.length).toBe(2);
    });

    it('should detect java.util.Random in Java', async () => {
      const result = await analyzeFixture(FIXTURES.insecureRandomJava, '.java');

      expect(result.success).toBe(true);
      const randomIssues = result.issues.filter((i) => i.ruleId === 'insecure-random');

      expect(randomIssues.length).toBeGreaterThanOrEqual(2);
      expect(randomIssues[0]!.message).toContain('java.util.Random');
    });

    it('should NOT detect crypto secure alternatives in TypeScript', async () => {
      const result = await analyzeFixture(FIXTURES.secureRandomTs, '.ts');

      expect(result.success).toBe(true);
      const randomIssues = result.issues.filter((i) => i.ruleId === 'insecure-random');

      expect(randomIssues.length).toBe(0);
    });

    it('should NOT detect SecureRandom in Java', async () => {
      const result = await analyzeFixture(FIXTURES.secureRandomJava, '.java');

      expect(result.success).toBe(true);
      const randomIssues = result.issues.filter((i) => i.ruleId === 'insecure-random');

      expect(randomIssues.length).toBe(0);
    });
  });

  describe('Utility Functions', () => {
    describe('looksLikeCredential', () => {
      it('should return true for credential-like values', () => {
        expect(looksLikeCredential('SuperSecretP@ss123')).toBe(true);
        expect(looksLikeCredential('sk_test_1234567890abcdef')).toBe(true);
        expect(looksLikeCredential('AKIA_TEST_1234567890')).toBe(true);
      });

      it('should return false for placeholders', () => {
        expect(looksLikeCredential('changeme')).toBe(false);
        expect(looksLikeCredential('example_value')).toBe(false);
        expect(looksLikeCredential('your_api_key')).toBe(false);
        expect(looksLikeCredential('test')).toBe(false);
        expect(looksLikeCredential('dummy')).toBe(false);
        expect(looksLikeCredential('xxx')).toBe(false);
      });

      it('should return false for short values', () => {
        expect(looksLikeCredential('abc')).toBe(false);
        expect(looksLikeCredential('1234567')).toBe(false);
      });

      it('should return false for environment variable references', () => {
        expect(looksLikeCredential('${SECRET}')).toBe(false);
        expect(looksLikeCredential('{{API_KEY}}')).toBe(false);
        expect(looksLikeCredential('process.env.SECRET')).toBe(false);
      });
    });

    describe('isCredentialName', () => {
      it('should return true for credential-like names', () => {
        expect(isCredentialName('password')).toBe(true);
        expect(isCredentialName('apiKey')).toBe(true);
        expect(isCredentialName('API_KEY')).toBe(true);
        expect(isCredentialName('secret')).toBe(true);
        expect(isCredentialName('accessToken')).toBe(true);
        expect(isCredentialName('clientSecret')).toBe(true);
        expect(isCredentialName('private_key')).toBe(true);
        expect(isCredentialName('auth_token')).toBe(true);
      });

      it('should return false for non-credential names', () => {
        expect(isCredentialName('username')).toBe(false);
        expect(isCredentialName('email')).toBe(false);
        expect(isCredentialName('count')).toBe(false);
        expect(isCredentialName('message')).toBe(false);
      });
    });
  });

  describe('Integration', () => {
    it('should return success=true with no issues for clean code', async () => {
      const result = await analyzeFixture(FIXTURES.cleanTs, '.ts');

      expect(result.success).toBe(true);
      expect(result.issues.length).toBe(0);
    });

    it('should detect multiple issue types in one file', async () => {
      const content = `
const password = "SuperSecretP@ss123";
const randomId = Math.random().toString(36);
`;
      const result = await analyzeFixture(content, '.ts');

      expect(result.success).toBe(true);

      const credIssues = result.issues.filter((i) => i.ruleId === 'hardcoded-credentials');
      const randomIssues = result.issues.filter((i) => i.ruleId === 'insecure-random');

      expect(credIssues.length).toBe(1);
      expect(randomIssues.length).toBe(1);
    });

    it('should have correct severity levels', async () => {
      const content = `
const apiKey = "sk_test_1234567890!";
const id = Math.random();
`;
      const result = await analyzeFixture(content, '.ts');

      for (const issue of result.issues) {
        expect(issue.severity).toBe('warning');
      }
    });

    it('should include ruleId in all issues', async () => {
      const content = `
const secret = "MySecretValue123!";
Math.random();
`;
      const result = await analyzeFixture(content, '.ts');

      for (const issue of result.issues) {
        expect(issue.ruleId).toBeDefined();
        expect(['hardcoded-credentials', 'insecure-random']).toContain(issue.ruleId);
      }
    });
  });
});
