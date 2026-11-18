// ESLint 10 flat config (NOT-637). Non-type-checked recommended presets only.
import { fixupPluginRules } from '@eslint/compat';
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      globals: globals.browser,
    },
    settings: {
      // Explicit version: eslint-plugin-react@7 'detect' calls context.getFilename(), removed in ESLint 10.
      react: { version: '19.2' },
    },
    plugins: {
      // eslint-plugin-react@7 and eslint-plugin-react-hooks@4 call context methods removed in
      // ESLint 10 (getFilename, getSourceCode, ...); fixupPluginRules shims them.
      react: fixupPluginRules(react),
      // eslint-plugin-react-hooks@4 ships only a legacy-format preset, so wire its rules by hand.
      'react-hooks': fixupPluginRules(reactHooks),
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      // 34 hits; typing them is out of scope for NOT-637.
      '@typescript-eslint/no-explicit-any': 'off',
      // Leftover locals/params remain in non-import code; warn (not error) and honor the repo's `_` placeholder convention.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // 14 hits in files that co-export helpers/variants with components; HMR-only concern, so warn.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // TypeScript props types replace runtime prop-types.
      'react/prop-types': 'off',
    },
  },
  {
    files: ['src/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      // Test wrappers are anonymous render helpers; display names add nothing there.
      'react/display-name': 'off',
    },
  },
);
