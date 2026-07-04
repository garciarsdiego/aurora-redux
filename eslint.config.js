// Flat ESLint config (ESLint 9+). See https://eslint.org/docs/latest/use/configure/configuration-files.
//
// Phase 0 baseline strategy:
//   - HARD errors (block the build): only the safety rules — banned APIs
//     (eval / new Function), unsafe TS comments without justification.
//   - WARNINGS: everything inherited from typescript-eslint/recommended,
//     so the existing codebase passes today and noise is visible. Phase 4
//     can promote warnings to errors as the codebase is swept.
//
// Unknown-rule directives (e.g. `// eslint-disable-next-line react-hooks/...`)
// are downgraded so disable comments that reference unloaded plugins do not
// blow up CI.

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.git/**',
      '**/.opencode/**',
      '**/.claude/**',
      '**/.mavis/**',
      '**/.devin/**',
      '**/apps/dashboard/**',
      '**/apps/dashboard-v2/dist/**',
      '**/apps/dashboard-v2/coverage/**',
      'data/**',
      'workspaces/**',
      '**/scripts/**',
      '**/tests/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['src/**/*.ts', 'apps/dashboard-v2/src/**/*.{ts,tsx}'],
    linterOptions: {
      // Disable comments may reference plugins we haven't loaded
      // (react-hooks, etc.). Skip rather than error.
      reportUnusedDisableDirectives: 'off',
    },
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['src/**/*.ts', 'apps/dashboard-v2/src/**/*.{ts,tsx}'],
  })),
  {
    files: ['apps/dashboard-v2/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/**/*.ts', 'apps/dashboard-v2/src/**/*.{ts,tsx}'],
    rules: {
      // Soften every typescript-eslint/recommended rule to warn for the
      // Phase 0 baseline. Hard errors are added below the spread.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
      '@typescript-eslint/prefer-as-const': 'warn',
      '@typescript-eslint/triple-slash-reference': 'warn',
      'prefer-const': 'warn',
      // Audit baseline (Week 2 / P-15): zero truly empty catches in src/ today,
      // so tighten this to flag any new ones. Comments inside the catch body
      // (e.g. `catch { /* best-effort */ }`) keep the block non-empty.
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-prototype-builtins': 'warn',
      'no-useless-escape': 'warn',
      'no-case-declarations': 'warn',
      'no-async-promise-executor': 'warn',
      'no-control-regex': 'warn',
      'no-misleading-character-class': 'warn',
      'no-cond-assign': 'warn',
      'no-fallthrough': 'warn',
      'no-self-assign': 'warn',
      'no-undef': 'warn',
      'no-console': 'off',

      // Hard errors — block on these:
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name="eval"]',
          message:
            'eval() is forbidden. Use src/brain/executor/step-executors/safe-vm-eval.ts when sandboxed evaluation is required.',
        },
        {
          selector: 'NewExpression[callee.name="Function"]',
          message:
            'new Function() is forbidden. Use src/brain/executor/step-executors/safe-vm-eval.ts when sandboxed evaluation is required.',
        },
      ],
    },
  },
);
