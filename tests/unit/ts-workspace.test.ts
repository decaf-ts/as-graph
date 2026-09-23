import type { WorkspaceModule } from "../workspace-target";
import { loadWorkspaceModule } from "../workspace-target";
import { mkdirSync } from "fs";

interface AddAttachParams {
  attach: string | Buffer;
  description: string | object;
  context?: any;
  bufferFormat?: string;
}
interface AddMsgParams {
  message: string | object;
  context?: any;
}

export const JestReportersTempPathEnvKey = "JEST_HTML_REPORTERS_TEMP_DIR_PATH";
export const JestCoverageEnvKey = "__coverage__";

async function normalizeImport<T>(importPromise: Promise<T>): Promise<T> {
  // CommonJS's `module.exports` is wrapped as `default` in ESModule.
  return importPromise.then((m: any) => (m.default || m) as T);
}

export async function awaitTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let addMsgFunction: (arg: AddMsgParams) => Promise<void>;
let addAttachFunction: (arg: AddAttachParams) => Promise<void>;

let workspaceModule: WorkspaceModule;

async function importHelpers(): Promise<void> {
  // if (!process.env[JestReportersTempPathEnvKey])
  //   process.env[JestReportersTempPathEnvKey] = './workdocs/reports';
  const { addMsg, addAttach, dataDirPath, attachDirPath } = await normalizeImport(
    import("jest-html-reporters/helper")
  );
  // The temp dirs are created by the jest-html-reporters REPORTER at the start
  // of a run and cleaned after its data is merged into the html report. Jest
  // re-runs WITHOUT the reporter configured (e.g. the coverage-report action's
  // annotation pass) therefore have no dirs, and the helper's writeJSON fails
  // with ENOENT since it does not create parent directories. Create them first
  // so messages/attachments are always accepted; a reporter active in the same
  // run will pick them up and merge them into the report.
  mkdirSync(dataDirPath, { recursive: true });
  mkdirSync(attachDirPath, { recursive: true });
  addMsgFunction = addMsg;
  addAttachFunction = addAttach;
}

async function addReportMessage(
  title: string,
  message: string | object
): Promise<void> {
  if (
    !(globalThis as { global: Record<string, unknown> }).global[
      JestCoverageEnvKey
    ]
  )
    // we ony create reports when running coverage
    return;
  try {
    if (!addMsgFunction) await importHelpers();
    const msg = `${title}\n${message}`;
    await addMsgFunction({ message: msg });
  } catch (e) {
    // reporting is best-effort: the jest-html-reporters helper expects the
    // reporters' temp dir, which only exists under the configured coverage
    // reporters (re-runs such as the coverage-report action may not have it)
    console.warn("addReportMessage failed (non-fatal):", e);
  }
}

async function addReportAttachment(
  title: string,
  attachment: string | Buffer
): Promise<void> {
  if (
    !(globalThis as { global: Record<string, unknown> }).global[
      JestCoverageEnvKey
    ]
  )
    // we ony create reports when running coverage
    return;
  try {
    if (!addAttachFunction) await importHelpers();
    await addAttachFunction({
      attach: attachment,
      description: title,
    });
  } catch (e) {
    // see addReportMessage: best-effort reporting only
    console.warn("addReportAttachment failed (non-fatal):", e);
  }
}

describe("Type Script Workspace test", function () {
  beforeAll(async () => {
    workspaceModule = await loadWorkspaceModule();
  });

  it("runs functions", function () {
    const { complexFunction } = workspaceModule;
    expect(complexFunction()).toBe("Hello Worlddefault");
  });

  it("Instantiates Classes", async function () {
    const { Class, ChildClass, something } = workspaceModule;
    const a = new Class(1, "string");
    expect(a).toBeDefined();
    expect(a.method).rejects.toBeInstanceOf(Error);
    expect(Class.method).toThrow();
    const b = new ChildClass("string", "string");
    expect(b).toBeDefined();
    expect(() => b.method2("string")).toThrow();
    expect(something.call(a)).toEqual(a);
    const res = await b.method();
    expect(res).toEqual("ok");
    await addReportMessage(
      "Class Instantiation",
      `Class used:\n${a.constructor.name}\nChildClass used:\n${b.constructor.name}`
    );
    await addReportAttachment(
      "Class Instantiation 2",
      Buffer.from(
        `Class used:\n${a.constructor.name}\nChildClass used:\n${b.constructor.name}`
      )
    );
  });
});
