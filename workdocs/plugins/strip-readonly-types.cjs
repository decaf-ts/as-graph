/**
 * Element-type aliases for `const` tuple vocabularies: better-docs/typescript
 * emits `(typeof NAME)[number]` for fields typed with a const-array element,
 * which catharsis cannot parse; these map to the exported union aliases.
 */
const CONST_TUPLE_ELEMENT_ALIASES = {
  MASTRA_INPUT_PROCESSOR_TYPES: "MastraInputProcessorType",
  MASTRA_OUTPUT_PROCESSOR_TYPES: "MastraOutputProcessorType",
  MASTRA_GUARDRAIL_TYPES: "MastraGuardrailType",
};

exports.handlers = {
  beforeParse: function (e) {
    if (typeof e.source !== "string") {
      return;
    }
    e.source = e.source
      .replace(/@(param|return|type|typedef|property) \{readonly /g, "@$1 {")
      .replace(/@(param|return|type|typedef|property) \{Array<readonly /g, "@$1 {Array<")
      .replace(
        /@(param|return|type|typedef|property) \{([A-Za-z_$][\w$.]*)\["([^"\]]+)"\]\}/g,
        "@$1 {$2.$3}"
      )
      .replace(
        /@(param|return|type|typedef|property) \{([^{}@]+)\}/g,
        function (match, tag, type) {
          const fixed = type
            .replace(
              /\(typeof ([A-Za-z_$][\w$.]*)\)\[number\]/g,
              function (_, name) {
                return CONST_TUPLE_ELEMENT_ALIASES[name] || name;
              }
            )
            .replace(/([A-Za-z_$][\w$.]*)\["([^"\]]+)"\]/g, "$1.$2");
          return fixed === type ? match : "@".concat(tag, " {", fixed, "}");
        }
      );
  },
};
