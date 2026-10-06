# Jev MCP router experiment

An experimental tool-discovery component of [jev-context-loader](../README.md).
MCP, the Model Context Protocol, connects agent applications to external tools.
This proxy uses [Jev](https://docs.typesafe.ai/models) to select relevant tools
before loading their full schemas into the agent's context. Measured results
are mixed; [COMPARISON.md](COMPARISON.md) covers completion, context and cost.
Retrieval benchmarks and Codex/Hermes model-run data are in
[benchmarks/mcp-discovery](benchmarks/mcp-discovery/README.md).

A working, tools-only MCP proxy for the experiment. It connects to user-selected
MCP servers and exposes three tools instead of their full catalogs:

1. `search` scores every upstream tool through Jev and returns all matches >=0.75.
2. `describe` returns original input/output schemas and annotations.
3. `call` validates the original input schema and forwards the operation.

Exact repeated queries share an in-memory result. Failed searches can be retried.
Tool IDs encode the server and original name, so same-name tools stay distinct.
Upstream error flags, structured content, images and other MCP content are
preserved. The catalog is read at startup, including pagination; restart to
refresh it. Skill discovery is implemented separately in
[skills-router](../skills-router/README.md).

## Run the proxy

Requires Node 22+. From this directory:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js --help
```

Set `TYPESAFE_API_KEY` in the agent application's environment. Create a config
using [example.config.json](example.config.json), removing unused servers.
`env` and HTTP `headers` map upstream names to environment-variable names.
For example, `Authorization: YOUR_UPSTREAM_AUTHORIZATION` reads that environment
variable, whose value should include its `Bearer ` prefix if the server needs it.
Keys stay outside the config. Relative working directories follow the launching
process; use absolute paths in the agent application's configuration.

Add this as a stdio MCP server to the agent application, replacing absolute paths:

```json
{
  "command": "node",
  "args": ["/absolute/path/jev-context-loader/mcp-router/dist/cli.js", "/absolute/path/config.json"]
}
```

To route an upstream server through the proxy, remove its direct registration
from the agent application. Otherwise, both catalogs remain exposed. The proxy
does not edit these settings automatically. The npm package is private and
unpublished; run the built local CLI rather than `npx jev-mcp-router`.

This prototype supports stdio downstream, and stdio or Streamable HTTP upstream.
It does not implement legacy SSE, interactive OAuth, resources, prompts, sampling
or elicitation. It uses the maintained MCP v1 SDK for classic stdio compatibility.
The host sees a generic `call`, so its usual per-upstream-tool approval rules
cannot be assumed to survive. The generic tool has conservative annotations.

## Reproduce without a Jev key

```sh
npm test
npm run typecheck
npm run demo
npm run compare
npm run audit
```

The demo starts a real MCP proxy and a synthetic upstream server with the frozen
235-tool catalog. It includes a successful Linear issue lookup and a task where
the required Page/schedules tools scored below the selection threshold. The
three exposed proxy tools occupy 241 definition tokens, compared with the 62,093
tokens in eager JSON definitions, using `o200k_base`. This is definition text,
not a measured model prompt or an advantage over native discovery.

Replay uses saved playground scores conditioned on the original task. It does
not rank new model-generated queries through Jev, even if an agent rewrites a
search. The replay measures neither live semantic retrieval nor Jev network latency. The live
adapter is exercised with a mock client in tests; a real key is needed to verify
its network path.

## Compare installed OpenCode V2

```sh
npm run bench -- h31 native,jev
npm run bench
npm run compare
```

Set `OPENCODE_BINARY` to its absolute executable path if it is outside Node's
PATH. `OPENCODE_BENCH_MODEL` defaults to
`zai-coding-plan/glm-5.3-flash`. The model must be configured and authenticated in
your installation. Runs consume its existing provider usage.

The runner uses temporary project/config directories, denies ordinary tools and
allows only fixtures plus native Code Mode when applicable. It does not modify
your global config or call real services. Results retain model events, fixture
calls, arguments, receipts, grades, usage and elapsed time. Repeated runs overwrite
their own filenames; copy results first to preserve an earlier run.
Benchmark sessions remain in OpenCode's normal session database, under temporary
project paths. The runner removes its temporary project/config files and servers.
It waits for MCP connection and plugin activation before inference. Three
empty-catalog startup attempts are retained in [results/opencode/startup-attempts](results/opencode/startup-attempts/README.md)
and excluded from the paired comparison. Their recorded assistant cost is $0.001023.

The 14 tasks are a diagnostic subset, with one run per task and arm. They are not
a statistical reliability study. `audit` checks model identity, fixture-only
calls, grades, usage, replay queries and accounting. It also flags the observed
empty-catalog startup signatures. Actual outgoing definitions were not intercepted.
Usage measures the assistant loop; hidden retries and auxiliary requests have not
been independently captured. The installed runtime and token-field mapping are
retained in `results/opencode/runtime.json`.

Two Jev cost estimates are reported. The optimistic estimate charges one ranking
per task. The per-search estimate charges the frozen ranking fee for each actual
uncached search. Neither is a billed Jev charge. Rewritten queries reuse the
original task's scores, so live Jev might recover sooner, return different tools,
or use a different number of searches. Cached identical searches add no fee.

Anthropic's comparison uses official documentation only, with no measured model
runs or costs. OpenAI and Hermes were evaluated through direct disclosure of
Jev-selected schemas; OpenCode was evaluated through this MCP proxy.
[COMPARISON.md](COMPARISON.md) explains the methods, costs and limitations.

Absolute paths in saved transcripts identify the benchmark environment. Scripts
resolve component and benchmark directories relative to their own files.

The [contract](CONTRACT.md) defines the ownership and invariants. Tests cover
thresholds, query caching/retry, pagination, duplicate names, argument validation,
metadata/error forwarding and an actual stdio proxy call. Executed on Linux;
Windows/macOS execution has not been verified. Scripts use Node process argument
arrays rather than shell command strings.
