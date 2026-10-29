// ESLint (flat config, no plugins), run in CI with `npx eslint@9.20.0`. The site is plain browser scripts that
// share globals across files (app.js defines what the route scripts use), so no-undef is off; the rules below
// catch real mistakes and the patterns the Content-Security-Policy forbids (eval, new Function, javascript: URLs).
export default [
  {
    files: ["docs/assets/**/*.js"],
    ignores: ["docs/assets/i18n.ko.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "script" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-unreachable": "error", "no-dupe-keys": "error", "no-duplicate-case": "error", "no-redeclare": "error",
      "no-self-assign": "error", "no-self-compare": "error", "no-fallthrough": "error", "no-cond-assign": ["error", "except-parens"],
      "no-constant-condition": ["error", { checkLoops: false }], "no-debugger": "error", "no-empty": ["error", { allowEmptyCatch: true }],
      "no-eval": "error", "no-implied-eval": "error", "no-new-func": "error", "no-script-url": "error",
      "no-unsafe-finally": "error", "no-unsafe-negation": "error", "use-isnan": "error", "valid-typeof": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
];
