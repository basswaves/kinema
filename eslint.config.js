import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  { ignores: ['dist', 'src-tauri/target', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // This is the rule that matters most here. A missing dependency does not
      // fail the build or the type check — it silently produces a stale
      // closure, which is exactly how the matcher ended up reading an empty
      // TMDB key while the UI showed the key as present. Error, not warning.
      'react-hooks/exhaustive-deps': 'error',

      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Unused variables are usually a sign something was half-refactored.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
