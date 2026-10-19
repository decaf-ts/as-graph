/**
 * @module as-graph/tests/integration/graph/nodes/loopback-support
 * @summary Loopback HTTP and SMTP stubs for the SAA-1027 Stage 3b vendor
 * integration suites.
 * @description The 3b comms/devops/io vendors have no live credentials in this
 * workspace, so their node suites drive the real service classes against a
 * process-local HTTP server or SMTP server. Every recorded request is exposed so
 * a suite can assert the exact method/path/query/body the service emitted and
 * that a fail-closed credential path never reached the network.
 */
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export interface StubRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: unknown;
  rawBody: string;
}

export interface StubReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type StubHandler = (
  request: StubRequest
) => StubReply | Promise<StubReply>;

export interface HttpStub {
  baseUrl: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

export async function startHttpStub(handler: StubHandler): Promise<HttpStub> {
  const requests: StubRequest[] = [];
  const server = createServer(async (request, response) => {
    const rawBody = await readBody(request);
    let body: unknown = rawBody;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const url = request.url ?? "/";
    const parsed = new URL(url, "http://127.0.0.1");
    const recorded: StubRequest = {
      method: request.method ?? "GET",
      url,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: request.headers,
      body,
      rawBody,
    };
    requests.push(recorded);
    try {
      const reply = (await handler(recorded)) ?? {};
      const payload =
        reply.body === undefined
          ? ""
          : typeof reply.body === "string"
            ? reply.body
            : JSON.stringify(reply.body);
      response.writeHead(reply.status ?? 200, {
        "Content-Type": "application/json",
        ...(reply.headers ?? {}),
      });
      response.end(payload);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface CapturedMail {
  from: string;
  recipients: string[];
  raw: string;
}

export interface SmtpStub {
  host: string;
  port: number;
  messages: CapturedMail[];
  close(): Promise<void>;
}

interface SmtpSession {
  socket: Socket;
  buffer: string;
  inData: boolean;
  from: string;
  recipients: string[];
  data: string[];
}

export async function startSmtpStub(): Promise<SmtpStub> {
  const messages: CapturedMail[] = [];
  const sockets = new Set<Socket>();

  const server = createTcpServer((socket) => {
    sockets.add(socket);
    const session: SmtpSession = {
      socket,
      buffer: "",
      inData: false,
      from: "",
      recipients: [],
      data: [],
    };
    socket.write("220 saa1035-smtp stub\r\n");
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      session.buffer += chunk.toString("utf8");
      let index = session.buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = session.buffer.slice(0, index);
        session.buffer = session.buffer.slice(index + 2);
        handleLine(session, line);
        index = session.buffer.indexOf("\r\n");
      }
    });
  });

  function handleLine(session: SmtpSession, line: string): void {
    if (session.inData) {
      if (line === ".") {
        session.inData = false;
        messages.push({
          from: session.from,
          recipients: [...session.recipients],
          raw: session.data.join("\r\n"),
        });
        session.from = "";
        session.recipients = [];
        session.data = [];
        session.socket.write("250 2.0.0 Queued\r\n");
      } else {
        session.data.push(line.startsWith("..") ? line.slice(1) : line);
      }
      return;
    }
    const command = line.split(" ")[0]?.toUpperCase();
    switch (command) {
      case "EHLO":
        session.socket.write("250-saa1035-smtp\r\n250-8BITMIME\r\n250 OK\r\n");
        break;
      case "MAIL": {
        const match = /<([^>]*)>/.exec(line);
        session.from = match?.[1] ?? "";
        session.socket.write("250 2.1.0 OK\r\n");
        break;
      }
      case "RCPT": {
        const match = /<([^>]*)>/.exec(line);
        if (match?.[1]) session.recipients.push(match[1]);
        session.socket.write("250 2.1.5 OK\r\n");
        break;
      }
      case "DATA":
        session.inData = true;
        session.socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        break;
      case "RSET":
        session.from = "";
        session.recipients = [];
        session.data = [];
        session.socket.write("250 2.0.0 OK\r\n");
        break;
      case "QUIT":
        session.socket.write("221 2.0.0 Bye\r\n");
        session.socket.end();
        break;
      default:
        session.socket.write("250 OK\r\n");
        break;
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    host: "127.0.0.1",
    port: address.port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
