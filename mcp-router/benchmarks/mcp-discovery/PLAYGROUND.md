# Repeating the Jev playground measurements

The [retrieval benchmark](README.md) scores 235 tool definitions for 50 synthetic
tasks. Saved responses allow offline reporting and replay in the task-completion
comparisons. This procedure collects a new set of scores through the browser UI.

To collect fresh Jev measurements without an API key, use the visible
[Jev playground](https://console.typesafe.ai/playground). Select Jev 1.13 and
paste the complete `questions.json` object into its Questions editor. Do not
regenerate the questions when reproducing this frozen experiment.

For each object in `cases.json`, enter `{"task":"the exact case.task text"}`
as Context, click Run, wait for the new response, and copy its full JSON. Save
`{caseId, response}` entries to `results/jev-raw-responses.json`. The required
normalized entries in `results/jev-runs.json` contain:

```text
caseId, scores[235] in t0..t234 order, model, uiElapsedMs,
evaluationTimeMs=response.evaluation_time_ms, usage=response.usage,
source="TypeSafe playground UI"
```

`playground-helper.js` preserves the browser helper used for the recorded run.
It is for Codex's `cua_repl` runtime, not `node` or ordinary Playwright. Bind
`jevTab` to the visible playground, inspect the current UI, initialize the two
output arrays, and pass `[caseId, task]` to `runOne`. Recheck the selectors if the
playground changes. The recorded run's pasted question hash and task texts are
in `results/ui-inputs.json`; request IDs in the raw responses prove distinct runs.

Save or copy the output arrays through normal local file tooling, preserving
the exact JSON and recording the new run's question hash and submitted inputs. Keep
the original results separately before replacing them. From
`mcp-router/benchmarks/mcp-discovery`, run `npm run report` to recompute retrieval
metrics. To measure completion with the new scores, follow the
[Codex benchmark instructions](codex/README.md); `npm run codex:run` makes live
model requests and consumes the configured provider's usage. Browser workflow
timings and server evaluation timings are different measurements.
