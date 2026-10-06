---
name: jev-skills-router
description: Discover user-installed skills through jev-skills-router. Route new matching tasks first; reuse results and loaded skills; reroute only on material scope changes.
---

# jev-skills-router

From the task's working directory:

```sh
jev-skills-router route --json
```

Send the concrete task as literal stdin in its original language. Repeat `--loaded "<absolute-skill-path>"` for disclosed skills still in context; retain their paths. Reuse results, including empty results, until material scope changes or an explicit rerouting request. Keep catalog discovery inside the CLI.

- `ready`: apply every returned skill's instructions; read supporting files relative to its directory as needed. An empty `skills` list means continue directly.
- Command unavailable or `needs_setup`: read [setup](references/setup.md).
- `needs_decision`, `scope_required`, or requested catalog changes: read [catalog management](references/catalog.md).
- `needs_attention`, `scope_conflict`, or a nonzero exit: report the returned details. Never treat an error as an empty selection.

Read reference files only when their conditions apply. After resolving setup or decisions, rerun the original routing request.
