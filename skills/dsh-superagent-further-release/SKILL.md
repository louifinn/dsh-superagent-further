---
name: dsh-superagent-further-release
description: Prepare and verify a dsh-superagent-further release: checks, counts, changelog, tag, workflow and asset.
---

A release is a small, ordered checklist. Run every step on the checkout that will be tagged; do not release from a
worktree or with uncommitted changes.

1. `pnpm check` from the repository root. It type-checks, runs every spec file and builds `lib/`; a release never ships
   a red suite. Record the exact `passed / skipped (total)` counts.
2. Update the counts and schema version wherever the docs state them: `README.md`, `README.zh-CN.md`,
   `docs/009-roadmap.md` and the migration chain in `docs/006-deployment.md` and `docs/007-architecture.md`. Diff the
   fork comparison in the READMEs against `git diff --shortstat 8c32a9d HEAD` if the prototype column changed.
3. Move the `## [Unreleased]` section of `CHANGELOG.md` under the new version with its date; keep one bullet per
   operator-visible change, in the repository's existing wording.
4. Bump `package.json` `version` (the `v<version>` tag must match), commit "Release <version>", and tag it.
5. Push the branch and the tag. Watch the `release` workflow: it runs the six combinations and packs
   `dsh-superagent-further-<version>.tgz`; a red check cancels the release.
6. Verify the GitHub Release: tag, not draft, not prerelease, and the asset with its size. Only then announce it.
7. For a running DSH host, rebuild `lib/`, reload the plugin from the Plugin Manager (disable then enable its loader
   entry) — no DSH restart is needed — and re-read the panel's Logs tab and the management API to confirm the version
   and schema.

If a step fails, fix forward with a new commit and a retagged version; never force-move a published tag.
