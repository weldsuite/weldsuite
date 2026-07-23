import type { Config } from "tailwindcss";

const config: Pick<Config, "content"> = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../../packages/design/ui/components/**/*.{ts,tsx}",
  ],
};

export default config;
