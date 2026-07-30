import { config } from "@weldsuite/eslint-config/react-internal"

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    rules: {
      // A few components render scoped CSS with styled-jsx, whose
      // `<style jsx>` / `<style jsx global>` attributes eslint-plugin-react
      // doesn't know about.
      "react/no-unknown-property": ["warn", { ignore: ["jsx", "global"] }],
    },
  },
]
