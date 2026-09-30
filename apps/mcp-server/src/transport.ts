import { createServer, type Server, type ServerResponse } from "node:http";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpServer, type McpServerOptions } from "./tools.js";

export interface HttpMcpOptions extends McpServerOptions {
  port?: number;
  /** The caller controls repository ownership. Called once when the listener closes. */
  onClose?: () => Promise<void>;
}

export interface RunningHttpMcpServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

function response(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/** Stateless Streamable HTTP. Only loopback is exposed; every POST owns a transport. */
export async function startHttpMcpServer(options: HttpMcpOptions): Promise<RunningHttpMcpServer> {
  const port = options.port ?? 3001;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid MCP port.");
  const reportError = (error: unknown) => { try { options.onError?.(error); } catch { /* Keep lifecycle cleanup independent of logging. */ } };
  const active = new Set<McpServer>();
  const http = createServer(async (req, res) => {
    if (req.url?.split("?")[0] !== "/mcp") { response(res, 404, "Not found."); return; }
    const address = http.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) { response(res, 403, "Invalid Host."); return; }
    if (req.headers.origin && !allowedHosts.some((host) => req.headers.origin === `http://${host}`)) {
      response(res, 403, "Invalid Origin."); return;
    }
    if (req.method !== "POST") { res.setHeader("allow", "POST"); response(res, 405, "Method not allowed."); return; }
    const mcp = createMcpServer(options);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 64 * 1_024 });
    active.add(mcp);
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      try { await mcp.close(); } finally { active.delete(mcp); }
    };
    res.once("close", () => { void cleanup().catch(reportError); });
    try {
      // SDK v1's HTTP accessors include undefined; its own Transport type omits it.
      await mcp.connect(transport as Transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      reportError(error);
      if (!res.headersSent) response(res, 500, "MCP request failed.");
      else res.end();
      await cleanup();
    }
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("MCP listener has no TCP address.");
  let closing: Promise<void> | undefined;
  return {
    server: http, url: `http://127.0.0.1:${address.port}/mcp`,
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
        http.closeAllConnections();
        await Promise.allSettled([...active].map((mcp) => mcp.close()));
        await stopped;
        await options.onClose?.();
      })();
      return closing;
    },
  };
}

export interface StdioMcpOptions extends McpServerOptions {
  stdin?: Readable;
  stdout?: Writable;
  onClose?: () => Promise<void>;
}

export async function startStdioMcpServer(options: StdioMcpOptions) {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport(options.stdin ?? process.stdin, options.stdout ?? process.stdout,
    { maxBufferSize: 64 * 1_024 });
  await server.connect(transport);
  let closing: Promise<void> | undefined;
  return { server, close() {
    closing ??= (async () => { try { await server.close(); } finally { await options.onClose?.(); } })();
    return closing;
  } };
}
