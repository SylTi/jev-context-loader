// Original helper used in Codex's cua_repl browser session, not a Node CLI.
// Bind jevTab to the visible Jev playground after inspecting its current DOM.
// Set the Questions editor to questions.json and select Jev 1.13 before running.
// Initialize jevRawRuns=[] and jevRuns=[]; entry is [caseId, task].
// Selectors reflect the recorded playground UI and must be rechecked on rerun.
const runOne = async (entry) => {
  const [caseId, task] = entry;
  await jevTab.playwright.getByRole('textbox').nth(0).fill(JSON.stringify({ task }));
  await jevTab.getAXState({ emit: false });
  const began = Date.now();
  await jevTab.playwright.getByRole('button', { name: 'Run', exact: true }).click();
  await jevTab.getAXState({ emit: false });
  await jevTab.playwright.getByRole('button', { name: 'Run', exact: true }).waitFor({ state: 'visible', timeoutMs: 45000 });
  await jevTab.playwright.getByRole('button', { name: 'Copy', exact: true }).click();
  const response = JSON.parse(await jevTab.clipboard.readText());
  await jevTab.getAXState({ emit: false });
  if (Object.keys(response.answers ?? {}).length !== 235) throw new Error(caseId + ': unexpected answer count');
  const scores = Array.from({ length: 235 }, (_, i) => response.answers['t' + i].noul);
  if (scores.some(s => !Number.isFinite(s) || s < 0 || s > 1)) throw new Error(caseId + ': invalid score');
  jevRawRuns.push({ caseId, response });
  jevRuns.push({ caseId, scores, model: response.model, uiElapsedMs: Date.now() - began, evaluationTimeMs: response.evaluation_time_ms, usage: response.usage, source: 'TypeSafe playground UI' });
  return { caseId, selected: scores.filter(s => s >= .75).length, evaluationMs: response.evaluation_time_ms };
};
