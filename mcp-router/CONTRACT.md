# Prototype contract

This contract defines the [MCP proxy](README.md), which uses Jev relevance scores
to select tools before disclosing their parameter schemas to a model.

The proxy owns its upstream MCP connections, tool catalog, Jev search, input
validation and dispatch. The agent application owns conversation state and user approvals.
Upstream servers own their credentials, authorization and tool behavior.

Configured stdio or Streamable HTTP servers supply actual `tools/list` schemas.
Public tool IDs are JSON-encoded [server, tool] pairs, so duplicate tool names
cannot collide. Search receives a query and only catalog names/descriptions;
one Jev request scores every tool independently. Scores >=0.75 are returned.
Describe returns original schemas. Call validates arguments against the original
input schema, then forwards them to the original server. Tool results, including
error flags and non-text content, are preserved. An empty search is not proof
that a capability does not exist; describe can resolve any known catalog ID.

Startup connects and lists every configured server, including pagination. Failure
aborts startup and closes opened clients. The catalog stays fixed for this
process. Shutdown closes clients. MCP stdout contains protocol messages only.
Resources, prompts, OAuth flows, sampling and elicitation are outside this
tools-only prototype. Configure credentials through environment variables.
The proxy does not reproduce each agent application's per-tool approval policy: the host
sees a generic call tool. Calls therefore have conservative MCP annotations.

The demo and benchmarks use synthetic servers only. Replay uses frozen Jev
scores for the exact original task, not fresh semantic ranking of rewritten
search queries. It records that distinction and reports both an optimistic
once-per-task routing fee and a per-uncached-search estimate using the frozen fee.
Live mode uses `TYPESAFE_API_KEY` and records actual reported usage.
No user keys, account records or service operations enter benchmark artifacts.

Comparisons reuse the measured Hermes and OpenAI fixtures and add installed
OpenCode V2 runs. Anthropic is documentation-only, with no inference benchmark.
Different models and agent applications
are separate experiments, not a controlled cross-model ranking. Missing usage,
prices or unsuccessful runs remain unknown. Reports retain both improvements and
regressions in completion, context and cost.
