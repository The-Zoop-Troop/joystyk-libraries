# Releasing the library group

The source repository is The-Zoop-Troop/joystyk-libraries. All 17 libraries form a fixed Changesets group;
applications and games are outside it. API or behavior changes include a Changeset. Review
the coupled version, changelogs, dependency ranges and frozen lockfile together.

Run `pnpm check` before committing. It includes strict tarball checks and isolated consumers.
The manually triggered npm release workflow checks main on a hosted runner, then enters the
protected npm environment. It uses OIDC and stages the exact verified tarball archive; it
does not automatically approve or publish stages.

Before enabling staging, the owner must create the repository, protect main and the npm
environment, configure each of the 17 trusted publishers for npm-release.yml and environment
npm with staging-only permissions, and verify npm account ownership and 2FA. Set repository
variables NPM_RELEASE_REPOSITORY to The-Zoop-Troop/joystyk-libraries and NPM_PUBLISHERS_READY to true only after
that verification. Never infer these settings from a passing source check.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) uses hosted runners.
[Provenance](https://docs.npmjs.com/generating-provenance-statements/) requires public source.
Review and approve each [stage](https://docs.npmjs.com/staged-publishing/) on npm separately.
Bootstrap or staging is an external action requiring owner instruction.

Create trusted-publisher configurations close to an approved release: npm expires new
configurations if their first successful publish does not occur within two days. Verify
current records and npm's first-use requirements before setting publisher readiness.

The workflow retains verified tarballs and partial receipts. After owner approval, use
`pnpm release:stage --verify-live --artifact-dir /path/to/verified/archive` for read-only live
integrity and dist-tag checks. Do not repack between consumer validation and staging.
