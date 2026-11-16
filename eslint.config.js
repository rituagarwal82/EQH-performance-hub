import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // ── The four bypasses that produced real, verified garbage on screen ──
  // Enforced as build errors rather than discipline.
  {
    files: ["src/routes/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    ignores: ["src/components/MetricValue.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/format",
              importNames: ["formatINR", "formatInt", "formatPercent", "formatRatio"],
              message:
                "Formatters are reachable only through <MetricValue>. Rendering a raw number bypasses the measured/partial/modelled/suspect/unmeasured state and is how an unmeasured figure gets printed as fact.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression > MemberExpression[property.name='toFixed']",
          message:
            "No .toFixed() in routes or components — format through <MetricValue>, which cannot drop the metric state.",
        },
        {
          selector: "LogicalExpression[operator='??'][right.value=0]",
          message:
            "`?? 0` is banned. It coerced 138 sessions with no registrant count into a total captioned 'Registrants'. Use fromNullable() and let the value be unmeasured.",
        },
        {
          selector: "JSXAttribute[name.name='yAxisId']",
          message: "No dual axes, ever — two scales on one chart invent a relationship.",
        },
      ],
    },
  },
  eslintPluginPrettier,
);
