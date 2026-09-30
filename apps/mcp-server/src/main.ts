import { connectMemoryRepository } from "./repository.js";
import { startHttpMcpServer, startStdioMcpServer } from "./transport.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--stdio")) throw new Error("Usage: tunnelvision-mcp [--stdio]");
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("Set DATABASE_URL to the local TunnelVision Postgres database.");
  const portText = process.env["MCP_PORT"] ?? "3001";
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65_535) throw new Error("MCP_PORT must be 1..65535.");
  const repository = await connectMemoryRepository(connectionString);
  const onError = () => { process.stderr.write("TunnelVision memory request failed; check the local database.\n"); };
  let running: { close(): Promise<void> };
  try {
    if (args.includes("--stdio")) {
      running = await startStdioMcpServer({ repository, onError, onClose: () => repository.close() });
      process.stderr.write("TunnelVision MCP ready on stdio.\n");
    } else {
      const http = await startHttpMcpServer({ repository, port: Number(portText), onError, onClose: () => repository.close() });
      running = http;
      process.stderr.write(`TunnelVision MCP ready at ${http.url}\n`);
    }
  } catch (error) { await repository.close(); throw error; }
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    process.stdin.off("end", shutdown);
    void running.close().then(() => { process.exitCode = 0; }, () => {
      process.stderr.write("TunnelVision shutdown failed.\n"); process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (args.includes("--stdio")) process.stdin.once("end", shutdown);
}

main().catch((error: unknown) => {
  // Startup configuration errors are deliberately credential-free.
  const safeMessages = ["Usage:", "Set DATABASE_URL", "MCP_PORT", "@tunnelvision/db must export"];
  const message = error instanceof Error && safeMessages.some((prefix) => error.message.startsWith(prefix))
    ? error.message : "TunnelVision MCP could not start. Check the local database and port.";
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
