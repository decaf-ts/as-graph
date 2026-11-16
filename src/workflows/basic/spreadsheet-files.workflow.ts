/**
 * @module as-graph/workflows/basic/spreadsheet-files.workflow
 * @summary Spreadsheet-files demo workflow: files on the binary tab, rows in
 * the data (the n8n split).
 * @description Turns a list of records into spreadsheet files and back,
 * through every file-producing and file-parsing node, so each step shows
 * either a file (binary tab) or rows (JSON/table views) — never a file's
 * content copied into the data:
 *
 * 1. `toXlsx` — Spreadsheet File `write`: records → `team.xlsx` file.
 * 2. `save` — Read/Write Files from Disk `write`: the file's bytes → disk.
 * 3. `load` — Read/Write Files from Disk `read`: disk → file (not text).
 * 4. `sheet` — Spreadsheet File `parse`: file → `header` + `rows` (format
 *    picked from the file's media type).
 * 5. `toCsv` — Spreadsheet File `write`: the parsed rows and header (wired
 *    into the exposed `header` port) → `team.csv` file.
 * 6. `toOds` → `odsRows` — Convert to File (`ods`) → Extract from File
 *    (`ods`): records → file → records.
 */
import { document, edge, node, port } from "../builders";
import type { GraphWorkflowFixture } from "../types";

/** Where the demo writes the workbook, under the file-IO base. */
export const SPREADSHEET_FILES_PATH = "var/as-graph-demo/team.xlsx";

/** The spreadsheet-files demo document. */
export const spreadsheetFilesDocument = document({
  id: "fixture-spreadsheet-files",
  name: "fixture-spreadsheet-files",
  inputs: [port("team")],
  outputs: [
    port("workbook"),
    port("header"),
    port("rows"),
    port("csv"),
    port("odsFile"),
    port("odsRecords"),
  ],
  nodes: [
    node("toXlsx", "core.io.spreadsheetFile", {
      operation: "write",
      format: "xlsx",
      fileName: "team.xlsx",
      sheetName: "Team",
    }),
    node("save", "core.io.readWriteFile", {
      operation: "write",
      path: SPREADSHEET_FILES_PATH,
      createDirectories: true,
    }),
    // Wired after `save` so it reads the file the run just wrote.
    node("load", "core.io.readWriteFile", {
      operation: "read",
      path: SPREADSHEET_FILES_PATH,
    }),
    node("sheet", "core.io.spreadsheetFile", {
      operation: "parse",
      hasHeader: true,
      sheetName: "Team",
    }),
    node("toCsv", "core.io.spreadsheetFile", {
      operation: "write",
      format: "csv",
      fileName: "team.csv",
    }),
    node("toOds", "core.io.convertToFile", {
      operation: "ods",
      fileName: "team.ods",
      sheetName: "Team",
    }),
    node("odsRows", "core.io.extractFromFile", { format: "ods" }),
  ],
  edges: [
    edge("e1", ["workflow", "team"], ["node", "toXlsx", "value"]),
    edge("e2", ["node", "toXlsx", "result"], ["node", "save", "value"]),
    edge("e3", ["node", "save", "result"], ["node", "load", "value"]),
    edge("e4", ["node", "load", "result"], ["node", "sheet", "value"]),
    edge("e5", ["node", "sheet", "rows"], ["node", "toCsv", "value"]),
    edge("e6", ["node", "sheet", "header"], ["node", "toCsv", "header"]),
    edge("e7", ["workflow", "team"], ["node", "toOds", "value"]),
    edge("e8", ["node", "toOds", "result"], ["node", "odsRows", "value"]),
    edge("e9", ["node", "load", "result"], ["workflow", "workbook"]),
    edge("e10", ["node", "sheet", "header"], ["workflow", "header"]),
    edge("e11", ["node", "sheet", "rows"], ["workflow", "rows"]),
    edge("e12", ["node", "toCsv", "result"], ["workflow", "csv"]),
    edge("e13", ["node", "toOds", "result"], ["workflow", "odsFile"]),
    edge("e14", ["node", "odsRows", "result"], ["workflow", "odsRecords"]),
  ],
});

/** Demo input: three team members. */
export const SPREADSHEET_FILES_INPUTS = {
  team: [
    { name: "ada", role: "engineer", years: 36 },
    { name: "grace", role: "admiral", years: 85 },
    { name: "linus", role: "maintainer", years: 33 },
  ],
};

/** Fixture descriptor for the spreadsheet-files demo. */
export const spreadsheetFilesFixture: GraphWorkflowFixture = {
  id: spreadsheetFilesDocument.id,
  document: spreadsheetFilesDocument,
  kinds: [
    "core.io.spreadsheetFile",
    "core.io.readWriteFile",
    "core.io.convertToFile",
    "core.io.extractFromFile",
  ],
  combos: ["straight-value", "exposed-ports", "user-controlled-properties"],
  executable: true,
  inputs: SPREADSHEET_FILES_INPUTS,
  expectedOutputs: {
    header: ["name", "role", "years"],
    rows: [
      ["ada", "engineer", 36],
      ["grace", "admiral", 85],
      ["linus", "maintainer", 33],
    ],
    odsRecords: SPREADSHEET_FILES_INPUTS.team,
  },
};
