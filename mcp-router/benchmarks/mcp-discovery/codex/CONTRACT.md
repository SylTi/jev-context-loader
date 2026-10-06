# Codex completion comparison

This contract defines the [Codex benchmark](README.md), which compares immediate
schema exposure, native deferred discovery and replayed Jev tool selection.
Fixtures are local tools returning synthetic data instead of calling services.

The official, installed Codex app-server owns model inference, native deferred
tool discovery, authentication and reported usage. The benchmark client owns
synthetic tool execution and grading. No real provider tools may execute.

All arms use GPT-6.1-Sol with medium reasoning, standard speed, the same
instructions, task texts and tool descriptions. The 235 input schemas are
reconstructed from the frozen TypeScript declarations, not raw MCP schemas.
Tools are registered as four dynamic namespaces through the official app-server
protocol. This tests native function discovery, not a production MCP transport.

- eager: all 235 definitions, deferLoading=false.
- native: all 235 definitions, deferLoading=true; Codex owns discovery.
- jev: only frozen Jev scores >=0.75, deferLoading=false. No fallback.

The subset includes English, French, multiple-tool, write, read-only
and no-tool tasks. Selection includes `h24`, whose Page-and-schedules tools
scored below 0.75 in the retrieval test, so
this subset is deliberately diagnostic and is not an unbiased population sample.
Tool results carry unpredictable receipts. Completion requires correct required
tool calls, valid fixture arguments, receipts in the final answer, fixture facts
in the answer, and no unauthorized fixture writes. Arithmetic also has an exact
answer check. The limited fixture grader is not a general quality judge.

The main run uses 14 fresh threads per arm and rotates arm order between cases.
A separate five-turn run repeats `h31`, a French Linear issue read task, in one thread, requiring a fresh fixture
read each time. Jev routes once because the task's scope stays the same; native
discovery may reuse definitions it already loaded. This measures reuse over a
short conversation, not a production workload lasting hours.

Raw app-server events, effective thread settings, tool definitions, fixture
calls, final answers and provider-reported usage are retained per run. Cached
input is a subset of input; reasoning output is a subset of output. Cache writes
are reported separately if present. Definition counts use o200k_base as an
estimate. They are not isolated provider-billed input measurements.

Jev selections are replayed from saved TypeSafe playground responses. Their measured
routing usage and published price are included in API-equivalent costs. Current
Codex runs use an existing ChatGPT subscription; these dollar estimates
are not subscription charges. Native discovery latency includes actual search;
Jev end-to-end latency can only be estimated from the recorded routing latency.

Source and artifacts stay in this benchmark subdirectory. The runner reads effective MCP server names via
the official config/read method and disables all of them before thread creation.
It does not retain configuration values or account telemetry. User MCPs, host skill discovery and project
instruction reads are disabled for these benchmark threads. The recorded app-server runs
reported the account's global `AGENTS.md` as an instruction source. This shared
baseline is present in every arm. Persistent user configuration is not edited.
