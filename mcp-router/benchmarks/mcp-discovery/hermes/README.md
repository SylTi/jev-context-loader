# Hermes with GLM-5.3-Flash

This benchmark compares Hermes's built-in tool discovery with direct exposure
of tools selected by Jev. It measures completion, context and estimated cost on
235 saved tool definitions and 14 synthetic tasks from the
[retrieval benchmark](../README.md).

The runner starts Hermes's `AIAgent`, its Python agent runtime, with a configured
Z.ai model connection, synthetic local tools and a temporary profile. It does
not call the real GitHub, Linear, Spaces or Codex services. Existing Hermes
gateway and dashboard processes remain separate. See [CONTRACT.md](CONTRACT.md)
for the comparison and its limits.

## Results from 2026-10-06

Installed Hermes `v0.21.5`, commit `79af3f6cea8067284a7ea5725078578b3f790adb`,
with GLM-5.3-Flash through Z.ai's Coding Plan endpoint. The installed source
checkout was clean. Inference used the existing subscription; no real provider
tool executed. This used isolated AIAgent processes rather than dashboard chat
sessions, with the same installed runtime and model connection.

All 14 diagnostic cases ran in both arms. Values below are per-task means,
including Jev's failed case in its averages.

| Measurement | Native Hermes | Jev selection replay |
|---|---:|---:|
| Fixture completion | 14/14 | 13/14 |
| First-request input tokens | 5,200 | 2,711 |
| Peak input tokens | 6,058 | 2,923 |
| Total input tokens over the task | 18,263 | 5,770 |
| Cache-read tokens within total input | 15,634 | 2,441 |
| Output tokens, including reasoning | 518 | 346 |
| Main model requests | 3.14 | 1.86 |
| GLM API-equivalent cost | $0.001122 | $0.000746 |
| Jev API-equivalent routing fee | $0 | $0.001965 |
| Total API-equivalent cost | $0.001122 | $0.002711 |
| Observed elapsed time | 36.46 s | 22.56 s |

Jev saved about 3,135 peak context tokens, 52% relative to native discovery but
0.31% of GLM's million-token window. Its estimated total cost was 2.41 times
native Hermes's cost. Its failure was `h24`, a task to read a ChatGPT Page and
its attached schedules. Both required tools scored below 0.75 in the saved Jev
responses. Native Hermes completed that case. No unrequested
fixture writes were recorded.

Hermes's native discovery functions include a names-only listing of all 235 tools. GLM selected
names from that listing and called `tool_describe` directly. It never invoked
`tool_search`, in either the 14 tasks or the five-turn run. This establishes that
the complete default workflow worked on these tasks; it does not benchmark
Hermes's BM25 ranker. The initial bare-BM25 retrieval result cannot predict this
workflow's completion quality. BM25 is a keyword-based ranking algorithm;
its retrieval results are reported in the [retrieval benchmark](../README.md).

The separate five-turn experiment repeats `h31`, a French Linear issue read task,
and requires a fresh read each turn:

| Measurement for the whole conversation | Native Hermes | Jev selection replay |
|---|---:|---:|
| Successful turns | 5/5 | 5/5 |
| Peak input tokens | 7,147 | 3,983 |
| Total input tokens | 68,073 | 32,313 |
| Cache-read tokens within total input | 65,472 | 28,032 |
| Output tokens, including reasoning | 1,293 | 993 |
| Main model requests | 11 | 10 |
| GLM API-equivalent cost | $0.003001 | $0.001980 |
| Jev routing fee, charged once | $0 | $0.001965 |
| Total API-equivalent cost | $0.003001 | $0.003945 |
| Observed elapsed time | 61.59 s | 65.79 s |

Reusing the selected tools and native described schema narrowed the difference
to one model request. Jev's total estimate was still 31.4% higher. The latency
ordering reversed in this run; provider load and cold profile startup varied,
so request counts are stronger evidence than these timings.

An additional eager control used the same French Linear task with all 235
function definitions directly visible. It passed and used about 70,000 tokens
on its first request, compared with 5,197 for native discovery on that task.
Native discovery therefore already removed about 92.6% of the initial input
relative to loading everything. This is one control case, not a 14-task eager
comparison.

The outgoing SDK requests contained 235 distinct function definitions, and the
Coding Plan endpoint accepted them. Z.ai's [Chat Completions reference](https://docs.z.ai/api-reference/llm/chat-completion)
documents a maximum of 128 functions. That documented limit was not enforced
on this connection in this control; other endpoints may behave differently.
The retained `api_request` events account for Hermes moving tool definitions
into the SDK's `extra_body`, rather than counting its empty typed tool slots.

The audited main comparison and reuse runs contain 38 user turns, 91 measured
main-model requests and 48 fixture calls. No auxiliary responses were observed.
Successful pilot runs were repeated to add missing accounting coverage, not to
change their grading outcome; the earlier artifacts remain in `pilot-main-only`.

