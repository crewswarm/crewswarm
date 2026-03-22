/**
 * Template Registry
 * 
 * Instant, free file generation for common files.
 * No LLM calls needed for standard configs, gitignores, etc.
 * 
 * Cost: $0
 * Speed: <5ms
 */

import type { ProjectStructure } from '../utils/structure-analyzer.js';

export interface TemplateOptions {
  projectName?: string;
  author?: string;
  description?: string;
  license?: string;
  [key: string]: any;
}

export type TemplateGenerator = (
  structure: ProjectStructure,
  options?: TemplateOptions
) => string;

/**
 * Template registry - add new templates here
 */
export const TEMPLATE_REGISTRY: Record<string, TemplateGenerator> = {
  '.gitignore': generateGitignore,
  'package.json': generatePackageJson,
  'tsconfig.json': generateTsConfig,
  '.env.example': generateEnvExample,
  '.env': generateEnv,
  'README.md': generateReadme,
  '.prettierrc': generatePrettierConfig,
  '.eslintrc.json': generateEslintConfig,
  'jest.config.js': generateJestConfig,
  'vitest.config.ts': generateVitestConfig,
  '.dockerignore': generateDockerignore,
  'Dockerfile': generateDockerfile,
  '.editorconfig': generateEditorConfig
};

/**
 * Check if a filename has a template
 */
export function hasTemplate(filename: string): boolean {
  return filename in TEMPLATE_REGISTRY;
}

/**
 * Generate file content from template
 */
export function generateFromTemplate(
  filename: string,
  structure: ProjectStructure,
  options: TemplateOptions = {}
): string | null {
  const generator = TEMPLATE_REGISTRY[filename];
  if (!generator) return null;
  
  return generator(structure, options);
}

/**
 * Match task text to template (fuzzy matching)
 */
export function matchTemplate(
  task: string,
  structure: ProjectStructure,
  options: TemplateOptions = {}
): { filename: string; content: string } | null {
  const lower = task.toLowerCase();
  
  // Direct matches
  for (const filename of Object.keys(TEMPLATE_REGISTRY)) {
    if (lower.includes(filename.toLowerCase())) {
      const content = generateFromTemplate(filename, structure, options);
      if (content) return { filename, content };
    }
  }
  
  // Fuzzy matches
  if (/\b(gitignore|ignore file)\b/.test(lower)) {
    return { 
      filename: '.gitignore', 
      content: generateGitignore(structure, options) 
    };
  }
  
  if (/\b(package\.?json|npm init|package file)\b/.test(lower)) {
    return { 
      filename: 'package.json', 
      content: generatePackageJson(structure, options) 
    };
  }
  
  if (/\b(tsconfig|typescript config)\b/.test(lower)) {
    return { 
      filename: 'tsconfig.json', 
      content: generateTsConfig(structure, options) 
    };
  }
  
  if (/\b(readme|read me)\b/.test(lower)) {
    return { 
      filename: 'README.md', 
      content: generateReadme(structure, options) 
    };
  }
  
  if (/\b(env example|example env|\.env\.example)\b/.test(lower)) {
    return { 
      filename: '.env.example', 
      content: generateEnvExample(structure, options) 
    };
  }
  
  if (/\b(prettier|prettier config)\b/.test(lower)) {
    return { 
      filename: '.prettierrc', 
      content: generatePrettierConfig(structure, options) 
    };
  }
  
  if (/\b(eslint|eslintrc)\b/.test(lower)) {
    return { 
      filename: '.eslintrc.json', 
      content: generateEslintConfig(structure, options) 
    };
  }
  
  if (/\b(dockerfile|docker file)\b/.test(lower)) {
    return { 
      filename: 'Dockerfile', 
      content: generateDockerfile(structure, options) 
    };
  }
  
  return null;
}

// ============================================================================
// TEMPLATE GENERATORS
// ============================================================================

