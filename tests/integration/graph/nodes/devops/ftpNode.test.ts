/**
 * @module as-graph/tests/integration/graph/nodes/devops/ftpNode
 * @summary SAA-1032: real-service integration coverage for `core.devops.ftp`
 * (SFTP transport).
 * @description Lists, downloads and deletes real files on the Docker SFTP
 * server. Fixtures are written through a real `ssh2` SFTP session in setup and
 * removed in teardown, so the suite proves the network path rather than a
 * mocked filesystem.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Client } from "ssh2";
import { FtpNode } from "../../../../../src/node/devops/ftp/node";
import {
  ENDPOINTS,
  clearCredentials,
  credential,
  errorCodeOf,
  runNode,
  setCredential,
  uniqueName,
} from "../real-service-support";

jest.setTimeout(60000);

const kind = "core.devops.ftp";
const envName = "GRAPH_CREDENTIAL_SAA1032_SFTP";
const credentials = credential(envName, "sftp");
const base = {
  host: ENDPOINTS.ftp.host,
  port: ENDPOINTS.ftp.port,
  username: ENDPOINTS.ftp.username,
};
const fixtureBase = uniqueName("saa1032-sftp");
const created: string[] = [];

function withSftp<T>(action: (sftp: {
  writeFile(
    path: string,
    content: string,
    callback: (error?: Error | null) => void
  ): void;
  unlink(path: string, callback: (error?: Error | null) => void): void;
}) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on("error", reject);
    client.on("ready", () => {
      client.sftp((error, sftp) => {
        if (error) {
          client.end();
          reject(error);
          return;
        }
        action(sftp)
          .then((value) => {
            client.end();
            resolve(value);
          })
          .catch((actionError) => {
            client.end();
            reject(actionError);
          });
      });
    });
    client.connect({
      host: ENDPOINTS.ftp.host,
      port: ENDPOINTS.ftp.port,
      username: ENDPOINTS.ftp.username,
      password: ENDPOINTS.ftp.password,
    });
  });
}

function writeFixture(path: string, content: string): Promise<void> {
  return withSftp(
    (sftp) =>
      new Promise<void>((resolve, reject) => {
        sftp.writeFile(path, content, (error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  );
}

function removeFixture(path: string): Promise<void> {
  return withSftp(
    (sftp) =>
      new Promise<void>((resolve) => {
        sftp.unlink(path, () => resolve());
      })
  );
}

beforeAll(() => {
  setCredential(envName, ENDPOINTS.ftp.password);
});

afterAll(async () => {
  clearCredentials(envName);
  for (const path of created) await removeFixture(path);
});

describe("core.devops.ftp (real SFTP)", () => {
  it("lists a real remote directory", async () => {
    const name = `${fixtureBase}-list.txt`;
    const path = `${ENDPOINTS.ftp.root}/${name}`;
    created.push(path);
    await writeFixture(path, "hello-sftp");

    const listed = await runNode(
      FtpNode,
      kind,
      { ...base, operation: "list", path: ENDPOINTS.ftp.root },
      {},
      credentials
    );
    const entries = listed.result as Array<{
      path: string;
      name: string;
      size: number;
      isDirectory: boolean;
    }>;
    const entry = entries.find((candidate) => candidate.name === name);
    expect(entry).toBeDefined();
    expect(entry?.size).toBe(10);
    expect(entry?.isDirectory).toBe(false);
  });

  it("downloads a file as utf8", async () => {
    const name = `${fixtureBase}-download.txt`;
    const path = `${ENDPOINTS.ftp.root}/${name}`;
    created.push(path);
    await writeFixture(path, "hello-sftp-download");

    const downloaded = await runNode(
      FtpNode,
      kind,
      { ...base, operation: "download", path },
      {},
      credentials
    );
    expect(downloaded.content).toBe("hello-sftp-download");
    expect(downloaded.size).toBe(19);
    expect(downloaded.result).toMatchObject({ path, name, size: 19 });
  });

  it("downloads a file as base64", async () => {
    const name = `${fixtureBase}-base64.txt`;
    const path = `${ENDPOINTS.ftp.root}/${name}`;
    created.push(path);
    await writeFixture(path, "hello-sftp");

    const downloaded = await runNode(
      FtpNode,
      kind,
      { ...base, operation: "download", path, encoding: "base64" },
      {},
      credentials
    );
    expect(
      Buffer.from(String(downloaded.content), "base64").toString("utf8")
    ).toBe("hello-sftp");
  });

  it("deletes a real remote file", async () => {
    const name = `${fixtureBase}-delete.txt`;
    const path = `${ENDPOINTS.ftp.root}/${name}`;
    await writeFixture(path, "delete-me");

    const deleted = await runNode(
      FtpNode,
      kind,
      { ...base, operation: "delete", path },
      {},
      credentials
    );
    expect(deleted.result).toEqual({ path, deleted: true });

    const listed = await runNode(
      FtpNode,
      kind,
      { ...base, operation: "list", path: ENDPOINTS.ftp.root },
      {},
      credentials
    );
    const names = (listed.result as Array<{ name: string }>).map(
      (entry) => entry.name
    );
    expect(names).not.toContain(name);
  });

  it("fails fast when a non-list operation has no path", async () => {
    await expect(
      runNode(
        FtpNode,
        kind,
        { ...base, operation: "download" },
        {},
        credentials
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_FTP_PATH_REQUIRED" });
  });

  it("fails fast when host or username is missing", async () => {
    try {
      await runNode(
        FtpNode,
        kind,
        { host: "", username: "", operation: "list" },
        {},
        credentials
      );
      throw new Error("expected the node to fail");
    } catch (error) {
      expect(errorCodeOf(error)).toBe("GRAPH_FTP_CONNECTION_REQUIRED");
    }
  });
});