For this catalog and model, adding a paid Jev router does not look worthwhile.
It reduces model requests and context, but native discovery already makes the
catalog compact, the routing fee outweighs the model savings, and the fixed
threshold misses a required capability. This leaves larger catalogs with a
degraded listing, opaque names, and live semantic search as untested cases.

Raw results are in [results/report.json](results/report.json); the
artifact consistency checks are in [results/audit.json](results/audit.json).

Verification passed: 3 Hermes TypeScript tests, 2 Python adapter tests, 5 shared
Codex tests, 3 retrieval tests, and the corresponding TypeScript checks. The
retained comparison audit also passed. These checks validate the benchmark
contracts and artifacts, separately from the model completion results above.

## Rerun

From the repository root, install the benchmark's locked Node dependencies:

```sh
cd mcp-router/benchmarks/mcp-discovery
npm ci --ignore-scripts
npm run hermes:test
npm run hermes:typecheck
PYTHONDONTWRITEBYTECODE=1 python3 hermes/test_agent.py
```

`--ignore-scripts` prevents the `prepare` lifecycle from regenerating the saved
catalog and questions.

Choose an SSH host with Hermes installed and configured for `glm-5.3-flash`.
The existing profile supplies credentials on that machine; no key is transferred
to this runner. Set paths for your installation, using its actual Python runtime:

```sh
export HERMES_SSH_TARGET=hermes@YOUR_HOST
export HERMES_BENCH_DIR=/home/hermes/jev-mcp-benchmark
export HERMES_SOURCE_ROOT=/home/hermes/.hermes/hermes-agent
export HERMES_PROFILE_HOME=/home/hermes/.hermes
export HERMES_PYTHON=/path/to/hermes/python3

ssh "$HERMES_SSH_TARGET" "mkdir -p '$HERMES_BENCH_DIR'"
scp hermes/agent.py "$HERMES_SSH_TARGET:$HERMES_BENCH_DIR/agent.py"
npm run hermes:run -- h31 native,jev   # pilot
npm run hermes:run                   # 14 tasks x 2 arms
npm run hermes:long                  # five turns in each arm
npm run hermes:report                # rebuild report from saved runs
npm run hermes:audit                 # validate the full retained comparison
```

The runner needs Node, OpenSSH and an existing configured Hermes installation.
Environment variables can also be set in PowerShell; the TypeScript orchestrator
does not require Bash. These instructions and the Python adapter were exercised
against the recorded Linux installation only.

`native` keeps all 235 fixtures behind Hermes's normal search/describe/call
functions and default catalog listing. `jev` directly exposes the saved Jev
selections at score >=0.75, without fallback. `eager` is an optional diagnostic
control, invoked with `npm run hermes:run -- h31 eager`. It may exceed the
provider's function-count limit. No reduced-catalog eager result is substituted.

Each invocation overwrites the corresponding result filenames. Preserve a run
by copying `hermes/results/` first. The initial failed adapter attempts are kept
under `results/preflight-*` and excluded from reports. Preliminary successful
pilots without the auxiliary-call audit are under `results/pilot-main-only/`.

## Measurements

Per-run JSON retains the initial visible schemas, effective configuration,
Hermes commit, model and provider identity, main-loop transcript, generated
search queries, fixture arguments/results and per-response provider usage.
The adapter also observes Hermes's auxiliary response-accounting hook. These
requests are recorded separately and included in total cost when their model's
rate is known. Unknown model prices or missing accounting coverage yield an
unknown total cost. Provider failures or retries that omit usage cannot be priced.
The shared fixture executor and completion grader are reused from the Codex
experiment. Each fixture call returns synthetic data and a unique receipt.
A pass requires correct calls, arguments, returned facts and those receipts,
plus no unrequested fixture writes. This is a narrow synthetic completion check.

Initial and peak prompt counts are provider-reported context occupancy. Total
input sums every main-loop request, including cache reads. Cache is a subset of
input; reasoning is a subset of output. Missing usage is reported as unknown.
Elapsed time includes process startup, model requests and fixture round trips
over SSH. Jev routing is replayed; its recorded evaluation latency is a separate
estimate, not measured live routing latency.

API-equivalent GLM-5.3-Flash cost uses USD per million tokens: $0.15 uncached
input, $0.03 cache reads, $0.50 output. Jev uses $0.042 per million input tokens
from the recorded playground measurements. The connection used here is a Coding Plan
subscription. These estimates are not additional charges or its quota accounting.
Rates verified 2026-10-06 against [Z.ai pricing](https://docs.z.ai/guides/overview/pricing).

This compares a model that can rewrite/retry native searches with a fixed
task-level Jev selection. It is not an interchangeable-ranker test. A live Jev
backend serving Hermes-generated queries would require another experiment.
The 14 cases were chosen for diagnosis, including a known Jev miss; they are
not a random workload sample, and a single run per arm has sampling variance.
The live run uses two independent processes at a time, with task/arm ordering
retained in the transcripts. Latency includes provider load and cold temporary
profile initialization; it is not a controlled inference-speed comparison.
