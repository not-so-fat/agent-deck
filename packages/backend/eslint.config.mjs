// ESLint 9 flat config (NOT-637). Non-type-checked recommended presets only.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'static-ui/**'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // 175 hits across workspaces (backend 122, frontend 34, shared 19); typing them is out of scope for NOT-637.
      '@typescript-eslint/no-explicit-any': 'off',
      // Leftover locals/params remain in non-import code; warn (not error) and honor the repo's `_` placeholder convention.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // ANSI/control-character stripping regexes intentionally match control characters.
      'no-control-regex': 'off',
      // server/index.ts declares a `let` that an earlier-registered onClose hook reads before its single assignment.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
);
