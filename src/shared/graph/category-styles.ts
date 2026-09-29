/**
 * @module ui-decorators/graph/category-styles
 * @summary Built-in node/connection category style registrations.
 * @description Registers default colors and icons for the built-in node and
 * connection categories (DECAF-32 §21.2). The `color` / `icon` on a node's
 * `@node()` metadata are optional overrides — when omitted, the effective
 * style is resolved from the category registry.
 */
import { registerGraphCategoryStyle } from "./constants";

/**
 * Registers all built-in category styles. Called once at module init.
 *
 * Categories define the default visual style for nodes and connection ports.
 * A node's explicit `color` / `icon` (on `@node()`) overrides the category
 * style; when omitted, the category style is used.
 */
export function registerBuiltinCategoryStyles(): void {
  // Node categories
  registerGraphCategoryStyle("Trigger", { color: "#3b82f6", icon: "ti-bolt" });
  registerGraphCategoryStyle("Flow Control", { color: "#f59e0b", icon: "ti-arrows-split-2" });
  registerGraphCategoryStyle("Utility", { color: "#0d9488", icon: "ti-tool" });
  registerGraphCategoryStyle("Loop", { color: "#eab308", icon: "ti-repeat" });
  registerGraphCategoryStyle("Workflow", { color: "#f97316", icon: "ti-sitemap" });
  registerGraphCategoryStyle("Pipeline", { color: "#0ea5e9", icon: "ti-git-merge" });
  registerGraphCategoryStyle("Node", { color: "#8b5cf6", icon: "ti-point-filled" });
  registerGraphCategoryStyle("Agent", { color: "#7c3aed", icon: "ti-robot" });

  // Connection categories (for @connection() ports)
  registerGraphCategoryStyle("model", { color: "#3b82f6", icon: "ti-cpu" });
  registerGraphCategoryStyle("memory", { color: "#10b981", icon: "ti-database" });
  registerGraphCategoryStyle("workspace", { color: "#f59e0b", icon: "ti-folder" });
}

// Register at module load so the styles are available immediately.
registerBuiltinCategoryStyles();
