# Codex native discovery benchmark

This benchmark measures task completion, model context and estimated cost for
three ways of exposing tools to Codex. It uses 235 saved tool definitions and
14 synthetic tasks from the [retrieval benchmark](../README.md).

This runs real inference through the official Codex app-server using an existing
ChatGPT login. Tool execution uses local fixtures, including the write task. No
Linear, GitHub, Pages or desktop account actions are dispatched.

The runner compares three modes. Eager loading exposes every tool's parameter
schema immediately. Native `deferLoading` lets Codex discover and load schemas
as needed. Jev replay exposes only tools scoring at least 0.75 in the saved
TypeSafe playground responses. Cost estimates include the measured routing
usage from those responses. Replay needs no Jev API key.

Fixtures are local tools returning synthetic data. Each call also returns a
unique receipt, which the final answer must include to demonstrate that the
model used the tool result.

## Rerun

Requirements: Node.js 22 or later, npm, and a logged-in Codex CLI supporting
experimental dynamic tool namespaces and `deferLoading`. The recorded run uses
Codex CLI 0.160.1 and GPT-6.1-Sol with medium reasoning and standard speed.
Running inference consumes ChatGPT plan usage. Dollar figures are estimates at
published API prices, not charges to that subscription.

From the repository root:

```sh
cd mcp-router/benchmarks/mcp-discovery
npm ci --ignore-scripts
codex login status
npm run codex:test
npm run codex:typecheck
npm run codex:run
npm run codex:long
npm run codex:report
```

`--ignore-scripts` prevents the parent benchmark's `prepare` lifecycle from
regenerating the frozen catalog and questions. The existing lockfile pins
dependencies. If the CLI is outside PATH, set `CODEX_BINARY` to its executable
path. The runner discovers the actual configured MCP server names and disables
them before starting benchmark threads. Configuration values and account
telemetry are not saved.

A smaller run is also supported:

```sh
npm run codex:run -- h31,h24 eager,native,jev
```

The default run covers 14 tasks in fresh threads for each arm. The separate
conversation run repeats the same Linear task five times in one thread and
requires fresh reads. It charges Jev routing once because the scope stays the
same. Result filenames are overwritten when rerun; copy `results/` first to
preserve your previous experiment. A subset run updates only its own files;
`codex:report` summarizes all currently present files for the 14 default tasks.

## Inputs and artifacts

- `../catalog.json`, `../cases.json` and `../results/jev-runs.json` are frozen inputs.
- `tools.json` contains all reconstructed JSON input schemas. They come from
  public TypeScript declarations, not original provider `tools/list` responses.
- `run.ts` contains the runner, fixture data, instructions and explicit task subset.
- `support.ts` and `support.test.ts` contain schema reconstruction, grading and costs.
- `CONTRACT.md` states the measurement boundaries and limitations.
- `results/h*-*.json` retains answers, arguments, receipts, usage samples and events.
- `results/report.json` summarizes fresh-thread and five-turn results, source
  hashes, frozen input hashes and the actual CLI user-agent version.
- `results/h31-*-long.json` retains the five-turn conversation results.
- Archived pilot directories are excluded from the report. The empty-schema pilot
  is invalid and kept only as diagnostic evidence.

This tests Codex native discovery of dynamic function namespaces. It does not
test MCP network transport or Claude's discovery. The completion grader checks
fixture facts, receipt provenance, required calls, known arguments and forbidden
writes. It is a narrow executable check, not a general assessment of answer
quality. The subset deliberately includes `h24`, a task to read a ChatGPT Page
and its attached schedules. Its required tools scored below 0.75 in the retrieval test.

## Token and cost interpretation

First-request and peak-request input counts measure actual model context,
including ordinary instructions and user input. Total input sums requests over
the turn or conversation, including cache reads. It is not the size of a single
context window. `definitionTokens` estimates the entire registered tool catalog
with `o200k_base`; deferred tools are registered but are not necessarily loaded.

For GPT-6.1-Sol, the estimated cost is:

```text
((input - cached - cache_writes) * $2.00
 + cached * $0.10
 + cache_writes * $2.50
 + output * $10.00) / 1,000,000
 + Jev routing input * $0.042 / 1,000,000
```

