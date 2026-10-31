// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// Lint rules for `make lint` (and CI): GJS globals, catching real mistakes.
export default [
    {ignores: ['build/**']},
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {global: 'readonly', log: 'readonly', logError: 'readonly', console: 'readonly', print: 'readonly'},
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', {args: 'none'}],
            'no-unreachable': 'error',
            'no-dupe-keys': 'error',
            'no-redeclare': 'error',
            'eqeqeq': 'error',
            'prefer-const': 'error',
        },
    },
];