function generateGitignore(structure: ProjectStructure, options: TemplateOptions): string {
  const lines = [
    '# Dependencies',
    'node_modules/',
    '',
    '# Build output',
    'dist/',
    'build/',
  ];
  
  if (structure.framework === 'react') {
    lines.push('.next/');
    lines.push('out/');
  }
  
  if (structure.buildTool === 'vite') {
    lines.push('.vite/');
  }
  
  lines.push(
    '',
    '# Environment',
    '.env',
    '.env.local',
    '',
    '# IDE',
    '.vscode/',
    '.idea/',
    '.DS_Store',
    '',
    '# Logs',
    '*.log',
    'npm-debug.log*',
    '',
    '# Testing',
    'coverage/',
    '.nyc_output/',
    '',
    '# crew-cli',
    '.crew/'
  );
  
  return lines.join('\n') + '\n';
}

function generatePackageJson(structure: ProjectStructure, options: TemplateOptions): string {
  const pkg: any = {
    name: options.projectName || structure.packageName || 'my-project',
    version: '1.0.0',
    description: options.description || '',
    main: structure.hasSrc ? 'src/index.js' : 'index.js',
    scripts: {}
  };
  
  // Add framework-specific scripts
  if (structure.framework === 'react') {
    if (structure.buildTool === 'vite') {
      pkg.scripts = {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview'
      };
    } else {
      pkg.scripts = {
        start: 'react-scripts start',
        build: 'react-scripts build',
        test: 'react-scripts test'
      };
    }
  } else if (structure.framework === 'express') {
    pkg.scripts = {
      start: 'node src/index.js',
      dev: 'nodemon src/index.js'
    };
  }
  
  // Add test script
  if (structure.testFramework === 'jest') {
    pkg.scripts.test = 'jest';
  } else if (structure.testFramework === 'vitest') {
    pkg.scripts.test = 'vitest';
  }
  
  // Add TypeScript scripts
  if (structure.language === 'typescript' || structure.hasTsConfig) {
    pkg.scripts.build = 'tsc';
    pkg.scripts['type-check'] = 'tsc --noEmit';
  }
  
  if (options.author) {
    pkg.author = options.author;
  }
  
  if (options.license) {
    pkg.license = options.license;
  }
  
  return JSON.stringify(pkg, null, 2) + '\n';
}

function generateTsConfig(structure: ProjectStructure, options: TemplateOptions): string {
  const config: any = {
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      lib: ['ES2020'],
      outDir: './dist',
      rootDir: structure.hasSrc ? './src' : '.',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true
    },
    include: structure.hasSrc ? ['src/**/*'] : ['./**/*'],
    exclude: ['node_modules', 'dist', 'build']
  };
  
  // React-specific
  if (structure.framework === 'react') {
    config.compilerOptions.jsx = 'react-jsx';
    config.compilerOptions.lib.push('DOM', 'DOM.Iterable');
  }
  
  // Node-specific
  if (structure.framework === 'express' || structure.framework === 'fastify' || structure.framework === 'nest') {
    config.compilerOptions.moduleResolution = 'node';
    config.compilerOptions.types = ['node'];
  }
  
  return JSON.stringify(config, null, 2) + '\n';
}

function generateEnvExample(structure: ProjectStructure, options: TemplateOptions): string {
  const lines = ['# Environment Variables', ''];
  
  if (structure.framework === 'react') {
    lines.push('VITE_API_URL=http://localhost:3000');
    lines.push('VITE_APP_NAME=MyApp');
  } else if (structure.framework === 'express' || structure.framework === 'fastify') {
    lines.push('PORT=3000');
    lines.push('NODE_ENV=development');
    lines.push('DATABASE_URL=postgresql://localhost/myapp');
    lines.push('JWT_SECRET=your-secret-key');
  }
  
  lines.push('');
  lines.push('# API Keys');
  lines.push('API_KEY=your-api-key-here');
  
  return lines.join('\n') + '\n';
}

function generateEnv(structure: ProjectStructure, options: TemplateOptions): string {
  // Same as .env.example but with placeholder values
  return generateEnvExample(structure, options);
}

