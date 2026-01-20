/**
 * Tests for Java Documentation Checker (Phase 6)
 *
 * Tests:
 * - class/interface/enum/annotation Javadoc binding
 * - method/constructor binding + @param/@return/@throws validation
 * - onlyExported for public/protected/package-private/private
 * - @inheritDoc treated as doc.exists=true but validation still runs
 * - broken binding rules (content between Javadoc and declaration)
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createJavaDocChecker } from '../../src/analysis/doccheck/java/index.js';
import type { DocCheckOptions, FileCheckResult } from '../../src/analysis/doccheck/types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const FIXTURES = {
  // Basic class with method
  basicClass: `
/**
 * A simple calculator class.
 */
public class Calculator {
    /**
     * Adds two numbers.
     * @param a first number
     * @param b second number
     * @return the sum
     */
    public int add(int a, int b) {
        return a + b;
    }
}
`,

  // Interface with default public members
  interfaceWithMethods: `
/**
 * A service interface.
 */
public interface Service {
    /**
     * Performs an action.
     * @param input the input value
     * @return the result
     */
    String perform(String input);

    /**
     * Gets the name.
     * @return the name
     */
    String getName();
}
`,

  // Enum with Javadoc
  enumWithJavadoc: `
/**
 * Status values.
 */
public enum Status {
    ACTIVE,
    INACTIVE,
    PENDING
}
`,

  // Annotation type
  annotationType: `
/**
 * Marks a method as deprecated.
 */
public @interface Deprecated {
    /**
     * The reason for deprecation.
     * @return deprecation reason
     */
    String reason() default "";
}
`,

  // Constructor with Javadoc
  constructorWithJavadoc: `
/**
 * A user class.
 */
public class User {
    private String name;

    /**
     * Creates a new user.
     * @param name the user's name
     */
    public User(String name) {
        this.name = name;
    }
}
`,

  // Method with throws
  methodWithThrows: `
public class FileHandler {
    /**
     * Reads a file.
     * @param path the file path
     * @return the file contents
     * @throws IOException if file cannot be read
     */
    public String readFile(String path) throws IOException {
        return "";
    }
}
`,

  // Missing @param documentation
  missingParam: `
public class Example {
    /**
     * Does something.
     * @return the result
     */
    public int process(int value) {
        return value * 2;
    }
}
`,

  // Extra @param documentation
  extraParam: `
public class Example {
    /**
     * Does something.
     * @param value the value
     * @param extra this doesn't exist
     * @return the result
     */
    public int process(int value) {
        return value * 2;
    }
}
`,

  // Missing @return documentation
  missingReturn: `
public class Example {
    /**
     * Does something.
     * @param value the value
     */
    public int process(int value) {
        return value * 2;
    }
}
`,

  // Extra @return on void method
  extraReturn: `
public class Example {
    /**
     * Does something.
     * @param value the value
     * @return nothing really
     */
    public void process(int value) {
        System.out.println(value);
    }
}
`,

  // Missing @throws documentation
  missingThrows: `
public class Example {
    /**
     * Does something.
     * @param path the path
     */
    public void process(String path) throws IOException {
        throw new IOException("error");
    }
}
`,

  // Extra @throws documentation
  extraThrows: `
public class Example {
    /**
     * Does something.
     * @param path the path
     * @throws IOException never happens
     */
    public void process(String path) {
        System.out.println(path);
    }
}
`,

  // Visibility: public/protected exported, package-private/private not exported
  visibilityMix: `
public class Example {
    /** Public method. */
    public void publicMethod() {}

    /** Protected method. */
    protected void protectedMethod() {}

    /** Package-private method - no modifier. */
    void packageMethod() {}

    /** Private method. */
    private void privateMethod() {}
}
`,

  // onlyExported=false should check all
  visibilityNoDoc: `
public class Example {
    public void publicMethod() {}
    protected void protectedMethod() {}
    void packageMethod() {}
    private void privateMethod() {}
}
`,

  // @inheritDoc handling
  inheritDoc: `
public class Child extends Parent {
    /**
     * {@inheritDoc}
     */
    @Override
    public void process(int value) {
        super.process(value);
    }
}
`,

  // Broken binding: code between Javadoc and declaration
  brokenBinding: `
public class Example {
    /** This Javadoc should NOT bind to doSomething */
    private int field = 0;

