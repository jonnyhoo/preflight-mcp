import { describe, it, expect } from '@jest/globals';
import { extractOutlineWasm, type SymbolOutline } from '../../src/ast/treeSitter.js';

describe('extractOutlineWasm', () => {
  it('extracts function declarations', async () => {
    const code = `
export function greet(name: string): string {
  return 'Hello, ' + name;
}

function helper() {
  return 42;
}
`;
    const result = await extractOutlineWasm('test.ts', code);
    expect(result).not.toBeNull();
    expect(result!.language).toBe('typescript');
    expect(result!.outline.length).toBe(2);
    
    const greet = result!.outline.find(s => s.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.kind).toBe('function');
    expect(greet!.exported).toBe(true);
    expect(greet!.signature).toContain('name: string');
    
    const helper = result!.outline.find(s => s.name === 'helper');
    expect(helper).toBeDefined();
    expect(helper!.exported).toBe(false);
  });

  it('extracts class with methods', async () => {
    const code = `
export class MyService {
  private value: number;
  
  constructor(value: number) {
    this.value = value;
  }
  
  getValue(): number {
    return this.value;
  }
  
  setValue(v: number): void {
    this.value = v;
  }
}
`;
    const result = await extractOutlineWasm('test.ts', code);
    expect(result).not.toBeNull();
    
    const cls = result!.outline.find(s => s.name === 'MyService');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.exported).toBe(true);
    expect(cls!.children).toBeDefined();
    expect(cls!.children!.length).toBeGreaterThanOrEqual(2);
    
    const getValue = cls!.children!.find(m => m.name === 'getValue');
    expect(getValue).toBeDefined();
    expect(getValue!.kind).toBe('method');
  });

  it('extracts interfaces and types', async () => {
    const code = `
export interface User {
  id: string;
  name: string;
}

export type UserRole = 'admin' | 'user';

enum Status {
  Active,
  Inactive
}
`;
    const result = await extractOutlineWasm('test.ts', code);
    expect(result).not.toBeNull();
    
    const iface = result!.outline.find(s => s.name === 'User');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
    expect(iface!.exported).toBe(true);
    
    const typeAlias = result!.outline.find(s => s.name === 'UserRole');
    expect(typeAlias).toBeDefined();
    expect(typeAlias!.kind).toBe('type');
    
    const enumType = result!.outline.find(s => s.name === 'Status');
    expect(enumType).toBeDefined();
    expect(enumType!.kind).toBe('enum');
  });

  it('extracts arrow functions as variables', async () => {
    const code = `
export const add = (a: number, b: number): number => a + b;

const multiply = (a: number, b: number) => a * b;
`;
    const result = await extractOutlineWasm('test.ts', code);
    expect(result).not.toBeNull();
    
    const add = result!.outline.find(s => s.name === 'add');
    expect(add).toBeDefined();
    expect(add!.kind).toBe('function'); // Arrow functions are classified as functions
    expect(add!.exported).toBe(true);
  });

  it('returns null for unsupported file types', async () => {
    const code = `fn main() { println!("hello"); }`;
    const result = await extractOutlineWasm('test.rs', code);
    expect(result).toBeNull(); // Rust not yet supported
  });

  it('extracts Python functions and classes', async () => {
    const code = `
def greet(name: str) -> str:
    """Greet someone."""
    return f"Hello, {name}"

def _private_helper():
    pass

class UserService:
    def __init__(self, db):
        self.db = db
    
    def get_user(self, user_id: int) -> dict:
        return self.db.find(user_id)
    
    def _internal(self):
        pass
`;
    const result = await extractOutlineWasm('service.py', code);
    expect(result).not.toBeNull();
    expect(result!.language).toBe('python');
    
    // Check function
    const greet = result!.outline.find(s => s.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.kind).toBe('function');
    expect(greet!.exported).toBe(true);
    expect(greet!.signature).toContain('name: str');
    
    // Private function should not be exported
    const helper = result!.outline.find(s => s.name === '_private_helper');
    expect(helper).toBeDefined();
    expect(helper!.exported).toBe(false);
    
    // Check class
    const cls = result!.outline.find(s => s.name === 'UserService');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.children).toBeDefined();
    expect(cls!.children!.length).toBeGreaterThanOrEqual(2);
    
    // __init__ should be included
    const init = cls!.children!.find(m => m.name === '__init__');
    expect(init).toBeDefined();
  });

  it('respects Python __all__ for exports', async () => {
    const code = `
__all__ = ['public_func', 'PublicClass']

def public_func():
    pass

def another_func():
    pass

class PublicClass:
    pass

class AnotherClass:
    pass
`;
    const result = await extractOutlineWasm('module.py', code);
    expect(result).not.toBeNull();
    
    const publicFunc = result!.outline.find(s => s.name === 'public_func');
    expect(publicFunc!.exported).toBe(true);
    
    const anotherFunc = result!.outline.find(s => s.name === 'another_func');
    expect(anotherFunc!.exported).toBe(false); // Not in __all__
    
    const publicClass = result!.outline.find(s => s.name === 'PublicClass');
    expect(publicClass!.exported).toBe(true);
    
    const anotherClass = result!.outline.find(s => s.name === 'AnotherClass');
    expect(anotherClass!.exported).toBe(false); // Not in __all__
  });

  it('handles JavaScript files', async () => {
    const code = `
function hello() {
  console.log('Hello');
}

class Greeter {
  greet() {
    return 'Hi';
  }
}
`;
    const result = await extractOutlineWasm('test.js', code);
    expect(result).not.toBeNull();
    expect(result!.language).toBe('javascript');
    expect(result!.outline.length).toBe(2);
  });

  it('extracts Go functions, methods, and types', async () => {
    const code = `
package main

import "fmt"

// User represents a user in the system
type User struct {
    ID   int
    Name string
}

// Greeter interface for greeting
type Greeter interface {
    Greet() string
}

// NewUser creates a new user
func NewUser(id int, name string) *User {
    return &User{ID: id, Name: name}
}

// helper is a private function
func helper() {
    fmt.Println("helper")
}

// GetName returns the user's name
func (u *User) GetName() string {
    return u.Name
}

// setName is a private method
func (u *User) setName(name string) {
    u.Name = name
}
`;
    const result = await extractOutlineWasm('main.go', code);
    expect(result).not.toBeNull();
    expect(result!.language).toBe('go');
    
    // Check struct (treated as class)
    const userStruct = result!.outline.find(s => s.name === 'User');
    expect(userStruct).toBeDefined();
    expect(userStruct!.kind).toBe('class');
    expect(userStruct!.exported).toBe(true);
    
    // Check interface
    const greeterInterface = result!.outline.find(s => s.name === 'Greeter');
    expect(greeterInterface).toBeDefined();
    expect(greeterInterface!.kind).toBe('interface');
    expect(greeterInterface!.exported).toBe(true);
    
    // Check exported function
    const newUser = result!.outline.find(s => s.name === 'NewUser');
    expect(newUser).toBeDefined();
    expect(newUser!.kind).toBe('function');
    expect(newUser!.exported).toBe(true);
    expect(newUser!.signature).toContain('id int');
    
    // Check private function
    const helperFn = result!.outline.find(s => s.name === 'helper');
    expect(helperFn).toBeDefined();
    expect(helperFn!.exported).toBe(false);
    
    // Check exported method
    const getName = result!.outline.find(s => s.name === 'GetName');
    expect(getName).toBeDefined();
    expect(getName!.kind).toBe('method');
    expect(getName!.exported).toBe(true);
    
    // Check private method
    const setName = result!.outline.find(s => s.name === 'setName');
    expect(setName).toBeDefined();
    expect(setName!.exported).toBe(false);
  });
});
