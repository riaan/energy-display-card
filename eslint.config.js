import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "test/**"] },
  js.configs.recommended,
  {
    files: ["dist/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...globals.browser } },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...globals.node } },
  },
];
