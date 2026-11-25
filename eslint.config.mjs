import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["coverage/**", "dist/**", ".test-*/**"] },
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.{ts,mts,cts}"],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ["src/**/*.ts"],
    // Preserve existing public error messages and redaction behavior.
    rules: { "preserve-caught-error": "off" },
  },
);