Reasoning output is already included in output. These are standard prices for
requests below 272K input tokens. Jev output is free at the cited rate. Costs
include failed completion attempts. Cache hit rates are observed, not forced.
Jev latency is replayed, so end-to-end latency is an estimate using its recorded
server evaluation time, not a fresh API or playground request.

Sources: [Codex app-server](https://developers.openai.com/codex/app-server/),
[OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search),
[GPT-6.1-Sol pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[Jev pricing](https://docs.typesafe.ai/models).

## Results

Measured on 2026-10-06. All 42 runs finished. Means below cover the same 14
tasks, including failed attempts and two tasks requiring no provider tools.

| Mode | Fixture completion | First-request input | Peak-request input | API-equivalent cost/task |
| --- | ---: | ---: | ---: | ---: |
| All schemas eager | 13/14 | 62,472 | 62,608 | $0.1070 |
| Native deferred discovery | 14/14 | 8,064 | 16,060 | $0.0412 |
| Jev replay, score >=0.75 | 13/14 | 8,645 | 8,877 | $0.0258 |

Native discovery avoided 87.1% of the eager mode's initial input. Jev's initial
input was slightly higher than native discovery. During execution, Jev reduced
the mean peak input by another 7,183 tokens, or 44.7%, and the estimated mean
cost by 37.4% relative to native discovery. These are results for this fixture
and task subset, not general model quality or production savings estimates.

| Mode | Total input/task | Cached input/task | Output/task | Model requests/task | Model-run wall time/task |
| --- | ---: | ---: | ---: | ---: | ---: |
| All schemas eager | 120,633 | 71,250 | 112 | 1.93 | 9.16 s |
| Native deferred discovery | 48,036 | 29,723 | 163 | 3.29 | 13.38 s |
| Jev replay | 17,806 | 6,784 | 114 | 2.00 | 9.20 s |

Jev's recorded server evaluation adds 0.28 seconds on average, giving an estimated
9.48-second end-to-end figure. This omits a fresh routing network round trip and
must not be read as a measured live Jev integration. The 14-task totals are
$1.4981 eager, $0.5772 native, and $0.3615 Jev. Cache writes were zero in the
reported usage. Costs include cached reads, output and the Jev routing fee.

Two attempts failed. Eager h21 omitted the required commit SHA while fetching
workflow runs, despite having the schema and the PR's head SHA. Native and Jev
completed that task. Jev h24 selected no tools, so the model could not read the
Page and its attached schedules. Native and eager completed it. Jev's failure
was the same missing-capability error found in the retrieval-only experiment.

No actual MCP or shell command calls occurred in the 42 event logs. All executed
provider operations were dynamic local fixtures. The checks confirmed the same
model, reasoning setting and provider isolation in every run. Helper tests,
strict TypeScript checks and the reconstructed schema audit passed.

For the five-turn reuse experiment, every arm passed all five fresh reads. These
are conversation totals, with one Jev routing fee for the whole conversation:

| Mode | Peak-request input | Total input | Cached input | API-equivalent cost |
| --- | ---: | ---: | ---: | ---: |
| All schemas eager | 63,449 | 629,612 | 564,608 | $0.1911 |
| Native deferred discovery | 18,879 | 191,826 | 171,136 | $0.0638 |
| Jev replay | 9,247 | 87,288 | 67,712 | $0.0532 |

Jev saved 9,632 peak-context tokens relative to native discovery, or 51.0%, while
estimated cost fell by 16.5%. Native definitions were reused after the initial
discovery. Cached reads narrow the cost difference; they still occupy context.
This is a five-turn example, not a measurement of hours-long work. Model-run
wall times were 38.86 seconds eager, 36.49 seconds native, and 41.06 seconds Jev.
The replay does not establish a Jev latency advantage.

The final audit covered all 45 fresh-task and conversation artifacts. No live
MCP or shell calls occurred. All 15 conversation turn grades passed. The five
Codex helper tests, three original benchmark tests, both typechecks and the
browser-helper syntax check passed on Linux with Node.js 22.23.3. No Windows or
macOS execution was performed for this benchmark.
