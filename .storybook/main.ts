import type { StorybookConfig } from "@storybook/html-vite";

/**
 * Storybook configuration for the as-graph package.
 *
 * Stories live under `tests/storybook/` so the published package (`src/`) stays
 * free of story-only code. They render the shared, DOM-free graph view models
 * (`@decaf-ts/as-graph/shared`) through the test-local DOM renderer.
 */
const config: StorybookConfig = {
  stories: ["../tests/storybook/**/*.stories.@(ts|js)"],
  addons: ["@storybook/addon-docs"],
  framework: {
    name: "@storybook/html-vite",
    options: {},
  },
};

export default config;
