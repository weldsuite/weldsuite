import type { Preview } from "@storybook/react";
import { withThemeByClassName } from "@storybook/addon-themes";

import "../src/styles/storybook.css";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    layout: "centered",
    docs: {
      toc: true,
    },
  },
  decorators: [
    withThemeByClassName({
      themes: {
        Light: "",
        Dark: "dark",
      },
      defaultTheme: "Light",
      parentSelector: "html",
    }),
  ],
  tags: ["autodocs"],
};

export default preview;
