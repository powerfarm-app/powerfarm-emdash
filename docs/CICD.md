# CI/CD

The plan is in the doc *Powerfarm CI/CD — GitHub to Cloudflare plan*. This page describes what is in the repository **today** (phase 1) and what comes next.

## Phase 1 (in this repository now)

| Workflow | When | What it proves | Secrets |
| --- | --- | --- | --- |
| `ci.yml` → *Plugin and Mac tests* | Every PR and push to `main` | Plugin tests (Identity, MDM, release gate, OIDC, seals), Mac bridge tests, the lockfile rule, script syntax | None |
| `ci.yml` → *Build on pinned EmDash* | Every PR and push to `main` | `scripts/setup.sh` end to end: the patches apply, no new dependencies, EmDash build, patch tests, plugin typecheck, `astro check`, seed and every migration validated, Worker build, scheduler wiring | None |
| `upstream.yml` | Mondays, or by hand | Whether the newest EmDash release would work: one issue per release with the result | `GITHUB_TOKEN` (issues only) |
| Dependabot | Weekly | Updates for the pinned GitHub Actions only | — |

Rules in the workflows:
- Actions are pinned by commit SHA, using the same pins EmDash uses.
- `permissions: contents: read` everywhere except the upstream report.
- `persist-credentials: false` on every checkout.
- Nothing deploys.

**Live sites never migrate themselves.** `site/astro.config.mjs` sets `migrations: { runtime: "check" }`, so the Worker answers 503 rather than migrate its own database. On the first deploy, and after any EmDash upgrade, run `pnpm --dir site cf:migrate:status`, then `cf:migrate`, before using the site. From phase 2 the deploy pipeline does this.

## Repository settings to turn on (GitHub → Settings)

1. **Branch ruleset for `main`:**
    - require a PR;
    - require the checks *Plugin and Mac tests* and *Build on pinned EmDash*;
    - block force pushes and deletions;
    - require signed commits.
2. **Code security:** turn on secret scanning with push protection, private vulnerability reporting, and Dependabot alerts.
3. **Actions:**
    - set *Workflow permissions* to read-only by default;
    - do not let Actions create or approve pull requests;
    - require approval for fork PR workflows from all outside contributors.
4. **Discussions:** off.

## Next phases

The plan doc has the detail.

- **Phase 2:** deploys with an approval in Powerfarm:
    - `release.yml` builds and drafts the release;
    - `deploy.yml` authorises, migrates, deploys a version, checks the edge, and rolls back on failure;
    - GitHub OIDC on Powerfarm's release routes;
    - the one-time bootstrap script.
- **Phase 3:** content model and Access as code.
- **Phase 4:** push certificate signing; the Mac bridge as a signed package.
- **Phase 5:** the iPhone Identity App, in `ios/`.