    public void doSomething() {}
}
`,

  // Javadoc with annotations (should still bind)
  javadocWithAnnotations: `
public class Example {
    /**
     * Overridden method.
     * @param value the value
     */
    @Override
    @SuppressWarnings("unchecked")
    public void process(int value) {}
}
`,

  // Generics in method
  genericsMethod: `
public class Container<T> {
    /**
     * Gets an item.
     * @param key the key
     * @return the item
     */
    public T get(String key) {
        return null;
    }

    /**
     * Sets an item.
     * @param key the key
     * @param value the value
     */
    public void set(String key, T value) {}
}
`,

  // Multiple throws
  multipleThrows: `
public class Example {
    /**
     * Risky operation.
     * @param path the path
     * @throws IOException if IO fails
     * @throws SecurityException if not allowed
     */
    public void riskyOp(String path) throws IOException, SecurityException {
        throw new IOException();
    }
}
`,

  // Parameter order mismatch
  paramOrderMismatch: `
public class Example {
    /**
     * Processes values.
     * @param b second param
     * @param a first param
     */
    public void process(int a, int b) {}
}
`,

  // Param name typo
  paramNameTypo: `
public class Example {
    /**
     * Processes a value.
     * @param valeu the value (typo)
     */
    public void process(int value) {}
}
`,

  // No documentation at all
  noDocumentation: `
public class Example {
    public void process(int value) {}
}
`,

  // Inner class
  innerClass: `
/**
 * Outer class.
 */
