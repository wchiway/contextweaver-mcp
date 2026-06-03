/**
 * 多语言配置规范
 *
 * 定义每种语言的层级节点类型和名称提取字段，
 * 用于在遍历 AST 时捕获语义层级。
 */

export interface LanguageSpecConfig {
  /** 触发上下文更新的节点类型 */
  hierarchy: Set<string>;
  /** 提取名称的字段列表（按优先级顺序） */
  nameFields: string[];
  /** 名称节点类型（用于遍历 namedChildren 时识别名称节点） */
  nameNodeTypes: Set<string>;
  /** 节点类型到前缀的映射（用于生成 contextPath） */
  prefixMap: Record<string, string>;
  /** 注释节点类型（用于前向吸附） */
  commentTypes: Set<string>;
}

/**
 * 语言规范映射表
 */
const LANGUAGE_SPECS: Record<string, LanguageSpecConfig> = {
  typescript: {
    hierarchy: new Set([
      'class_declaration',
      'abstract_class_declaration',
      'interface_declaration',
      'function_declaration',
      'generator_function_declaration',
      'method_definition',
      'arrow_function',
      'export_statement',
      'import_statement',
    ]),
    nameFields: ['name', 'id'],
    nameNodeTypes: new Set(['identifier', 'type_identifier', 'property_identifier']),
    prefixMap: {
      class_declaration: 'class ',
      abstract_class_declaration: 'abstract class ',
      interface_declaration: 'interface ',
      function_declaration: 'fn ',
      generator_function_declaration: 'fn* ',
      method_definition: '',
      arrow_function: '',
    },
    commentTypes: new Set(['comment']),
  },

  javascript: {
    hierarchy: new Set([
      'class_declaration',
      'function_declaration',
      'generator_function_declaration',
      'method_definition',
      'arrow_function',
    ]),
    nameFields: ['name', 'id'],
    nameNodeTypes: new Set(['identifier', 'property_identifier']),
    prefixMap: {
      class_declaration: 'class ',
      function_declaration: 'fn ',
      generator_function_declaration: 'fn* ',
      method_definition: '',
      arrow_function: '',
    },
    commentTypes: new Set(['comment']),
  },

  python: {
    hierarchy: new Set(['class_definition', 'function_definition', 'decorated_definition']),
    nameFields: ['name'],
    nameNodeTypes: new Set(['identifier']),
    prefixMap: {
      class_definition: 'class ',
      function_definition: 'def ',
      decorated_definition: '',
    },
    commentTypes: new Set(['comment']),
  },

  go: {
    hierarchy: new Set([
      'function_declaration',
      'method_declaration',
      'type_spec',
      'type_declaration',
      'struct_type',
      'interface_type',
    ]),
    nameFields: ['name'],
    nameNodeTypes: new Set(['identifier', 'type_identifier', 'field_identifier']),
    prefixMap: {
      function_declaration: 'func ',
      method_declaration: 'func ',
      type_spec: 'type ',
      type_declaration: 'type ',
      struct_type: 'struct ',
      interface_type: 'interface ',
    },
    commentTypes: new Set(['comment']),
  },

  rust: {
    hierarchy: new Set([
      'function_item',
      'struct_item',
      'enum_item',
      'trait_item',
      'impl_item',
      'mod_item',
      'type_item',
    ]),
    nameFields: ['name'],
    nameNodeTypes: new Set(['identifier', 'type_identifier']),
    prefixMap: {
      function_item: 'fn ',
      struct_item: 'struct ',
      enum_item: 'enum ',
      trait_item: 'trait ',
      impl_item: 'impl ',
      mod_item: 'mod ',
      type_item: 'type ',
    },
    commentTypes: new Set(['line_comment', 'block_comment']),
  },

  java: {
    hierarchy: new Set([
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'annotation_type_declaration',
      'method_declaration',
      'constructor_declaration',
      'record_declaration',
    ]),
    nameFields: ['name', 'identifier'],
    nameNodeTypes: new Set(['identifier']),
    prefixMap: {
      class_declaration: 'class ',
      interface_declaration: 'interface ',
      enum_declaration: 'enum ',
      annotation_type_declaration: '@interface ',
      method_declaration: '',
      constructor_declaration: '',
      record_declaration: 'record ',
    },
    commentTypes: new Set(['line_comment', 'block_comment']),
  },

  c: {
    hierarchy: new Set([
      'function_definition',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
      'type_definition',
    ]),
    nameFields: ['declarator', 'name'],
    nameNodeTypes: new Set(['identifier', 'type_identifier', 'field_identifier']),
    prefixMap: {
      function_definition: '',
      struct_specifier: 'struct ',
      union_specifier: 'union ',
      enum_specifier: 'enum ',
      type_definition: 'typedef ',
    },
    commentTypes: new Set(['comment']),
  },

  cpp: {
    hierarchy: new Set([
      'function_definition',
      'class_specifier',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
      'namespace_definition',
      'template_declaration',
      'type_definition',
    ]),
    nameFields: ['declarator', 'name'],
    nameNodeTypes: new Set([
      'identifier',
      'type_identifier',
      'field_identifier',
      'namespace_identifier',
    ]),
    prefixMap: {
      function_definition: '',
      class_specifier: 'class ',
      struct_specifier: 'struct ',
      union_specifier: 'union ',
      enum_specifier: 'enum ',
      namespace_definition: 'namespace ',
      template_declaration: 'template ',
      type_definition: 'typedef ',
    },
    commentTypes: new Set(['comment']),
  },

  c_sharp: {
    hierarchy: new Set([
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'enum_declaration',
      'record_declaration',
      'method_declaration',
      'constructor_declaration',
      'property_declaration',
      'namespace_declaration',
    ]),
    nameFields: ['name', 'identifier'],
    nameNodeTypes: new Set(['identifier']),
    prefixMap: {
      class_declaration: 'class ',
      interface_declaration: 'interface ',
      struct_declaration: 'struct ',
      enum_declaration: 'enum ',
      record_declaration: 'record ',
      method_declaration: '',
      constructor_declaration: '',
      property_declaration: '',
      namespace_declaration: 'namespace ',
    },
    commentTypes: new Set(['comment']),
  },

  ruby: {
    hierarchy: new Set(['module', 'class', 'singleton_class', 'method', 'singleton_method']),
    nameFields: ['name'],
    nameNodeTypes: new Set(['constant', 'identifier']),
    prefixMap: {
      module: 'module ',
      class: 'class ',
      singleton_class: 'class ',
      method: 'def ',
      singleton_method: 'def ',
    },
    commentTypes: new Set(['comment']),
  },

  php: {
    hierarchy: new Set([
      'namespace_definition',
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
      'method_declaration',
      'function_definition',
    ]),
    nameFields: ['name'],
    nameNodeTypes: new Set(['name']),
    prefixMap: {
      namespace_definition: 'namespace ',
      class_declaration: 'class ',
      interface_declaration: 'interface ',
      trait_declaration: 'trait ',
      enum_declaration: 'enum ',
      method_declaration: '',
      function_definition: 'function ',
    },
    commentTypes: new Set(['comment']),
  },

  kotlin: {
    hierarchy: new Set(['class_declaration', 'object_declaration', 'function_declaration']),
    nameFields: ['name'],
    nameNodeTypes: new Set(['type_identifier', 'simple_identifier']),
    prefixMap: {
      class_declaration: 'class ',
      object_declaration: 'object ',
      function_declaration: 'fun ',
    },
    commentTypes: new Set(['line_comment', 'multiline_comment']),
  },

  swift: {
    hierarchy: new Set([
      'class_declaration',
      'protocol_declaration',
      'function_declaration',
      'init_declaration',
    ]),
    nameFields: ['name'],
    nameNodeTypes: new Set(['type_identifier', 'simple_identifier']),
    prefixMap: {
      class_declaration: 'type ',
      protocol_declaration: 'protocol ',
      function_declaration: 'func ',
      init_declaration: 'init ',
    },
    commentTypes: new Set(['comment', 'multiline_comment']),
  },

  lua: {
    hierarchy: new Set(['function_declaration', 'function_definition']),
    nameFields: ['name'],
    nameNodeTypes: new Set(['identifier', 'dot_index_expression', 'method_index_expression']),
    prefixMap: {
      function_declaration: 'function ',
      function_definition: 'function ',
    },
    commentTypes: new Set(['comment']),
  },

  shell: {
    hierarchy: new Set(['function_definition']),
    nameFields: ['name'],
    nameNodeTypes: new Set(['word']),
    prefixMap: {
      function_definition: 'function ',
    },
    commentTypes: new Set(['comment']),
  },
};

/**
 * 获取指定语言的规范配置
 * @param language 语言标识
 * @returns 语言规范配置，如果不支持则返回 null
 */
export function getLanguageSpec(language: string): LanguageSpecConfig | null {
  return LANGUAGE_SPECS[language] ?? null;
}
