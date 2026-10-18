# Versioning the libraries

Add a Changeset with `pnpm changeset` when a package's API or behavior changes.
The 17 libraries form one fixed version group. Prepare a release with
`pnpm version:packages`, then review the manifests, changelogs and lockfile together.
The manual GitHub release workflow refuses unconsumed Changesets.

See [the release runbook](../docs/RELEASING.md) for bootstrap, trusted publishing and
the owner's npm approvals.