public class Outer {
    /**
     * Inner class.
     */
    public class Inner {
        /**
         * Inner method.
         */
        public void innerMethod() {}
    }
}
`,
};

// ============================================================================
// Helper Functions
// ============================================================================

async function analyzeFixture(
  content: string,
  options?: Partial<DocCheckOptions>
): Promise<FileCheckResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doccheck-java-test-'));
  const filePath = path.join(tmpDir, 'Test.java');

  try {
    await fs.writeFile(filePath, content, 'utf8');

    const checker = createJavaDocChecker(options);
    return await checker.checkFile(filePath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Java Documentation Checker', () => {
  describe('Type-level Javadoc binding', () => {
    it('should bind Javadoc to class declarations', async () => {
      const result = await analyzeFixture(FIXTURES.basicClass);

      expect(result.language).toBe('java');
      // Class has doc, no missing_doc for Calculator
      const classIssues = result.issues.filter(
        (i) => i.name === 'Calculator' && i.type === 'missing_doc'
      );
      expect(classIssues.length).toBe(0);
    });

    it('should bind Javadoc to interface declarations', async () => {
      const result = await analyzeFixture(FIXTURES.interfaceWithMethods);

      const interfaceIssues = result.issues.filter(
        (i) => i.name === 'Service' && i.type === 'missing_doc'
      );
      expect(interfaceIssues.length).toBe(0);
    });

    it('should bind Javadoc to enum declarations', async () => {
      const result = await analyzeFixture(FIXTURES.enumWithJavadoc);

      const enumIssues = result.issues.filter(
        (i) => i.name === 'Status' && i.type === 'missing_doc'
      );
      expect(enumIssues.length).toBe(0);
    });

    it('should bind Javadoc to annotation type declarations', async () => {
      const result = await analyzeFixture(FIXTURES.annotationType);

      const annotationIssues = result.issues.filter(
        (i) => i.name === 'Deprecated' && i.type === 'missing_doc'
      );
      expect(annotationIssues.length).toBe(0);
    });
  });

  describe('Method/Constructor Javadoc binding', () => {
    it('should bind Javadoc to method declarations', async () => {
      const result = await analyzeFixture(FIXTURES.basicClass);

      // Method has all @param and @return documented
      const methodIssues = result.issues.filter(
        (i) => i.name === 'Calculator.add'
      );
      expect(methodIssues.length).toBe(0);
    });

    it('should bind Javadoc to constructor declarations', async () => {
      const result = await analyzeFixture(FIXTURES.constructorWithJavadoc);

      const constructorIssues = result.issues.filter(
        (i) => i.name === 'User.User' || i.name === 'User'
      );
      // Only the class should have no issues, constructor is documented
      const missingDocIssues = constructorIssues.filter((i) => i.type === 'missing_doc');
      expect(missingDocIssues.length).toBe(0);
    });

    it('should check @param documentation', async () => {
      const result = await analyzeFixture(FIXTURES.missingParam);

      const paramIssues = result.issues.filter((i) => i.type === 'param_missing');
      expect(paramIssues.length).toBe(1);
      expect(paramIssues[0]!.message).toContain('value');
    });

    it('should detect extra @param documentation', async () => {
      const result = await analyzeFixture(FIXTURES.extraParam);

      const paramIssues = result.issues.filter((i) => i.type === 'param_extra');
      expect(paramIssues.length).toBe(1);
      expect(paramIssues[0]!.message).toContain('extra');
    });

    it('should check @return documentation', async () => {
      const result = await analyzeFixture(FIXTURES.missingReturn);

      const returnIssues = result.issues.filter((i) => i.type === 'return_missing');
      expect(returnIssues.length).toBe(1);
    });

    it('should detect extra @return on void method', async () => {
      const result = await analyzeFixture(FIXTURES.extraReturn);

      const returnIssues = result.issues.filter((i) => i.type === 'return_extra');
      expect(returnIssues.length).toBe(1);
    });

    it('should check @throws documentation', async () => {
      const result = await analyzeFixture(FIXTURES.methodWithThrows);

      // Should have no issues - throws is documented
      const throwsIssues = result.issues.filter(
        (i) => i.type === 'raises_missing' || i.type === 'raises_extra'
      );
      expect(throwsIssues.length).toBe(0);
    });

    it('should detect missing @throws documentation', async () => {
      const result = await analyzeFixture(FIXTURES.missingThrows);

      const throwsIssues = result.issues.filter((i) => i.type === 'raises_missing');
      expect(throwsIssues.length).toBe(1);
      expect(throwsIssues[0]!.message).toContain('IOException');
    });

    it('should detect extra @throws documentation', async () => {
      const result = await analyzeFixture(FIXTURES.extraThrows);

      const throwsIssues = result.issues.filter((i) => i.type === 'raises_extra');
      expect(throwsIssues.length).toBe(1);
      expect(throwsIssues[0]!.message).toContain('IOException');
    });

    it('should handle multiple throws clauses', async () => {
      const result = await analyzeFixture(FIXTURES.multipleThrows);

      // Both throws are documented
      const throwsIssues = result.issues.filter(
        (i) => i.type === 'raises_missing' || i.type === 'raises_extra'
      );
      expect(throwsIssues.length).toBe(0);
    });

    it('should detect parameter order mismatch', async () => {
      const result = await analyzeFixture(FIXTURES.paramOrderMismatch);

      const orderIssues = result.issues.filter((i) => i.type === 'param_order_mismatch');
      expect(orderIssues.length).toBe(1);
    });

    it('should detect parameter name typos', async () => {
      const result = await analyzeFixture(FIXTURES.paramNameTypo);

      // Should have both missing and extra, plus possible mismatch
      const paramIssues = result.issues.filter(
        (i) => i.type === 'param_missing' || i.type === 'param_extra' || i.type === 'param_name_mismatch'
      );
      expect(paramIssues.length).toBeGreaterThanOrEqual(2);

      // Should detect the typo similarity
      const mismatchIssues = result.issues.filter((i) => i.type === 'param_name_mismatch');
      expect(mismatchIssues.length).toBe(1);
    });
  });

  describe('onlyExported behavior', () => {
    it('should check only public/protected when onlyExported=true', async () => {
      const result = await analyzeFixture(FIXTURES.visibilityNoDoc, { onlyExported: true });

      // Should only report issues for public and protected methods
      const missingDocIssues = result.issues.filter((i) => i.type === 'missing_doc');
      const names = missingDocIssues.map((i) => i.name);

      expect(names).toContain('Example.publicMethod');
      expect(names).toContain('Example.protectedMethod');
      expect(names).not.toContain('Example.packageMethod');
      expect(names).not.toContain('Example.privateMethod');
    });

    it('should check all methods when onlyExported=false', async () => {
      const result = await analyzeFixture(FIXTURES.visibilityNoDoc, { onlyExported: false });

      const missingDocIssues = result.issues.filter((i) => i.type === 'missing_doc');
      const names = missingDocIssues.map((i) => i.name);

      expect(names).toContain('Example.publicMethod');
      expect(names).toContain('Example.protectedMethod');
      expect(names).toContain('Example.packageMethod');
      expect(names).toContain('Example.privateMethod');
    });

    it('should treat interface members as implicitly public', async () => {
      // Remove Javadoc from interface methods to test
      const fixture = `
