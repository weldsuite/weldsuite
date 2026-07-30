import { config } from "@weldsuite/eslint-config/react-internal"

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    rules: {
      // This package renders with styled-jsx (see `types: ["styled-jsx"]` in
      // tsconfig.json), whose `<style jsx>` / `<style jsx global>` attributes
      // eslint-plugin-react doesn't know about.
      "react/no-unknown-property": ["warn", { ignore: ["jsx", "global"] }],
    },
  },
]
