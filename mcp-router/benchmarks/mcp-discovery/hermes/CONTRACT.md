# Hermes live completion comparison

This contract defines the [Hermes benchmark](README.md). It compares the installed
runtime's built-in tool discovery with direct exposure of replayed Jev selections.
Fixtures return synthetic data and unique receipts instead of calling services.

The installed Hermes AIAgent owns provider authentication, prompt construction,
native BM25 discovery, schema disclosure and its normal model/tool loop. A small
Python adapter runs this runtime in a separate process and temporary HERMES_HOME.
The TypeScript runner owns synthetic execution, grading and retained artifacts.
JSON lines over SSH connect these owners. Only the configured model endpoint is
used; real MCP, skills, plugins, memory and gateway state are unavailable.

Inputs are the same frozen 235-tool catalog, reconstructed JSON schemas, 14
diagnostic tasks and previously measured Jev scores used in the Codex comparison.
Tools receive MCP-style names and four mcp-* toolsets. Every execution returns
an unpredictable receipt and fixture data. No real service is called.

Arms use the same installed GLM-5.3-Flash connection and default reasoning:

- native: all 235 tools, Hermes tool search enabled with its default listing.
- jev: saved selections at score >=0.75, directly exposed, no fallback.
- eager: all 235 tools directly exposed, exploratory control. A provider limit
  rejection must be recorded as a configuration failure, not a task failure.

The replay arm tests downstream completion after a fixed task-level selection;
it does not test Jev retrieval of Hermes's model-generated search queries. Its
original routing fee is included in API-equivalent cost, and routing latency is
reported separately as an estimate. The native arm can rewrite and retry queries.

Each case/arm starts a fresh process and temporary state. Arm order rotates.
Two independent case sequences can run concurrently. Provider latency and
cross-run cache warming are observed, not experimentally controlled.
A five-turn read task separately measures reuse. Success requires valid required
fixture calls, their facts and receipts in the final answer, and no unrequested
fixture writes. The same shared grader is used for Codex and Hermes.

Record model/provider/version, effective tool-search config, initial tool schema
count and schemas, search queries, transcript, fixture calls, per-response usage,
latency and errors. Also audit successful auxiliary responses through Hermes's
auxiliary-accounting hook, separately from main-loop context counts. Missing
usage or unknown prices remain unknown. Credentials never cross SSH or enter artifacts. Cached input
still occupies context. Dollar values use published API prices and are estimates,
not invoices for the configured Coding Plan subscription. Missing usage is unknown.

The runner leaves existing dashboards, gateways and configuration unchanged. Local
source and output live below `mcp-router/benchmarks/mcp-discovery`; remote scripts live in a
separate benchmark directory. Temporary Hermes state is removed after each run.
