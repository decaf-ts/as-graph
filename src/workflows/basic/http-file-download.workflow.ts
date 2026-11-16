/**
 * @module as-graph/workflows/basic/http-file-download.workflow
 * @summary HTTP file download demo workflow: download a CSV as a file, parse
 * it into rows, and upload the file back.
 * @description
 *
 * 1. `download` — HTTP Request with `responseFormat: file`: the response body
 *    becomes a file (named from `Content-Disposition`, else `fileName`, else
 *    the URL), shown on the binary tab; the URL is the workflow's `url` input,
 *    wired into the exposed `url` port.
 * 2. `rows` — Spreadsheet File `parse`: the CSV file → `header` + `rows`.
 * 3. `upload` — HTTP Request `POST` to the `uploadUrl` input with the file as
 *    the body: its bytes are sent with its media type as `content-type`.
 *
 * The workflow needs reachable URLs, so it is not part of the generic
 * fixture run; `tests/integration/graph/fileDemos.test.ts` runs it against a
 * loopback server.
 */
import { document, edge, node, port } from "../builders";
import type { GraphWorkflowFixture } from "../types";

/** The HTTP file download demo document. */
export const httpFileDownloadDocument = document({
  id: "fixture-http-file-download",
  name: "fixture-http-file-download",
  inputs: [port("url"), port("uploadUrl")],
  outputs: [port("file"), port("header"), port("rows"), port("uploaded")],
  nodes: [
    node("download", "core.io.httpRequest", {
      method: "GET",
      responseFormat: "file",
      fileName: "download.csv",
      failOnError: true,
    }),
    node("rows", "core.io.spreadsheetFile", {
      operation: "parse",
      format: "csv",
      hasHeader: true,
    }),
    node("upload", "core.io.httpRequest", {
      method: "POST",
      responseFormat: "json",
      failOnError: true,
    }),
  ],
  edges: [
    edge("e1", ["workflow", "url"], ["node", "download", "url"]),
    edge("e2", ["node", "download", "result"], ["node", "rows", "value"]),
    edge("e3", ["node", "download", "result"], ["node", "upload", "value"]),
    edge("e4", ["workflow", "uploadUrl"], ["node", "upload", "url"]),
    edge("e5", ["node", "download", "result"], ["workflow", "file"]),
    edge("e6", ["node", "rows", "header"], ["workflow", "header"]),
    edge("e7", ["node", "rows", "rows"], ["workflow", "rows"]),
    edge("e8", ["node", "upload", "result"], ["workflow", "uploaded"]),
  ],
});

/** Fixture descriptor for the HTTP file download demo. */
export const httpFileDownloadFixture: GraphWorkflowFixture = {
  id: httpFileDownloadDocument.id,
  document: httpFileDownloadDocument,
  kinds: ["core.io.httpRequest", "core.io.spreadsheetFile"],
  combos: ["straight-value", "exposed-ports", "user-controlled-properties"],
  executable: false,
  skipReason:
    "Needs reachable `url`/`uploadUrl` inputs; tests/integration/graph/fileDemos.test.ts runs it against a loopback server.",
};