public interface Service {
    String perform(String input);
    String getName();
}
`;
      const result = await analyzeFixture(fixture, { onlyExported: true });

      // Interface methods should be checked even without explicit public
      const missingDocIssues = result.issues.filter((i) => i.type === 'missing_doc');
      expect(missingDocIssues.length).toBeGreaterThanOrEqual(2);
    });

    it('should NOT check package-private interface when onlyExported=true', async () => {
      // Package-private interface (no modifier) should not be exported
      const fixture = `
interface InternalService {
    String process(String input);
}
`;
      const result = await analyzeFixture(fixture, { onlyExported: true });

      // Package-private interface and its members should NOT be checked
      const missingDocIssues = result.issues.filter((i) => i.type === 'missing_doc');
      expect(missingDocIssues.length).toBe(0);
    });
  });

  describe('@inheritDoc handling', () => {
    it('should treat @inheritDoc as doc.exists=true', async () => {
      const result = await analyzeFixture(FIXTURES.inheritDoc);

      // Should not report missing_doc for the method with @inheritDoc
      const missingDocIssues = result.issues.filter(
        (i) => i.type === 'missing_doc' && i.name.includes('process')
      );
      expect(missingDocIssues.length).toBe(0);
    });

    it('should still validate @inheritDoc methods (param check)', async () => {
      // @inheritDoc but missing @param - should still be flagged
      const fixture = `
public class Child extends Parent {
    /**
     * {@inheritDoc}
     */
    @Override
    public void process(int value) {}
}
`;
      const result = await analyzeFixture(fixture);

      // Should report missing @param since @inheritDoc doesn't skip validation
      const paramIssues = result.issues.filter((i) => i.type === 'param_missing');
      expect(paramIssues.length).toBe(1);
    });
  });

  describe('Broken binding rules', () => {
    it('should NOT bind Javadoc if non-modifier content is between', async () => {
      const result = await analyzeFixture(FIXTURES.brokenBinding);

      // doSomething should have no documentation (binding broken by field)
      const missingDocIssues = result.issues.filter(
        (i) => i.type === 'missing_doc' && i.name === 'Example.doSomething'
      );
      expect(missingDocIssues.length).toBe(1);
    });

    it('should still bind Javadoc through annotations', async () => {
      const result = await analyzeFixture(FIXTURES.javadocWithAnnotations);

      // Should have no missing_doc for process method
      const missingDocIssues = result.issues.filter(
        (i) => i.type === 'missing_doc' && i.name === 'Example.process'
      );
      expect(missingDocIssues.length).toBe(0);
    });
  });

  describe('Special cases', () => {
    it('should handle generics in methods', async () => {
      const result = await analyzeFixture(FIXTURES.genericsMethod);

      // Both methods should have no issues
      const containerIssues = result.issues.filter(
        (i) => i.name.startsWith('Container.')
      );
      expect(containerIssues.length).toBe(0);
    });

    it('should handle inner classes', async () => {
      const result = await analyzeFixture(FIXTURES.innerClass);

      // No issues expected - all have Javadoc
      const missingDocIssues = result.issues.filter((i) => i.type === 'missing_doc');
      expect(missingDocIssues.length).toBe(0);
    });

    it('should report missing doc when requireDocs=true', async () => {
      const result = await analyzeFixture(FIXTURES.noDocumentation, { requireDocs: true });

      const missingDocIssues = result.issues.filter((i) => i.type === 'missing_doc');
      expect(missingDocIssues.length).toBeGreaterThanOrEqual(1);
    });

    it('should NOT report missing doc when requireDocs=false', async () => {
      const result = await analyzeFixture(FIXTURES.noDocumentation, { requireDocs: false });

      const missingDocIssues = result.issues.filter((i) => i.type === 'missing_doc');
      expect(missingDocIssues.length).toBe(0);
    });
  });

  describe('Statistics', () => {
    it('should count functions checked and documented', async () => {
      const result = await analyzeFixture(FIXTURES.basicClass);

      expect(result.functionsChecked).toBeGreaterThanOrEqual(1);
      expect(result.functionsDocumented).toBeGreaterThanOrEqual(1);
    });

    it('should report language as java', async () => {
      const result = await analyzeFixture(FIXTURES.basicClass);

      expect(result.language).toBe('java');
    });
  });
});
