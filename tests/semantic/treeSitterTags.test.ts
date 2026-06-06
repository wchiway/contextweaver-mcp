import { describe, it, expect } from 'vitest';
import Parser from '@keqingmoe/tree-sitter';
import { extractTreeSitterSymbols } from '../../src/semantic/treeSitterTags.js';
import { getParser } from '../../src/chunking/ParserPool.js';

describe('extractTreeSitterSymbols', () => {
  it('should only extract definitions, not references', async () => {
    const code = `
def foo():
    pass

def bar():
    foo()  # This is a call/reference, should NOT be extracted
`;

    const parser = await getParser('python');
    if (!parser) throw new Error('Parser not available');

    const tree = parser.parse(code);

    const symbols = await extractTreeSitterSymbols({
      tree,
      grammar: parser.getLanguage(),
      relPath: 'test.py',
      hash: 'hash123',
      language: 'python',
    });

    // 应该只提取 foo 和 bar 的定义，不应该提取 foo() 调用
    expect(symbols.length).toBe(2);
    expect(symbols.map(s => s.name).sort()).toEqual(['bar', 'foo']);

    // 验证所有符号都是定义类型（function/class/method等）
    for (const sym of symbols) {
      expect(['function', 'class', 'method', 'interface', 'module']).toContain(sym.kind);
      expect(sym.kind).not.toBe('call');
      expect(sym.kind).not.toBe('reference');
    }
  });

  it('should extract class and method definitions', async () => {
    const code = `
class MyClass:
    def my_method(self):
        pass
`;

    const parser = await getParser('python');
    if (!parser) throw new Error('Parser not available');

    const tree = parser.parse(code);

    const symbols = await extractTreeSitterSymbols({
      tree,
      grammar: parser.getLanguage(),
      relPath: 'test.py',
      hash: 'hash123',
      language: 'python',
    });

    // 应该提取 MyClass 和 my_method
    expect(symbols.length).toBeGreaterThanOrEqual(2);
    const names = symbols.map(s => s.name);
    expect(names).toContain('MyClass');
    expect(names).toContain('my_method');
  });

  it('should handle TypeScript function and class definitions', async () => {
    const code = `
function myFunction() {
  return 42;
}

class MyClass {
  myMethod() {
    myFunction();  // call, should not be extracted
  }
}
`;

    const parser = await getParser('typescript');
    if (!parser) throw new Error('Parser not available');

    const tree = parser.parse(code);

    const symbols = await extractTreeSitterSymbols({
      tree,
      grammar: parser.getLanguage(),
      relPath: 'test.ts',
      hash: 'hash123',
      language: 'typescript',
    });

    // 验证不包含调用
    const names = symbols.map(s => s.name);
    expect(names).toContain('myFunction');
    expect(names).toContain('MyClass');

    // myFunction 调用应该不被提取（验证次数）
    const myFunctionCount = names.filter(n => n === 'myFunction').length;
    expect(myFunctionCount).toBe(1); // 只有定义，没有调用
  });

  it('should return empty array for unsupported language', async () => {
    const parser = await getParser('python');
    if (!parser) throw new Error('Parser not available');

    const tree = parser.parse('def foo(): pass');

    const symbols = await extractTreeSitterSymbols({
      tree,
      grammar: parser.getLanguage(),
      relPath: 'test.xyz',
      hash: 'hash123',
      language: 'unsupported',
    });

    expect(symbols).toEqual([]);
  });
});
