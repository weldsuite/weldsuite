import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "../../../packages/design/ui/src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../../packages/design/site-components/src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  presets: [require("@weldsuite/ui/tailwind.config")],
};

export default config;