function generateReadme(structure: ProjectStructure, options: TemplateOptions): string {
  const name = options.projectName || structure.packageName || 'My Project';
  const description = options.description || 'A new project';
  
  return `# ${name}

${description}

## Getting Started

### Prerequisites

- Node.js 20+
${structure.language === 'typescript' ? '- TypeScript' : ''}

### Installation

\`\`\`bash
npm install
\`\`\`

### Development

\`\`\`bash
${structure.framework === 'react' && structure.buildTool === 'vite' ? 'npm run dev' : 'npm start'}
\`\`\`

${structure.testFramework ? `### Testing

\`\`\`bash
npm test
\`\`\`
` : ''}
## License

${options.license || 'MIT'}
`;
}

function generatePrettierConfig(structure: ProjectStructure, options: TemplateOptions): string {
  return JSON.stringify({
    semi: true,
    trailingComma: 'es5',
    singleQuote: true,
    printWidth: 100,
    tabWidth: 2
  }, null, 2) + '\n';
}

function generateEslintConfig(structure: ProjectStructure, options: TemplateOptions): string {
  const config: any = {
    env: {
      browser: structure.framework === 'react' || structure.framework === 'vue',
      es2021: true,
      node: true
    },
    extends: ['eslint:recommended'],
    parserOptions: {
      ecmaVersion: 2021,
      sourceType: 'module'
    },
    rules: {}
  };
  
  if (structure.language === 'typescript') {
    config.extends.push('plugin:@typescript-eslint/recommended');
    config.parser = '@typescript-eslint/parser';
  }
  
  if (structure.framework === 'react') {
    config.extends.push('plugin:react/recommended');
    config.extends.push('plugin:react-hooks/recommended');
  }
  
  return JSON.stringify(config, null, 2) + '\n';
}

function generateJestConfig(structure: ProjectStructure, options: TemplateOptions): string {
  return `module.exports = {
  testEnvironment: '${structure.framework === 'react' ? 'jsdom' : 'node'}',
  roots: ['<rootDir>/${structure.hasSrc ? 'src' : '.'}'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  collectCoverageFrom: [
    '${structure.hasSrc ? 'src' : '.'}/**/*.{js,ts}',
    '!**/*.d.ts',
    '!**/node_modules/**'
  ]
};
`;
}

function generateVitestConfig(structure: ProjectStructure, options: TemplateOptions): string {
  return `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: '${structure.framework === 'react' ? 'jsdom' : 'node'}',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html']
    }
  }
});
`;
}

function generateDockerignore(structure: ProjectStructure, options: TemplateOptions): string {
  return `node_modules/
npm-debug.log
.git/
.gitignore
.env
.env.local
dist/
build/
coverage/
.crew/
`;
}

function generateDockerfile(structure: ProjectStructure, options: TemplateOptions): string {
  if (structure.framework === 'react') {
    return `FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
  }
  
  // Node.js backend
  return `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
${structure.language === 'typescript' ? 'RUN npm run build\n' : ''}
EXPOSE 3000
CMD ["node", "${structure.language === 'typescript' ? 'dist/index.js' : 'src/index.js'}"]
`;
}

function generateEditorConfig(structure: ProjectStructure, options: TemplateOptions): string {
  return `root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
`;
}

/**
 * List all available templates
 */
export function listTemplates(): string[] {
  return Object.keys(TEMPLATE_REGISTRY).sort();
}

/**
 * Get template description
 */
export function getTemplateDescription(filename: string): string {
  const descriptions: Record<string, string> = {
    '.gitignore': 'Git ignore rules (Node.js + framework-specific)',
    'package.json': 'NPM package manifest with framework scripts',
    'tsconfig.json': 'TypeScript configuration',
    '.env.example': 'Environment variable template',
    '.env': 'Environment variables (same as .env.example)',
    'README.md': 'Project README with setup instructions',
    '.prettierrc': 'Prettier code formatter config',
    '.eslintrc.json': 'ESLint linter config',
    'jest.config.js': 'Jest testing framework config',
    'vitest.config.ts': 'Vitest testing framework config',
    '.dockerignore': 'Docker build ignore rules',
    'Dockerfile': 'Docker container definition',
    '.editorconfig': 'Editor configuration for consistent style'
  };
  
  return descriptions[filename] || 'Template file';
}
