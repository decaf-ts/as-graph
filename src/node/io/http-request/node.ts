/**
 * @module as-graph/nodes/io/http-request
 * @summary HTTP Request IO node declaration (DECAF-746 IO family).
 * @description HTTP Request — call an HTTP endpoint and emit the response. The
 * configured `url` must parse as a URL and use only `http:`/`https:` (SSRF
 * hardening); the `query` map is appended to the URL's search params (array
 * values repeat the key, nil entries are skipped). Header entries keep only
 * string values with non-blank keys, and a JSON body auto-supplies
 * `content-type: application/json` when the caller did not set one. `GET` and
 * `HEAD` requests never carry a body; other methods send the configured `body`
 * or fall back to the `value` input (strings and binary payloads pass through,
 * anything else is JSON-encoded). The request races an `AbortController`
 * against `timeoutMs` (default 30s, floored to the default when invalid) and
 * the execution context's `abortSignal`. The response body is read as text and
 * parsed as JSON unless `responseFormat` is `text`. With `failOnError` a
 * non-2xx status throws; otherwise the status is reported on the `status`
 * output.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  GRAPH_HTTP_MAX_REDIRECTS,
  GRAPH_HTTP_MAX_RESPONSE_BYTES,
  GRAPH_HTTP_MAX_TIMEOUT_MS,
} from "../../../engine/constants";

/** HTTP methods the node can send. */
export type HttpRequestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD";

/** How the response body is decoded. */
export type HttpResponseFormat = "json" | "text";

/** Inputs accepted by the HTTP Request node. */
export type HttpRequestNodeInput = Record<string, unknown>;

