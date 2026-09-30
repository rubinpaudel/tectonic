# TunnelVision: under three minutes

Before presenting run `pnpm demo:up`. In another terminal run `pnpm test:acceptance`. For retry verification run `pnpm test:acceptance --reingest` before presenting. Local endpoint: `http://127.0.0.1:3001/mcp`.

## 0:00–0:35 — fragmented evidence

Show `mock-data/nike/gmail`, `sharepoint`, and `teams`: 50 fictional employees, 80 sources. No single system contains Abel's complete story. Show the old employee PDF, September 21 address email, and HR messages in `teams/hr-payroll-september.json`.

## 0:35–1:35 — retained organisational memory

Explain that ingestion already reconstructed and persisted the story. Ask the connected agent: **“What has recently changed in Abel's dossier?”**

Call `search_entities({tenant:"nike",query:"Abel"})`, then `get_memory_timeline({tenant:"nike",entity_id:"nike:employee:abel",from:"2026-09-20"})`.

Show the move effective September 20, email September 21, HR acknowledgment and commitment September 22, and apparently unprocessed update September 28. The bicycle commute rose from roughly 5 to 15 km.

## 1:35–2:15 — current state with history

Ask **“What is Abel's current address?”** with `get_entity_memory({tenant:"nike",entity_id:"nike:employee:abel"})`.

Current since September 20: **82 Meadow Crescent, 3000 Leuven (synthetic)**. Historical: **14 Lantern Lane, 1000 Brussels (synthetic)**.

Show supersession and evidence using `get_memory_evidence({tenant:"nike",memory_id:"<current-address-id>"})`. Gmail reports the move, Teams supports it, and the old dossier is retained.

## 2:15–2:55 — unresolved issues

Ask **“Is there anything we should pay attention to regarding Abel?”** with `get_open_issues({tenant:"nike",entity_id:"nike:employee:abel"})`.

Show the unconfirmed dossier update and potential EUR 30 monthly difference: EUR 50 recorded versus EUR 80 supported by synthetic mobility policy. These remain uncertain; no evidence proves an actual underpayment.

Close: “The agent did not reconstruct Abel's history by searching every system. TunnelVision already remembered it.”

## Connection and fallback

External ChatGPT connectivity requires the user's secure tunnel and workspace configuration; follow [the connection guide](docs/CHATGPT_MCP.md). Local HTTP is verified separately. If external connectivity is unavailable, run the actual SDK acceptance command locally and show its results.
