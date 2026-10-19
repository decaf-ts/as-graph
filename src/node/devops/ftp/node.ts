/**
 * @module as-graph/nodes/devops/ftp
 * @summary FTP/SFTP DevOps node declaration (Stage 3a; `core.devops.ftp`).
 * @description FTP — list, download, or delete remote files over SFTP. The
 * `host` and `username` are required; the port defaults to 22. The `sftp`
 * credential (resolved through a `GRAPH_CREDENTIAL_*` environment variable) is
 * either a bare password token or a JSON object carrying `password`,
 * `privateKey`, and `passphrase` — never inline in node config. `list` returns
 * the directory entries for `path` (falling back to `remotePath`), `download`
 * emits the file content as `utf8` or `base64` plus its size, and `delete`
 * removes the file. An unknown `operation` silently falls back to `list`. The
 * SFTP connection is torn down in a `finally` block after every execution.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  Ssh2SftpService,
  type Ssh2SftpConfig,
} from "@decaf-ts/integrations/sftp";
import {
  asNonEmptyString,
  asNumber,
  parseCredentialJson,
  resolveCredentialSecret,
} from "../../storage/support";

/** Operation the node performs against the remote SFTP server. */
export type FtpOperation = "list" | "download" | "delete";

/** Encoding used to emit downloaded file content. */
export type FtpEncoding = "utf8" | "base64";

/** Inputs accepted by the FTP node. */
export type FtpNodeInput = Record<string, unknown>;

/** Outputs produced by the FTP node. */
export interface FtpNodeOutput {
  result: unknown;
  content?: string;
  size?: number;
}

/** Operations the node supports; unknown configured values fall back to `list`. */
const OPERATIONS: FtpOperation[] = ["list", "download", "delete"];

/**
 * Normalizes the resolved `sftp` credential into SFTP auth material: a bare
 * token is treated as the password, a JSON object may carry `password`,
 * `privateKey`, and `passphrase`.
 */
function sftpCredentials(secret: string | undefined): {
  password?: string;
  privateKey?: string;
  passphrase?: string;
} {
  if (!secret) return {};
  if (!secret.trim().startsWith("{")) return { password: secret };
  const parsed: Record<string, unknown> = parseCredentialJson(secret, "FTP");
  return {
    password: asNonEmptyString(parsed["password"]),
    privateKey: asNonEmptyString(parsed["privateKey"]),
    passphrase: asNonEmptyString(parsed["passphrase"]),
  };
}

/**
 * FTP/SFTP node (`core.devops.ftp`): lists, downloads, or deletes remote files.
 *
 * Builds a throwaway `Ssh2SftpService` per execution from the node's
 * connection config and the resolved `sftp` credential, and closes it in a
 * `finally` block.
 */
@node("core.devops.ftp", {
  kind: "core.devops.ftp",
  category: "DevOps",
  color: "#0ea5e9",
  icon: "ti-folder-symlink",
  width: 96,
  height: 96,
  labels: ["devops", "ftp", "sftp", "files"],
  metadata: {
    title: "graph.node.devops.ftp.name",
    description: "graph.node.devops.ftp.description",
  },
})
@model()
export class FtpNode extends GraphNode<FtpNodeInput, FtpNodeOutput> {
  /**
   * Executes the configured SFTP operation.
   *
   * @param request - Execution request carrying the credential secrets; the `sftp` credential is resolved via `resolveCredentialSecret`.
   * @returns Execution values: `list` resolves to the directory entries; `download` to the file path/name/size with `content` (utf8 or base64) and `size` outputs; `delete` to `{ path, deleted: true }`.
   * @throws {GraphExecutionError} with code `GRAPH_FTP_CONNECTION_REQUIRED` when `host` or `username` is missing, `GRAPH_FTP_PATH_REQUIRED` when a non-list operation lacks a `path`, or `GRAPH_FTP_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<FtpNodeInput>
  ): Promise<GraphExecutionValues> {
    const host = asNonEmptyString(this.host);
    const username = asNonEmptyString(this.username);
    if (!host || !username) {
      throw new GraphExecutionError(
        "FTP node requires host and username",
        "GRAPH_FTP_CONNECTION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "list";
    const path = asNonEmptyString(this.path);
    if (operation !== "list" && !path) {
      throw new GraphExecutionError(
        `FTP node operation '${operation}' requires a path`,
        "GRAPH_FTP_PATH_REQUIRED",
        { operation }
      );
    }
    const secret = resolveCredentialSecret(
      request.credentials,
      "sftp",
      false,
      "FTP"
    );
    const config: Ssh2SftpConfig = {
      provider: "ssh2",
      sourceId: asNonEmptyString(this.sourceId) ?? "graph",
      host,
      port: asNumber(this.port) ?? 22,
      username,
      remotePath: asNonEmptyString(this.remotePath),
      ...sftpCredentials(secret),
    };
    const service = new Ssh2SftpService();
    try {
      await service.initialize(config);
      if (operation === "list") {
        const entries = await service.list(path);
        return { result: entries };
      }
      if (operation === "delete") {
        await service.delete(path as string);
        return { result: { path, deleted: true } };
      }
      const file = await service.fetch(path as string);
      return {
        result: {
          path: file.path,
          name: file.name,
          size: file.size,
        },
        content:
          this.encoding === "base64"
            ? file.content.toString("base64")
            : file.content.toString("utf8"),
        size: file.size,
      };
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `FTP node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_FTP_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.close().catch(() => undefined);
    }
  }

  /** SFTP operation to perform (defaults to `list`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.ftp.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: FtpOperation = "list";

  /** Remote SFTP host (required). */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.ftp.fields.host.label",
    type: "string",
  })
  @input({ handle: "host", userControlled: true })
  host!: string;

  /** Remote port (default 22). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.ftp.fields.port.label",
    type: "number",
  })
  @input({ handle: "port", userControlled: true })
  port?: number;

  /** SFTP account name (required). */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.ftp.fields.username.label",
    type: "string",
  })
  @input({ handle: "username", userControlled: true })
  username!: string;

  /** Optional logical source identifier used in result descriptors (default `graph`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.ftp.fields.sourceId.label",
    type: "string",
  })
  @input({ handle: "sourceId", userControlled: true })
  sourceId?: string;

  /** Optional default remote directory; `list` falls back to it when `path` is unset. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.ftp.fields.remotePath.label",
    type: "string",
  })
  @input({ handle: "remotePath", userControlled: true })
  remotePath?: string;

  /** Absolute remote path of the file to download or delete; required for non-list operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.ftp.fields.path.label",
    type: "string",
  })
  @input({ handle: "path", userControlled: true })
  path?: string;

  /** Encoding for downloaded content (default `utf8`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.ftp.fields.encoding.label",
    type: "select",
  })
  @input({ handle: "encoding", userControlled: true })
  encoding: FtpEncoding = "utf8";

  /** Operation result: directory entries, file descriptor `{ path, deleted }`, or the downloaded file summary. */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Downloaded file content (`download` only). */
  @output({ handle: "content" })
  content?: string;

  /** Downloaded file size in bytes (`download` only). */
  @output({ handle: "size", type: "number" })
  size?: number;
}
