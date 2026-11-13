import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  // `.claude`: Claude Code's worktrees, whole copies of the project.
  // test-results: Playwright empties it while verify's lint walks the tree beside it.
  { ignores: ['dist', 'src-tauri/target', 'node_modules', '.claude', 'test-results', 'notes'] },
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
  },
  // A fixed wait is a guess about timing, and the guess fails on a slow
  // machine. The tests wait for a state (expect.poll, drawn, settled, the
  // focus key); input pacing and checks that measure time on purpose go
  // through `pause(page, ms, why)` in e2e/kb.ts, the one place it is allowed.
  {
    files: ['e2e/**/*.ts'],
    ignores: ['e2e/kb.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='waitForTimeout']",
          message: 'No fixed waits: wait for a state, or use pause(page, ms, why) from e2e/kb.ts for input pacing.',
        },
      ],
    },
  }
);
