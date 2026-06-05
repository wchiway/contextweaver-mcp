/**
 * Tree-sitter 调用提取器
 *
 * 从 AST 中提取函数/方法调用站点，用于构建调用图。
 * 使用节点类型模式匹配，不依赖 tags.scm（更通用）。
 */

import type Parser from '@keqingmoe/tree-sitter';
import type { SyntaxNode } from '@keqingmoe/tree-sitter';

export interface CallSite {
  calleeName: string; // 被调用的函数/方法名
  line: number; // 调用发生的行号（1-based）
  qualifier?: string; // 限定符（如 obj.method 中的 obj）
}

interface CallNodeConfig {
  callTypes: string[]; // 调用表达式的节点类型
  calleeField?: string; // 子节点字段名（用于获取被调用对象）
  identifierTypes: string[]; // 标识符节点类型
}

// 语言特定的调用节点配置
const CALL_CONFIGS: Record<string, CallNodeConfig> = {
  typescript: {
    callTypes: ['call_expression'],
    calleeField: 'function',
    identifierTypes: ['identifier', 'property_identifier'],
  },
  javascript: {
    callTypes: ['call_expression'],
    calleeField: 'function',
    identifierTypes: ['identifier', 'property_identifier'],
  },
  python: {
    callTypes: ['call'],
    calleeField: 'function',
    identifierTypes: ['identifier', 'attribute'],
  },
  go: {
    callTypes: ['call_expression'],
    calleeField: 'function',
    identifierTypes: ['identifier', 'selector_expression', 'field_identifier'],
  },
  rust: {
    callTypes: ['call_expression'],
    calleeField: 'function',
    identifierTypes: ['identifier', 'field_expression'],
  },
  java: {
    callTypes: ['method_invocation'],
    // Java 的 method_invocation 没有 function 字段，直接用 name
    identifierTypes: ['identifier'],
  },
  c: {
    callTypes: ['call_expression'],
    calleeField: 'function',
    identifierTypes: ['identifier', 'field_expression'],
  },
  cpp: {
    callTypes: ['call_expression'],
    calleeField: 'function',
    identifierTypes: ['identifier', 'field_expression', 'qualified_identifier'],
  },
  c_sharp: {
    callTypes: ['invocation_expression'],
    calleeField: 'function',
    identifierTypes: ['identifier', 'member_access_expression'],
  },
  ruby: {
    callTypes: ['call'],
    calleeField: 'method',
    identifierTypes: ['identifier', 'constant'],
  },
  php: {
    callTypes: ['function_call_expression', 'member_call_expression'],
    identifierTypes: ['name', 'member_access_expression'],
  },
};

/**
 * 从调用表达式节点提取被调用者名称
 */
function extractCalleeName(
  node: SyntaxNode,
  config: CallNodeConfig,
  sourceCode: string,
): { name: string; qualifier?: string } | null {
  // 获取 callee 节点（Java 特殊处理）
  let calleeNode: SyntaxNode | null = null;

  if (config.calleeField) {
    calleeNode = node.childForFieldName(config.calleeField);
  } else {
    // Java: method_invocation 的 name 字段
    calleeNode = node.childForFieldName('name');
  }

  if (!calleeNode) return null;

  // 提取简单标识符（如 foo()）
  if (config.identifierTypes.includes(calleeNode.type)) {
    return { name: calleeNode.text };
  }

  // 处理成员访问（如 obj.method()）
  if (
    calleeNode.type === 'member_access_expression' ||
    calleeNode.type === 'field_expression' ||
    calleeNode.type === 'selector_expression' ||
    calleeNode.type === 'attribute' // Python
  ) {
    // 提取最右侧的标识符作为方法名
    const children = calleeNode.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (config.identifierTypes.includes(child.type)) {
        // 提取限定符（最左侧的标识符或表达式）
        const qualifier = children[0]?.type === 'identifier' ? children[0].text : undefined;
        return { name: child.text, qualifier };
      }
    }
  }

  // 处理 qualified_identifier（C++: ns::func）
  if (calleeNode.type === 'qualified_identifier') {
    const parts = calleeNode.text.split('::');
    return { name: parts[parts.length - 1], qualifier: parts[0] };
  }

  // 兜底：直接使用节点文本（可能包含复杂表达式）
  const text = calleeNode.text.trim();
  if (text.length > 0 && text.length < 100) {
    // 排除过长的表达式
    return { name: text };
  }

  return null;
}

/**
 * 遍历 AST 提取所有调用站点
 */
export function extractCallSites(tree: Parser.Tree, language: string): CallSite[] {
  const config = CALL_CONFIGS[language];
  if (!config) {
    // 不支持的语言，返回空数组
    return [];
  }

  const calls: CallSite[] = [];
  const sourceCode = tree.rootNode.text; // 用于提取节点文本

  function traverse(node: SyntaxNode) {
    // 检查是否为调用表达式
    if (config.callTypes.includes(node.type)) {
      const callee = extractCalleeName(node, config, sourceCode);
      if (callee && callee.name) {
        calls.push({
          calleeName: callee.name,
          line: node.startPosition.row + 1, // tree-sitter 行号从 0 开始
          qualifier: callee.qualifier,
        });
      }
    }

    // 递归遍历子节点
    for (const child of node.children) {
      traverse(child);
    }
  }

  traverse(tree.rootNode);
  return calls;
}

/**
 * 检查语言是否支持调用提取
 */
export function supportsCallExtraction(language: string): boolean {
  return language in CALL_CONFIGS;
}
