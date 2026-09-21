import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // services/agent-manager is a separate product (its own package.json,
    // own CommonJS/require()-based Node app, own .eslintrc) vendored
    // alongside this app - see .dockerignore's identical exclusion and
    // sidebar.tsx's "never touched, only looked at". Linting it against
    // THIS app's Next/TypeScript rules only produced 213 `no-require-imports`
    // errors that have nothing to do with either app's actual code health.
    "services/**",
  ]),
]);

export default eslintConfig;
