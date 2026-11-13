const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Money modules: floats are banned. All amounts are integer kobo.
    files: [
      'src/modules/ledger/**',
      'src/modules/products/**',
      'src/modules/wallet/**',
      'src/modules/orders/**',
      'src/modules/payouts/**',
      'src/modules/disputes/**',
      'src/shared/money/**',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is integer kobo. Use shared/money/kobo.js.' },
      ],
      'no-restricted-properties': [
        'error',
        { property: 'toFixed', message: 'Money is integer kobo. Format only at the edge.' },
        { object: 'Number', property: 'parseFloat', message: 'Money is integer kobo.' },
      ],
    },
  },
  { ignores: ['node_modules/', 'coverage/'] },
];
