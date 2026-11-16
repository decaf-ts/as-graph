/* global module */
/**
 * Babel plugin for jest: lets ESM-only packages (NestJS 12) run in the
 * CommonJS test runtime by rewriting `import.meta.url` — which CommonJS has
 * no equivalent syntax for — to the module's file URL.
 */
module.exports = function importMetaToCommonJs({ types: t }) {
  return {
    name: "import-meta-to-commonjs",
    visitor: {
      MemberExpression(path) {
        const { object, property } = path.node;
        if (
          t.isMetaProperty(object) &&
          object.meta.name === "import" &&
          object.property.name === "meta" &&
          t.isIdentifier(property, { name: "url" })
        ) {
          // No `require` here: modules commonly bind their own
          // (`const require = createRequire(import.meta.url)`).
          path.replaceWithSourceString('new URL("file://" + __filename).href');
        }
      },
    },
  };
};