/** Outputs produced by the HTTP Request node. */
export interface HttpRequestNodeOutput {
  result: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/** Protocols the node is allowed to fetch (SSRF guard). */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
/** Fallback request timeout when `timeoutMs` is unset or invalid. */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * HTTP Request IO node: performs a hardened `fetch` against the configured
 * URL and emits the parsed body, status, and headers.
 */
@node("core.io.httpRequest", {
  kind: "core.io.httpRequest",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-world-www",
  width: 96,
  height: 96,
  labels: ["io", "http", "request"],
  metadata: {
    title: "graph.node.io.http_request.name",
    description: "graph.node.io.http_request.description",
  },
})
@model()
export class HttpRequestNode extends GraphNode<
  HttpRequestNodeInput,
  HttpRequestNodeOutput
> {
  /**
   * Validates the URL, builds the request, and awaits the response.
   *
   * The timeout timer and the context `abortSignal` listener are always
   * removed in `finally`, so no listener leaks across runs.
   *
   * @param request - The execution request carrying the optional `value` body
   *   fallback.
   * @param context - The execution context whose `abortSignal` cancels the
   *   request when the run is aborted.
   * @returns The parsed body, HTTP status, and response headers.
   * @throws {GraphExecutionError} with code `GRAPH_HTTP_URL_REQUIRED` when no
   *   `url` is configured, `GRAPH_HTTP_INVALID_URL` when the URL does not
   *   parse, `GRAPH_HTTP_PROTOCOL_NOT_ALLOWED` for non-http(s) protocols,
   *   `GRAPH_HTTP_REQUEST_FAILED` when the request fails (or fails with
   *   `failOnError` on a non-2xx status), and `GRAPH_HTTP_REQUEST_TIMEOUT`
   *   when the request is aborted by the timeout.
   */
  override async execute(
    request: GraphNodeExecutionRequest<HttpRequestNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.url) {
      throw new GraphExecutionError(
        "HTTP Request node requires a URL",
        "GRAPH_HTTP_URL_REQUIRED"
      );
    }

    let url: URL;
    try {
      url = new URL(this.url);
    } catch {
      throw new GraphExecutionError(
        `HTTP Request node URL '${this.url}' is invalid`,
        "GRAPH_HTTP_INVALID_URL",
        { url: this.url }
      );
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw new GraphExecutionError(
        `HTTP Request node protocol '${url.protocol}' is not allowed`,
        "GRAPH_HTTP_PROTOCOL_NOT_ALLOWED",
        { protocol: url.protocol }
      );
    }

    this.appendQuery(url);

    const method = this.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.headers ?? {})) {
      if (typeof value === "string" && key.trim().length > 0) {
        headers[key.trim()] = value;
      }
    }

    const body = this.resolveBody(request, method);
    if (body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }

    const timeoutMs = this.resolveTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const abort = () => controller.abort();
    context.abortSignal?.addEventListener("abort", abort, { once: true });

    try {
      const { response, url: finalUrl } = await this.fetchFollowingRedirects(
        url,
        { method, headers, body, signal: controller.signal }
      );
      const text = await this.readCappedResponseText(response);
      const responseHeaders = Object.fromEntries(
        response.headers.entries()
      ) as Record<string, string>;
      const result =
        this.responseFormat === "text" ? text : this.parseResponse(text);

      if (this.failOnError === true && !response.ok) {
        throw new GraphExecutionError(
          `HTTP Request node received status ${response.status}`,
          "GRAPH_HTTP_REQUEST_FAILED",
          { status: response.status, url: finalUrl.toString() }
        );
      }

      return { result, status: response.status, headers: responseHeaders };
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      if (controller.signal.aborted) {
        throw new GraphExecutionError(
          `HTTP Request node timed out after ${timeoutMs}ms`,
          "GRAPH_HTTP_REQUEST_TIMEOUT",
          { url: url.toString(), timeoutMs }
        );
      }
      throw new GraphExecutionError(
        `HTTP Request node failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_HTTP_REQUEST_FAILED",
        { url: url.toString() }
      );
    } finally {
      clearTimeout(timer);
      context.abortSignal?.removeEventListener("abort", abort);
    }
  }

  /**
   * Resolves the effective request timeout, clamped to the hard ceiling.
   *
   * A missing, non-finite, or non-positive value falls back to the default; a
   * larger configured value is clamped to {@link GRAPH_HTTP_MAX_TIMEOUT_MS} so
   * a workflow cannot keep a run open indefinitely.
   */
  private resolveTimeoutMs(): number {
    const configured = Number(this.timeoutMs);
    if (!Number.isFinite(configured) || configured <= 0) {
      return DEFAULT_TIMEOUT_MS;
    }
    return Math.min(configured, GRAPH_HTTP_MAX_TIMEOUT_MS);
  }

  /**
   * Performs the request with `redirect: "manual"` and follows each redirect
   * explicitly, revalidating the http/https allowlist on every hop.
   *
   * This closes the redirect-pivot SSRF gap: the configured URL is validated
   * before the first hop, and every `Location` target is validated before it is
   * requested. The hop count is bounded by {@link GRAPH_HTTP_MAX_REDIRECTS}.
   */
  private async fetchFollowingRedirects(
    initialUrl: URL,
    init: RequestInit
  ): Promise<{ response: Response; url: URL }> {
    let current = initialUrl;
    let request = init;
    for (let hop = 0; hop <= GRAPH_HTTP_MAX_REDIRECTS; hop++) {
      const response = await fetch(current, {
        ...request,
        redirect: "manual",
      });
      if (!this.isRedirectStatus(response.status)) {
        return { response, url: current };
      }
      const location = response.headers.get("location");
      if (!location) return { response, url: current };
      if (hop === GRAPH_HTTP_MAX_REDIRECTS) {
        await this.discardResponseBody(response);
        throw new GraphExecutionError(
          `HTTP Request node exceeded the maximum of ${GRAPH_HTTP_MAX_REDIRECTS} redirects`,
          "GRAPH_HTTP_TOO_MANY_REDIRECTS",
          { url: current.toString(), maxRedirects: GRAPH_HTTP_MAX_REDIRECTS }
        );
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        await this.discardResponseBody(response);
        throw new GraphExecutionError(
          `HTTP Request node redirect target '${location}' is invalid`,
          "GRAPH_HTTP_INVALID_URL",
          { location }
        );
      }
      if (!ALLOWED_PROTOCOLS.has(next.protocol)) {
        await this.discardResponseBody(response);
        throw new GraphExecutionError(
          `HTTP Request node redirect protocol '${next.protocol}' is not allowed`,
          "GRAPH_HTTP_PROTOCOL_NOT_ALLOWED",
          { protocol: next.protocol, url: next.toString() }
        );
      }
      await this.discardResponseBody(response);
      if (response.status === 303) {
        request = { ...request, method: "GET", body: undefined };
        const headers = { ...(request.headers as Record<string, string>) };
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "content-type") delete headers[key];
        }
        request = { ...request, headers };
      }
      current = next;
    }
    return { response: undefined as never, url: current };
  }

  private isRedirectStatus(status: number): boolean {
    return (
      status === 301 ||
      status === 302 ||
      status === 303 ||
      status === 307 ||
      status === 308
    );
  }

  private async discardResponseBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // a redirect body that cannot be cancelled is not a run failure
    }
  }

  /**
   * Reads the response body with a hard byte cap.
   *
   * @param response - The response to read.
   * @returns The decoded UTF-8 body.
   * @throws {GraphExecutionError} with code `GRAPH_HTTP_RESPONSE_TOO_LARGE`
   *   when the body exceeds {@link GRAPH_HTTP_MAX_RESPONSE_BYTES}.
   */
  private async readCappedResponseText(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > GRAPH_HTTP_MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // the size failure below is authoritative
          }
          throw new GraphExecutionError(
            `HTTP Request node response body exceeds the ${GRAPH_HTTP_MAX_RESPONSE_BYTES}-byte limit`,
            "GRAPH_HTTP_RESPONSE_TOO_LARGE",
            { limitBytes: GRAPH_HTTP_MAX_RESPONSE_BYTES }
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      "utf8"
    );
  }

  /**
   * Appends the configured `query` map to the URL's search params.
   *
   * Array values repeat the key once per entry; nil entries are skipped.
   *
   * @param url - The URL to mutate.
   */
  private appendQuery(url: URL): void {
    for (const [key, value] of Object.entries(this.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry === undefined || entry === null) continue;
          url.searchParams.append(key, String(entry));
        }
        continue;
      }
      url.searchParams.append(key, String(value));
    }
  }

  /**
   * Resolves the request body for non-GET/HEAD methods.
   *
   * The configured `body` wins over the `value` input. Strings, `Buffer`s, and
   * `Uint8Array`s pass through unchanged; anything else is JSON-encoded.
   *
   * @param request - The execution request carrying the `value` input.
   * @param method - The resolved HTTP method.
   * @returns The body to send, or `undefined` for GET/HEAD or absent content.
   */
  private resolveBody(
    request: GraphNodeExecutionRequest<HttpRequestNodeInput>,
    method: HttpRequestMethod
  ): string | Buffer | Uint8Array | undefined {
    if (method === "GET" || method === "HEAD") return undefined;
    const body = this.body !== undefined ? this.body : request.inputs["value"];
    if (body === undefined || body === null) return undefined;
    if (
      typeof body === "string" ||
      (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) ||
      body instanceof Uint8Array
    ) {
      return body as string | Buffer | Uint8Array;
    }
    return JSON.stringify(body);
  }

  /**
   * Decodes the response text per `responseFormat`.
   *
   * @param text - The raw response body.
   * @returns `null` for an empty body, JSON-parsed content when parseable,
   *   otherwise the raw text.
   */
  private parseResponse(text: string): unknown {
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  @input({ handle: "value" })
  value?: unknown;

  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.http_request.fields.url.label",
    placeholder: "graph.node.io.http_request.fields.url.placeholder",
    type: "text",
  })
  @input({ handle: "url", userControlled: true })
  url: string = "";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.http_request.fields.method.label",
    type: "select",
  })
  @input({ handle: "method", userControlled: true })
  method: HttpRequestMethod = "GET";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.http_request.fields.headers.label",
    type: "json",
  })
  @input({ handle: "headers", userControlled: true, type: "object" })
  headers?: Record<string, string>;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.http_request.fields.query.label",
    type: "json",
  })
  @input({ handle: "query", userControlled: true, type: "object" })
  query?: Record<string, unknown>;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.http_request.fields.body.label",
    type: "json",
  })
  @input({ handle: "body", userControlled: true, type: "object" })
  body?: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.http_request.fields.responseFormat.label",
    type: "select",
  })
  @input({ handle: "responseFormat", userControlled: true })
  responseFormat: HttpResponseFormat = "json";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.http_request.fields.timeoutMs.label",
    type: "number",
  })
  @input({ handle: "timeoutMs", userControlled: true })
  timeoutMs?: number;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.http_request.fields.failOnError.label",
    type: "checkbox",
  })
  @input({ handle: "failOnError", userControlled: true })
  failOnError?: boolean = false;

  @required()
  @output({ handle: "result" })
  result!: unknown;

  @output({ handle: "status" })
  status?: number;

  @output({ handle: "headers" })
  headersOut?: Record<string, string>;
}
