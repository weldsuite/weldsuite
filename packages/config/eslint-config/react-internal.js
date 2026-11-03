import js from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier"
import pluginJsxA11y from "eslint-plugin-jsx-a11y"
import pluginReact from "eslint-plugin-react"
import pluginReactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

import { config as baseConfig, unusedVarsRule } from "./base.js"

/**
 * A custom ESLint configuration for libraries that use React.
 *
 * @type {import("eslint").Linter.Config} */
export const config = [
  ...baseConfig,
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  pluginReact.configs.flat.recommended,
  // Accessibility. Like every rule here these report as warnings (see
  // eslint-plugin-only-warn in base.js), so a package that lints with
  // `--max-warnings 0` (packages/design/ui) enforces them.
  pluginJsxA11y.flatConfigs.recommended,
  {
    languageOptions: {
      ...pluginReact.configs.flat.recommended.languageOptions,
      globals: {
        ...globals.serviceworker,
        ...globals.browser,
      },
    },
  },
  {
    plugins: {
      "react-hooks": pluginReactHooks,
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...pluginReactHooks.configs.recommended.rules,
      // autoFocus is right in the popovers, dialogs and inline editors that
      // use it here (the user just opened them); page-level autoFocus is a
      // review item, not something a lint rule can tell apart.
      "jsx-a11y/no-autofocus": "off",
      // Our <video>/<audio> elements are live call streams and customer
      // uploads; there is no caption track to attach.
      "jsx-a11y/media-has-caption": "off",
      // Our controls are components (Radix RadioGroupItem is a <button>);
      // a <label> wrapping one is associated with it.
      "jsx-a11y/label-has-associated-control": [
        "warn",
        {
          assert: "either",
          depth: 3,
          controlComponents: [
            "Input",
            "Textarea",
            "Checkbox",
            "RadioGroupItem",
            "Switch",
            "SelectTrigger",
          ],
        },
      ],
      // React scope no longer necessary with new JSX transform.
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // Must come after the `tseslint.configs.recommended` spread above,
      // which would otherwise reset this rule to its default options.
      ...unusedVarsRule,
    },
  },
]
