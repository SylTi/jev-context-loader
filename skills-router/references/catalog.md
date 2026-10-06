# Catalog decisions and management

Instructions for the calling model when the CLI requests a catalog decision or the user requests catalog changes. Use `--json` to receive structured questions instead of terminal prompts. Ask the returned questions; preserve each request's scope.

## Original policy

For `kind: original_policy`, recommend `disable`. Both `disable` and `delete` remove originals from discovery after verified import and retain the complete imported skill in Jev's catalog. `disable` also keeps a separate restorable backup of the original. Explain that `keep` is usually the wrong choice: original descriptions remain in model context alongside Jev, defeating its main benefit.

Save the user's choice:

```sh
jev-skills-router configure --policy <policy> <scope-flag> --json
```

Replace `<policy>` with the approved `disable`, `delete`, or `keep`. Replace `<scope-flag>` with `--global` or `--project` matching the request's `scope`.

## Uncommon skills

For `kind: uncommon_skill`, use `accept` for the user's `import` choice and `ignore` for `ignore`:

```sh
jev-skills-router accept --candidate <candidate-id> <scope-flag> --json
jev-skills-router ignore --candidate <candidate-id> <scope-flag> --json
```

Replace `<candidate-id>` with the request's `candidate.id`, and `<scope-flag>` with its matching scope flag. Declines are remembered.

## Requested management

```sh
jev-skills-router add "<source>" --json
jev-skills-router add "<source>" --skill "<skill-name>" --json
jev-skills-router update --json
jev-skills-router discover --reset --json
```

Replace placeholders with the requested source and skill name. Sources can be local skill files, complete folders, or repositories. `--reset` clears ignored candidates when the user requests it.

For `scope_required`, ask the user to choose a returned destination, then repeat the command with `--global` or `--project`. These flags select existing installations; do not guess between them.

For command options or an unclear error, run `jev-skills-router --help`.

After resolving pending setup or decisions, rerun the original command. If it was a routing request, retain its original task text and loaded-skill paths. Report conflicts or failures instead of treating them as an empty selection.
