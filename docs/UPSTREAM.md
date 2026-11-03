# EmDash upstream: how Powerfarm keeps up

EmDash is the platform Powerfarm runs on, and it is never copied into this repository. EmDash's own repository, [emdash-cms/emdash](https://github.com/emdash-cms/emdash), is "upstream". Powerfarm records exactly which version of it to use and builds on that.

## What is pinned

`upstream/emdash.json` names the repository, the exact commit and the version. Today:
- **Commit:** `981c78d`, EmDash 1.4.0.
- **Position:** `main`, 64 commits after the `emdash@1.4.0` release tag.
- **Policy:** from the next upgrade on, the pin moves only to release tags.

`scripts/setup.sh` does the following, the same way on a laptop and in CI:
1. Fetches that commit.
2. Applies Powerfarm's patches from `upstream/patches/`.
3. Links `plugin/`, `site/` and `mac/bridge/` into EmDash's workspace.
4. Builds and runs every check.

Powerfarm adds **no packages** of its own. `scripts/check-lockfile.mjs` fails the build if linking Powerfarm adds or changes anything in EmDash's lockfile, so the dependency set is the one EmDash reviewed and locked.

## Keeping up

Every Monday, the *EmDash upstream* workflow checks for a newer EmDash release. If there is one, it:
- builds Powerfarm on it exactly as CI does;
- opens a single issue for that release, reporting whether the patches still apply and whether everything builds and passes.

It changes nothing itself.

To upgrade, a person opens a PR that:
1. reads the release notes and, if there are new core migrations, the work order `upgrade-emdash` produces;
2. changes `commit`, `version` and `basedOnTag` in `upstream/emdash.json`;
3. refreshes a patch file if CI reports it applied only with a 3-way merge.

CI on that PR is the full proof. After merge, the deploy pipeline migrates D1 with `emdash migrate` before the new code takes traffic, so the live site never migrates itself.

## When code overlaps

Powerfarm and EmDash can overlap in three places. Each one shows up as a red check in the upgrade PR, never as a surprise in production.

| Overlap | How it shows up | What to do |
| --- | --- | --- |
| **A patch touches lines upstream changed** | `setup.sh` stops with `PATCH CONFLICT`, or reports a 3-way merge | If upstream now does what the patch did, delete the patch. Otherwise rewrite it against the new code. Best of all, send it upstream as a PR, so it disappears from here. |
| **An EmDash API the plugin uses changed** (hooks, route context, content, settings, KV) | Plugin typecheck or tests fail | Adapt the plugin in the same PR. The pin keeps production on the old version until the PR is green. |
| **Upstream adds something with the same name** (a collection, setting or route Powerfarm already uses) | Seed validation or tests fail. Powerfarm's routes live under `/_emdash/api/plugins/powerfarm/` and its settings and storage are per-plugin, so clashes are limited to content collection slugs. | Rename on Powerfarm's side with a migration, or adopt upstream's version if it does the same job. |

The two patches are the only places where Powerfarm changes EmDash itself:
- **0001** makes media files require sign-in;
- **0002** lets trusted plugins attach references when creating content.

Both are small and self-contained, and both are worth proposing upstream. Each one EmDash accepts is one less thing that can ever conflict.
