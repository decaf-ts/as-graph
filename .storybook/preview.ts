import type { Preview } from "@storybook/html-vite";

/**
 * Global Storybook preview for the as-graph stories.
 *
 * The graph view models are framework-neutral, so no renderer decorators are
 * required; each story renders its own DOM into the canvas.
 */
const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    docs: {
      codePanel: true,
    },
  },
};

export default preview;
