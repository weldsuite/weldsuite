import type { Config } from "tailwindcss"
// @ts-ignore
import sharedConfig from "@weldsuite/ui/tailwind.config"

const config: Pick<Config, "content" | "presets"> = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../../packages/design/ui/components/**/*.{ts,tsx}",
  ],
  presets: [sharedConfig],
}

export default config