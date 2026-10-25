/**
 * @module as-graph/tests/integration/graph/nodes/io/Stage5aIoLive
 * @summary Live integration coverage for the SAA-1448 Stage 5a IO kinds.
 * @description Executes the production node classes through the shared
 * `runNode` harness. The text-format kinds run their real converter
 * libraries in-process; the binary file kinds round-trip bytes on the real
 * filesystem under a temporary `GRAPH_FILE_IO_BASE`. One success path and one
 * documented failure code per kind.
 */
import { afterAll, beforeAll, describe, it, expect } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvertToFileNode } from "../../../../../src/node/io/convert-to-file/node";
import { HtmlExtractNode } from "../../../../../src/node/io/html-extract/node";
import { HtmlNode } from "../../../../../src/node/io/html/node";
import { MarkdownNode } from "../../../../../src/node/io/markdown/node";
import { ReadBinaryFileNode } from "../../../../../src/node/io/read-binary-file/node";
import { ReadBinaryFilesNode } from "../../../../../src/node/io/read-binary-files/node";
import { WriteBinaryFileNode } from "../../../../../src/node/io/write-binary-file/node";
import { XmlNode } from "../../../../../src/node/io/xml/node";
import { errorCodeOf, runNode } from "../real-service-support";

interface BinaryPayload {
  fileName: string;
  mimeType: string;
  byteLength: number;
  data: string;
}

describe("core.io.convertToFile — live node", () => {
  it("serializes real records to a CSV payload", async () => {
    const result = await runNode(
      ConvertToFileNode,
      "core.io.convertToFile",
      { operation: "csv", fileName: "people.csv" },
      { value: [{ name: "Ada", score: 7 }] }
    );
    expect(result.content).toBe("name,score\nAda,7");
    expect((result.result as BinaryPayload).mimeType).toBe("text/csv");
    expect((result.result as BinaryPayload).byteLength).toBe(
      Buffer.byteLength(result.content as string)
    );
  });

  it("fails on an unsupported spreadsheet operation", async () => {
    const error = await runNode(
      ConvertToFileNode,
      "core.io.convertToFile",
      { operation: "xlsx" },
      { value: [{ name: "Ada" }] }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_CONVERT_TO_FILE_UNSUPPORTED_OPERATION");
  });
});

describe("core.io.html — live node", () => {
  it("renders a real template from real data", async () => {
    const result = await runNode(
      HtmlNode,
      "core.io.html",
      { operation: "generateHtmlTemplate", html: "<p>{{name}}</p>" },
      { value: { name: "Ada" } }
    );
    expect(result.result).toBe("<p>Ada</p>");
  });

  it("fails without a template", async () => {
    const error = await runNode(
      HtmlNode,
      "core.io.html",
      { operation: "generateHtmlTemplate" },
      { value: { name: "Ada" } }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_HTML_TEMPLATE_REQUIRED");
  });
});

describe("core.io.htmlExtract — live node", () => {
  it("extracts values from real HTML with CSS selectors", async () => {
    const result = await runNode(
      HtmlExtractNode,
      "core.io.htmlExtract",
      { extractionValues: [{ key: "title", cssSelector: "h1" }] },
      { value: { data: "<h1>Live title</h1>" } }
    );
    expect(result.result).toEqual([{ title: "Live title" }]);
  });

  it("fails without extraction values", async () => {
    const error = await runNode(
      HtmlExtractNode,
      "core.io.htmlExtract",
      { extractionValues: [] },
      { value: "<h1>Hi</h1>" }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_HTML_EXTRACT_VALUES_REQUIRED");
  });
});

describe("core.io.markdown — live node", () => {
  it("converts markdown to HTML", async () => {
    const result = await runNode(
      MarkdownNode,
      "core.io.markdown",
      { mode: "markdownToHtml" },
      { value: "## Live" }
    );
    expect(result.result).toContain("<h2");
    expect(result.result).toContain("Live</h2>");
  });

  it("fails without content", async () => {
    const error = await runNode(
      MarkdownNode,
      "core.io.markdown",
      { mode: "markdownToHtml" },
      {}
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_MARKDOWN_CONTENT_REQUIRED");
  });
});

describe("core.io.xml — live node", () => {
  it("parses real XML to JSON and builds it back to XML", async () => {
    const parsed = await runNode(
      XmlNode,
      "core.io.xml",
      { trim: true },
      { value: "<root><item>a</item></root>" }
    );
    expect(parsed.result).toEqual({ root: { item: "a" } });

    const built = await runNode(
      XmlNode,
      "core.io.xml",
      { mode: "jsonToXml", headless: true },
      { value: { item: "a" } }
    );
    expect(built.result).toBe("<item>a</item>");
  });

  it("fails on malformed XML", async () => {
    const error = await runNode(
      XmlNode,
      "core.io.xml",
      {},
      { value: "<root><unclosed>" }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_XML_PARSE_FAILED");
  });
});

describe("core.io binary file kinds — live filesystem", () => {
  let directory: string;
  const previousBase = process.env["GRAPH_FILE_IO_BASE"];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "saa1451-live-"));
    process.env["GRAPH_FILE_IO_BASE"] = directory;
  });

  afterAll(async () => {
    if (previousBase === undefined) delete process.env["GRAPH_FILE_IO_BASE"];
    else process.env["GRAPH_FILE_IO_BASE"] = previousBase;
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips bytes, including append and nested directories", async () => {
    const path = join("nested", "out.bin");
    const written = await runNode(
      WriteBinaryFileNode,
      "core.io.writeBinaryFile",
      { fileName: path },
      { value: Buffer.from("abc") }
    );
    expect(written.result).toEqual({ fileName: path, path, bytes: 3 });

    await runNode(
      WriteBinaryFileNode,
      "core.io.writeBinaryFile",
      { fileName: path, append: true },
      { value: Buffer.from("de") }
    );

    const read = await runNode(
      ReadBinaryFileNode,
      "core.io.readBinaryFile",
      { filePath: path },
      {}
    );
    const payload = read.result as BinaryPayload;
    expect(payload.byteLength).toBe(5);
    expect(Buffer.from(payload.data, "base64").toString("utf8")).toBe("abcde");
  });

  it("reads multiple real files through a glob selector", async () => {
    await runNode(
      WriteBinaryFileNode,
      "core.io.writeBinaryFile",
      { fileName: "glob/one.bin" },
      { value: Buffer.from("1") }
    );
    await runNode(
      WriteBinaryFileNode,
      "core.io.writeBinaryFile",
      { fileName: "glob/two.bin" },
      { value: Buffer.from("22") }
    );

    const result = await runNode(
      ReadBinaryFilesNode,
      "core.io.readBinaryFiles",
      { fileSelector: "glob/*.bin" },
      {}
    );
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(3);
  });

  it("fails on a path escape and on a missing glob selector", async () => {
    const forbidden = await runNode(
      ReadBinaryFileNode,
      "core.io.readBinaryFile",
      { filePath: "../escape.bin" },
      {}
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(forbidden)).toBe("GRAPH_FILE_PATH_FORBIDDEN");

    const missingSelector = await runNode(
      ReadBinaryFilesNode,
      "core.io.readBinaryFiles",
      {},
      {}
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(missingSelector)).toBe(
      "GRAPH_READ_BINARY_FILES_SELECTOR_REQUIRED"
    );
  });
});
