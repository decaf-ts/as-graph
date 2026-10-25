/**
 * @module as-graph/tests/unit/graph/nodes/Stage5aIoTransforms.test
 * @summary Unit coverage for the SAA-1448 Stage 5a IO transform kinds.
 * @description Drives the instance `execute` contract of
 * `core.io.convertToFile`, `core.io.html`, `core.io.htmlExtract`,
 * `core.io.markdown`, `core.io.xml`, `core.io.readBinaryFile`,
 * `core.io.readBinaryFiles`, and `core.io.writeBinaryFile`. File kinds run
 * against a real temporary directory through `GRAPH_FILE_IO_BASE`; the text
 * formats use the real converter libraries. Every documented
 * `GraphExecutionError` code is asserted.
 */
import { afterAll, beforeAll, describe, it, expect } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConvertToFileNode,
  HtmlExtractNode,
  HtmlNode,
  MarkdownNode,
  ReadBinaryFileNode,
  ReadBinaryFilesNode,
  WriteBinaryFileNode,
  XmlNode,
} from "../../../../src/node";
import type { GraphNodeClass } from "../../../../src/node/base";
import type { GraphExecutionValues } from "../../../../src/engine/types";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

interface BinaryPayload {
  fileName: string;
  path?: string;
  mimeType: string;
  byteLength: number;
  data: string;
}

async function run(
  nodeClass: GraphNodeClass,
  kind: string,
  parameters: Record<string, unknown>,
  inputs: Record<string, unknown>
): Promise<GraphExecutionValues> {
  const context = buildNodeContext(kind, { parameters });
  return await executeNode(nodeClass, nodeExecutionRequest(inputs), context);
}

function decode(payload: BinaryPayload): string {
  return Buffer.from(payload.data, "base64").toString("utf8");
}

describe("core.io.convertToFile", () => {
  const kind = "core.io.convertToFile";

  it("builds a delimited CSV payload with a header row and RFC quoting", async () => {
    const result = await run(
      ConvertToFileNode,
      kind,
      { operation: "csv", delimiter: ";", fileName: "people.csv" },
      { value: [{ name: 'a"b', note: "x;y" }] }
    );
    const payload = result.result as BinaryPayload;
    expect(result.content).toBe('name;note\n"a""b";"x;y"');
    expect(payload.fileName).toBe("people.csv");
    expect(payload.mimeType).toBe("text/csv");
    expect(payload.byteLength).toBe(Buffer.byteLength(result.content as string));
    expect(decode(payload)).toBe(result.content);
  });

  it("omits the CSV header row when headerRow is false", async () => {
    const result = await run(
      ConvertToFileNode,
      kind,
      { operation: "csv", headerRow: false },
      { value: [{ a: 1 }, { a: 2 }] }
    );
    expect(result.content).toBe("1\n2");
  });

  it("renders an HTML table document with an optional caption and capitalized headers", async () => {
    const result = await run(
      ConvertToFileNode,
      kind,
      { operation: "html", caption: "People", capitalize: true },
      { value: [{ full_name: "Ada" }] }
    );
    const content = result.content as string;
    expect(content).toContain("<!DOCTYPE html>");
    expect(content).toContain("<caption>People</caption>");
    expect(content).toContain("<th>Full Name</th>");
    expect(content).toContain(">Ada</td>");
    expect((result.result as BinaryPayload).mimeType).toBe("text/html");
  });

  it("serializes the whole input to JSON once or one payload per item", async () => {
    const once = await run(
      ConvertToFileNode,
      kind,
      { operation: "toJson", format: true, fileName: "rows.json" },
      { value: [{ n: 1 }, { n: 2 }] }
    );
    expect(JSON.parse(once.content as string)).toEqual([{ n: 1 }, { n: 2 }]);
    expect((once.result as BinaryPayload).fileName).toBe("rows.json");
    expect(decode(once.result as BinaryPayload)).toBe(once.content);

    const each = await run(
      ConvertToFileNode,
      kind,
      { operation: "toJson", mode: "each" },
      { value: [{ n: 1 }, { n: 2 }] }
    );
    const payloads = each.result as BinaryPayload[];
    expect(payloads).toHaveLength(2);
    expect(payloads.map(decode)).toEqual(['{"n":1}', '{"n":2}']);
    expect(each.bytes).toBe(14);
  });

  it("converts a source property to text and to binary payloads", async () => {
    const text = await run(
      ConvertToFileNode,
      kind,
      { operation: "toText", sourceProperty: "text" },
      { value: [{ text: "hello" }] }
    );
    const textPayload = text.result as BinaryPayload;
    expect(textPayload.mimeType).toBe("text/plain");
    expect(decode(textPayload)).toBe("hello");

    const binary = await run(
      ConvertToFileNode,
      kind,
      {
        operation: "toBinary",
        sourceProperty: "data",
        mimeType: "application/x-test",
      },
      { value: [{ data: Buffer.from("hi").toString("base64") }] }
    );
    const binaryPayload = binary.result as BinaryPayload;
    expect(binaryPayload.mimeType).toBe("application/x-test");
    expect(binaryPayload.byteLength).toBe(2);
    expect(Buffer.from(binaryPayload.data, "base64").toString("utf8")).toBe("hi");
  });

  it.each(["xlsx", "ods", "xls", "rtf", "iCal"])(
    "rejects the unsupported %s operation",
    async (operation) => {
      await expect(
        run(ConvertToFileNode, kind, { operation }, { value: [{ a: 1 }] })
      ).rejects.toMatchObject({
        graphCode: "GRAPH_CONVERT_TO_FILE_UNSUPPORTED_OPERATION",
      });
    }
  );
});

