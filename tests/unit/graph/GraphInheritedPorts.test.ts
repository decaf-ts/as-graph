/**
 * @module as-graph/tests/unit/graph/GraphInheritedPorts.test
 * @summary A node class keeps the ports its base class declares.
 * @description `Metadata.properties` answers from a constructor's own property
 * index when it is non-empty, which made a subclass with decorated properties
 * of its own drop every port its base declared. The Google Cloud Storage and
 * Azure Storage nodes published no `operation` input and no output at all, so
 * no document using them could pass validation.
 */
import { describe, it, expect } from "@jest/globals";
import { GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND } from "../../../src/node";

const ids = (ports: { id: string }[]) => ports.map((port) => port.id);

describe("inherited node ports", () => {
  it.each([
    ["core.storage.googleCloudStorage", "bucket"],
    ["core.storage.azureStorage", "container"],
    ["core.storage.s3", "bucket"],
    ["core.storage.awsS3", "bucket"],
  ])("%s publishes the shared blob ports and its own", (kind, own) => {
    const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[kind];
    expect(ids(manifest.inputs)).toEqual(
      expect.arrayContaining(["operation", "key", "content", "value", own])
    );
    expect(ids(manifest.outputs)).toEqual([
      "result",
      "value",
      "contentLength",
      "contentType",
    ]);
  });

  it("gives every blob provider the same shared port surface", () => {
    const shared = (kind: string) =>
      ids(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[kind].inputs).filter((id) =>
        [
          "operation",
          "key",
          "targetKey",
          "content",
          "contentType",
          "encoding",
          "metadataValues",
          "prefix",
          "cursor",
          "limit",
          "urlOperation",
          "expiresInSeconds",
          "value",
        ].includes(id)
      );
    expect(shared("core.storage.googleCloudStorage")).toEqual(
      shared("core.storage.s3")
    );
    expect(shared("core.storage.azureStorage")).toEqual(
      shared("core.storage.s3")
    );
  });
});
