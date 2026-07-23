import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const config: StorybookConfig = {
  stories: ["../src/stories/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-a11y",
    "@storybook/addon-interactions",
    "@storybook/addon-themes",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  typescript: {
    reactDocgen: "react-docgen-typescript",
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      propFilter: (prop) => {
        if (prop.parent) {
          return (
            !prop.parent.fileName.includes("node_modules") ||
            prop.parent.fileName.includes("@radix-ui")
          );
        }
        return true;
      },
    },
  },
  viteFinal: async (config) => {
    config.plugins = config.plugins || [];
    config.plugins.push(tailwindcss());

    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "@weldsuite/ui": path.resolve(
        __dirname,
        "../../../../packages/design/ui/src"
      ),
      "next-themes": path.resolve(__dirname, "../src/mocks/next-themes.ts"),
    };

    return config;
  },
  docs: {
    autodocs: true,
  },
};

export default config;