describe("core.io.html", () => {
  const kind = "core.io.html";

  it("interpolates dotted template paths for one item or an array of items", async () => {
    const parameters = {
      operation: "generateHtmlTemplate",
      html: "<p>{{name}} - {{address.city}}</p>",
    };
    expect(
      (
        await run(HtmlNode, kind, parameters, {
          value: { name: "Ada", address: { city: "London" } },
        })
      ).result
    ).toBe("<p>Ada - London</p>");

    expect(
      (
        await run(HtmlNode, kind, parameters, {
          value: [
            { name: "Ada", address: { city: "London" } },
            { name: "Grace", address: { city: "New York" } },
          ],
        })
      ).result
    ).toEqual([
      "<p>Ada - London</p>",
      "<p>Grace - New York</p>",
    ]);
  });

  it("requires a template when generating HTML", async () => {
    await expect(
      run(HtmlNode, kind, {}, { value: {} })
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTML_TEMPLATE_REQUIRED" });
  });

  it("extracts text, HTML, attributes, input values, and arrays by CSS selector", async () => {
    const html = [
      "<h1> Title </h1>",
      '<a href="/x"> link </a>',
      "<ul><li>one</li><li>two</li></ul>",
      '<input value="hi">',
      '<div id="c"><p>Keep</p><span>Skip</span></div>',
    ].join("");
    const result = await run(
      HtmlNode,
      kind,
      {
        operation: "extractHtmlContent",
        extractionValues: [
          { key: "title", cssSelector: "h1" },
          { key: "html", cssSelector: "h1", returnValue: "html" },
          {
            key: "href",
            cssSelector: "a",
            returnValue: "attribute",
            attribute: "href",
          },
          { key: "items", cssSelector: "li", returnArray: true },
          { key: "input", cssSelector: "input", returnValue: "value" },
          { key: "text", cssSelector: "#c", skipSelectors: "span" },
        ],
      },
      { value: html }
    );
    expect(result.result).toEqual([
      {
        title: "Title",
        html: "Title",
        href: "/x",
        items: ["one", "two"],
        input: "hi",
        text: "Keep",
      },
    ]);
  });

  it("returns a table document for convertToHtmlTable", async () => {
    const result = await run(
      HtmlNode,
      kind,
      { operation: "convertToHtmlTable", capitalize: true },
      { value: [{ full_name: "Ada" }] }
    );
    expect(result.table).toBe(result.result);
    expect(result.table).toContain("<table");
    expect(result.table).toContain("<th>Full Name</th>");
    expect(result.table).toContain(">Ada</td>");
  });

  it("requires at least one extraction value", async () => {
    await expect(
      run(
        HtmlNode,
        kind,
        { operation: "extractHtmlContent", extractionValues: [] },
        { value: "<h1>Hi</h1>" }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTML_EXTRACT_VALUES_REQUIRED" });
  });
});

describe("core.io.htmlExtract", () => {
  const kind = "core.io.htmlExtract";

  it("extracts from the configured JSON data property", async () => {
    const result = await run(
      HtmlExtractNode,
      kind,
      {
        sourceData: "json",
        dataPropertyName: "body",
        extractionValues: [{ key: "title", cssSelector: "h1" }],
      },
      { value: { body: "<h1>Hi</h1>" } }
    );
    expect(result.result).toEqual([{ title: "Hi" }]);
  });

  it("extracts from a binary payload", async () => {
    const result = await run(
      HtmlExtractNode,
      kind,
      {
        sourceData: "binary",
        extractionValues: [{ key: "title", cssSelector: "h1" }],
      },
      { value: Buffer.from("<h1>Binary</h1>") }
    );
    expect(result.result).toEqual([{ title: "Binary" }]);
  });

  it("trims values by default, preserves them when disabled, and collapses text on cleanUpText", async () => {
    const extractionValues = [{ key: "t", cssSelector: "p" }];
    expect(
      (
        await run(HtmlExtractNode, kind, { extractionValues }, {
          value: "<p> Hi </p>",
        })
      ).result
    ).toEqual([{ t: "Hi" }]);

    expect(
      (
        await run(HtmlExtractNode, kind, { extractionValues, trimValues: false }, {
          value: "<p> Hi </p>",
        })
      ).result
    ).toEqual([{ t: " Hi " }]);

    expect(
      (
        await run(HtmlExtractNode, kind, { extractionValues, cleanUpText: true }, {
          value: "<p> a \n b </p>",
        })
      ).result
    ).toEqual([{ t: "a b" }]);
  });

  it("fails on empty content and on missing extraction values", async () => {
    await expect(
      run(
        HtmlExtractNode,
        kind,
        { extractionValues: [{ key: "t", cssSelector: "p" }] },
        { value: {} }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTML_EXTRACT_INVALID_INPUT" });

    await expect(
      run(
        HtmlExtractNode,
        kind,
        { extractionValues: [] },
        { value: "<p>Hi</p>" }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTML_EXTRACT_VALUES_REQUIRED" });
  });
});

describe("core.io.markdown", () => {
  const kind = "core.io.markdown";

  it("converts markdown to HTML, optionally wrapping the result in a destination key", async () => {
    const plain = await run(
      MarkdownNode,
      kind,
      { mode: "markdownToHtml" },
      { value: "# Title" }
    );
    expect(plain.result).toContain("<h1");
    expect(plain.result).toContain("Title</h1>");

    const wrapped = await run(
      MarkdownNode,
      kind,
      { mode: "markdownToHtml", destinationKey: "html" },
      { value: "# Title" }
    );
    expect(wrapped.result).toEqual({ html: wrapped.content });
    expect(wrapped.content).toContain("Title</h1>");
  });

  it("converts HTML to markdown from the input or the configured html property", async () => {
    expect(
      (await run(MarkdownNode, kind, {}, { value: "<h1>Title</h1>" })).result
    ).toBe("# Title");

    expect(
      (await run(MarkdownNode, kind, { html: "<h1>Configured</h1>" }, {})).result
    ).toBe("# Configured");
  });

  it("requires content for the selected mode", async () => {
    await expect(
      run(MarkdownNode, kind, { mode: "markdownToHtml" }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_MARKDOWN_CONTENT_REQUIRED" });

    await expect(
      run(MarkdownNode, kind, { mode: "htmlToMarkdown" }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_MARKDOWN_CONTENT_REQUIRED" });
  });
});

describe("core.io.xml", () => {
  const kind = "core.io.xml";

  it("parses XML to JSON with the default attrkey/charkey and optional trimming", async () => {
    const xml = '<root><item id="1"> a </item></root>';
    expect((await run(XmlNode, kind, {}, { value: xml })).result).toEqual({
      root: { item: { _: " a ", id: "1" } },
    });

    expect(
      (await run(XmlNode, kind, { trim: true }, { value: xml })).result
    ).toEqual({ root: { item: { _: "a", id: "1" } } });
  });

  it("honours explicitArray, ignoreAttrs, normalizeTags, and custom attrkey/charkey", async () => {
    expect(
      (
        await run(XmlNode, kind, { explicitArray: true }, {
          value: "<root><item>a</item><item>b</item></root>",
        })
      ).result
    ).toEqual({ root: { item: ["a", "b"] } });

    expect(
      (
        await run(XmlNode, kind, { ignoreAttrs: true }, {
          value: '<root><item id="1">a</item></root>',
        })
      ).result
    ).toEqual({ root: { item: "a" } });

    expect(
      (
        await run(XmlNode, kind, { normalizeTags: true }, {
          value: "<ROOT><Item>a</Item></ROOT>",
        })
      ).result
    ).toEqual({ root: { item: "a" } });

    expect(
      (
        await run(
          XmlNode,
          kind,
          { attrkey: "@", charkey: "#", mergeAttrs: false },
          { value: '<root><item id="1">a</item></root>' }
        )
      ).result
    ).toEqual({ root: { item: { "#": "a", "@": { id: "1" } } } });
  });

  it("builds XML from JSON with headless, rootName, and custom attrkey/charkey", async () => {
    const defaultBuild = await run(
      XmlNode,
      kind,
      { mode: "jsonToXml" },
      { value: { item: "a" } }
    );
    expect(defaultBuild.result).toContain('<?xml version="1.0"');
    expect(defaultBuild.result).toContain("<item>a</item>");

    expect(
      (
        await run(
          XmlNode,
          kind,
          { mode: "jsonToXml", headless: true },
          { value: { item: "a" } }
        )
      ).result
    ).toBe("<item>a</item>");

    expect(
      (
        await run(
          XmlNode,
          kind,
          {
            mode: "jsonToXml",
            headless: true,
            attrkey: "@",
            charkey: "#",
          },
          { value: { item: { "@": { id: "1" }, "#": "a" } } }
        )
      ).result
    ).toBe('<item id="1">a</item>');

    expect(
      (
        await run(
          XmlNode,
          kind,
          { mode: "jsonToXml", headless: true, rootName: "root" },
          { value: { item: "a" } }
        )
      ).result
    ).toBe("<item>a</item>");
  });

  it("wraps the parsed or built result in destinationField", async () => {
    expect(
      (
        await run(
          XmlNode,
          kind,
          { destinationField: "payload" },
          { value: "<root><a>1</a></root>" }
        )
      ).result
    ).toEqual({ payload: { root: { a: "1" } } });

    expect(
      (
        await run(
          XmlNode,
          kind,
          { mode: "jsonToXml", headless: true, destinationField: "payload" },
          { value: { item: "a" } }
        )
      ).result
    ).toEqual({ payload: "<item>a</item>" });
  });

  it("fails on malformed XML and on missing input", async () => {
    await expect(
      run(XmlNode, kind, {}, { value: "<root><unclosed>" })
    ).rejects.toMatchObject({ graphCode: "GRAPH_XML_PARSE_FAILED" });

    await expect(run(XmlNode, kind, {}, {})).rejects.toMatchObject({
      graphCode: "GRAPH_XML_INVALID_INPUT",
    });

    await expect(
      run(XmlNode, kind, { mode: "jsonToXml" }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_XML_INVALID_INPUT" });
  });
});

describe("core.io binary file kinds — real filesystem", () => {
  const readKind = "core.io.readBinaryFile";
  const readManyKind = "core.io.readBinaryFiles";
  const writeKind = "core.io.writeBinaryFile";
  let directory: string;
  const previousBase = process.env["GRAPH_FILE_IO_BASE"];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "saa1451-io-"));
    process.env["GRAPH_FILE_IO_BASE"] = directory;
  });

  afterAll(async () => {
    if (previousBase === undefined) delete process.env["GRAPH_FILE_IO_BASE"];
    else process.env["GRAPH_FILE_IO_BASE"] = previousBase;
    await rm(directory, { recursive: true, force: true });
  });

  it("reads one file into a base64 payload with byte and mime metadata", async () => {
    await writeFile(join(directory, "single.bin"), Buffer.from([1, 2, 3]));
    const result = await run(ReadBinaryFileNode, readKind, { filePath: "single.bin" }, {});
    const payload = result.result as BinaryPayload;
    expect(payload.fileName).toBe("single.bin");
    expect(payload.path).toBe("single.bin");
    expect(payload.mimeType).toBe("application/octet-stream");
    expect(payload.byteLength).toBe(3);
    expect(Buffer.from(payload.data, "base64")).toEqual(Buffer.from([1, 2, 3]));
    expect(result).toMatchObject({
      fileName: "single.bin",
      mimeType: "application/octet-stream",
      bytes: 3,
    });
  });

  it("reads every file matching a glob selector", async () => {
    await writeFile(join(directory, "a.bin"), Buffer.from("aa"));
    await writeFile(join(directory, "b.bin"), Buffer.from("bbb"));
    await writeFile(join(directory, "skip.txt"), Buffer.from("ignored"));

    const result = await run(
      ReadBinaryFilesNode,
      readManyKind,
      { fileSelector: "*.bin" },
      {}
    );
    const payloads = result.result as BinaryPayload[];
    expect(payloads.map((payload) => payload.fileName)).toEqual([
      "a.bin",
      "b.bin",
      "single.bin",
    ]);
    expect(result.files).toBe(3);
    expect(result.bytes).toBe(8);
  });

  it("writes, appends, and round-trips binary content, creating nested directories", async () => {
    const path = join("nested", "deep", "out.bin");
    const written = await run(
      WriteBinaryFileNode,
      writeKind,
      { fileName: path },
      { value: Buffer.from("abc") }
    );
    expect(written.result).toEqual({ fileName: path, path, bytes: 3 });
    expect(written.bytes).toBe(3);

    const read = await run(ReadBinaryFileNode, readKind, { filePath: path }, {});
    expect(Buffer.from((read.result as BinaryPayload).data, "base64").toString("utf8")).toBe("abc");

    await run(
      WriteBinaryFileNode,
      writeKind,
      { fileName: path, append: true },
      { value: Buffer.from("de") }
    );
    const appended = await run(
      ReadBinaryFileNode,
      readKind,
      { filePath: path },
      {}
    ) as unknown as { result: BinaryPayload };
    expect(Buffer.from(appended.result.data, "base64").toString("utf8")).toBe("abcde");
  });

  it.each([
    ["a parent-relative escape", "../escape.bin"],
    ["an absolute system path", "/etc/passwd"],
    ["the workdocs directory", "workdocs/leak.bin"],
  ])("rejects %s with GRAPH_FILE_PATH_FORBIDDEN", async (_label, filePath) => {
    await expect(
      run(ReadBinaryFileNode, readKind, { filePath }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_FILE_PATH_FORBIDDEN" });
  });

  it("fails on a missing path, a missing selector, and missing write content", async () => {
    await expect(
      run(ReadBinaryFileNode, readKind, { filePath: "not-there.bin" }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_FILE_INVALID_PATH" });

    await expect(
      run(ReadBinaryFileNode, readKind, {}, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_READ_BINARY_FILE_PATH_REQUIRED" });

    await expect(
      run(ReadBinaryFilesNode, readManyKind, {}, {})
    ).rejects.toMatchObject({
      graphCode: "GRAPH_READ_BINARY_FILES_SELECTOR_REQUIRED",
    });

    await expect(
      run(WriteBinaryFileNode, writeKind, {}, { value: Buffer.from("x") })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_WRITE_BINARY_FILE_PATH_REQUIRED",
    });

    await expect(
      run(WriteBinaryFileNode, writeKind, { fileName: "empty.bin" }, {})
    ).rejects.toMatchObject({
      graphCode: "GRAPH_WRITE_BINARY_FILE_CONTENT_REQUIRED",
    });
  });
});
