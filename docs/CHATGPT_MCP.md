# Connect TunnelVision through MCP

TunnelVision serves read-only organisational memory over standard MCP. The
planned local HTTP endpoint is `http://127.0.0.1:3001/mcp`. Run the demo and its
MCP smoke test before configuring an external client. The ingestion process
persists memory ahead of requests; MCP only reads it.

## ChatGPT private connection

OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
describes an outbound connection that keeps the MCP listener private. It requires
a real tunnel ID, a runtime API key, Platform tunnel permissions, and ChatGPT
developer-mode access. No values are generated or guessed by this project.

1. Create a tunnel in the intended Platform organization and associate the
   intended ChatGPT workspace.
2. Obtain the official `tunnel-client` from Platform tunnel settings; consult
   `tunnel-client help quickstart` for its installed version.
3. Configure a local profile with your tunnel ID and the HTTP upstream
   `http://127.0.0.1:3001/mcp`, using `--mcp-server-url`.
4. Supply the runtime credential through the tunnel client's supported local
   credential mechanism. Keep it outside repository files.
5. Run `tunnel-client doctor --profile <profile> --explain`, then
   `tunnel-client run --profile <profile>`.
6. Create a ChatGPT developer-mode app, choose **Tunnel** as its connection,
   and select the configured tunnel. Verify tool discovery and an Abel query.

See the linked official guide for permissions and workspace associations.

## Local clients

A standards-compliant MCP client on this computer can use the HTTP endpoint
directly. Start with `list_clients`, then
`search_entities({tenant: "nike", query: "Abel"})`, followed by
`get_entity_memory({tenant: "nike", entity_id: "nike:employee:abel"})`.

The server also supports compact timeline, open-issue, related-memory, and
immutable-evidence reads. Follow the runtime README for supported local stdio
configuration once integration is complete.

## Connection status

External connection: **user setup required**. This repository does not create a
public listener, configure a public tunnel, or modify account permissions.
The TunnelVision application itself requires no LLM provider or API key.
Any tunnel credential belongs to the external transport, not extraction.
