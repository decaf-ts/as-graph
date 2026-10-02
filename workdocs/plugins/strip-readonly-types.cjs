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
      );
  },
};
