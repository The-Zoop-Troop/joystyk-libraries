# Releasing Joystyk libraries

All 17 `@joystyk/*` libraries share one version and release from
[joystyk-games/game-libraries](https://github.com/joystyk-games/game-libraries).
This follows Gyral's release process: reserve package names once, configure npm trusted
publishing, run a manual GitHub workflow, then approve the staged versions on npm with 2FA.
GitHub uses OIDC; it needs no npm token.

## One-time setup

### 1. Sign in and check organization access

Enable 2FA on your npm account and confirm it can create packages in the `joystyk`
organization. Public organization packages do not require a paid npm plan.
Run these from this checkout:

```sh
pnpm exec npm login --registry=https://registry.npmjs.org
pnpm exec npm whoami --registry=https://registry.npmjs.org
pnpm exec npm org ls joystyk --json
```

### 2. Reserve package names

npm requires an existing package before you can configure its trusted publisher.
As in Gyral, the bootstrap command publishes a `0.0.0` placeholder with a README,
MIT license and notices. It contains no library implementation. Real releases use `0.1.0`
or later. Placeholders are public packages, so review the preview before publishing them.

```sh
pnpm release:bootstrap             # reads npm and previews all missing placeholders
pnpm release:bootstrap --publish   # owner action: publishes placeholders, npm requests 2FA
```

The preview cannot publish. Existing names are skipped, and a failed bootstrap can be
rerun. A skipped name does not prove that your account controls it; confirm package write
access before configuring its publisher. Registry errors other than 404 stop the lookup.

### 3. Configure trusted publishing for every package

For each package below, open npm → package → Settings → Trusted publishing → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `joystyk-games` |
| Repository | `game-libraries` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | Stage only; leave direct publish and dist-tag permissions unchecked |

The packages, in dependency order, are:

```text
@joystyk/contracts  @joystyk/kit      @joystyk/storage  @joystyk/identity
@joystyk/ops        @joystyk/rooms    @joystyk/session  @joystyk/daily
@joystyk/testing    @joystyk/ui       @joystyk/cards-ui @joystyk/arcade
@joystyk/render3d   @joystyk/launcher @joystyk/catalog  @joystyk/pwa
@joystyk/content
```

On each package's Publishing access page, select **Require two-factor authentication and
disallow tokens**. Trusted publishing continues to use OIDC. Existing publisher connections
for the old repository must be reviewed and replaced with this exact identity.

Create publishers when you are ready to release: npm expires a new configuration if its
first successful publish does not happen within two days. Saving settings does not verify
them. Inspect each record before enabling the workflow.

### 4. Configure GitHub

Protect `main` with the `check` status and a pull request review. Protect the `npm`
environment with `mikezupper` as a required reviewer and allow only the `main` branch.
These controls and public repository visibility were set before the transfer; recheck
them after changes to the repository's organization or policy.

In Settings → Secrets and variables → Actions → Variables:

| Variable | Value |
| --- | --- |
| `NPM_RELEASE_REPOSITORY` | `joystyk-games/game-libraries` |
| `NPM_PUBLISHERS_READY` | `true` only after all 17 publishers are verified |

The repository identity, package metadata and workflow must agree. Keep publisher readiness
`false` throughout setup. No npm token secret is needed.

## Cut a release

1. Add a Changeset for package API or behavior changes with `pnpm changeset`. Prepare the
   shared version and changelogs with `pnpm version:packages`; review the dependency ranges
   and frozen lockfile in the same pull request. The workflow refuses pending Changesets.
2. Run `pnpm check`, commit the reviewed source and merge to `main`.
3. GitHub → Actions → **release** → Run workflow on `main`. Approve the `npm` environment
   deployment when requested. The hosted workflow checks the source and validates all 17
   tarballs in isolated consumers before staging those exact bytes with OIDC and provenance.
4. npm → `joystyk` organization → Packages → Staged Packages. Review and approve each
   staged version with 2FA, following the dependency order above. All 17 approvals are
   required for the full library group to become installable.
5. Download the workflow's `joystyk-npm-<commit>` artifact and check out the same commit.
   Verify the published versions, exact tarball integrities and `latest` tags:

   ```sh
   pnpm release:stage --verify-live --artifact-dir /path/to/downloaded/archive
   ```

The workflow retains validated tarballs and partial staging receipts for 30 days. If a
later package fails, inspect the receipt and existing npm stages before retrying. A live
version is skipped only when its bytes match. Keep the archive; repacking creates a new
candidate rather than the bytes already validated and staged.

The local bootstrap, workflow staging and npm approval each write to npm. Run them only
when the owner has instructed that step. Preparing source or passing checks does not
authorize a publication.

## npm references

- [Organization packages](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/)
- [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Trust CLI prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [Staged publishing](https://docs.npmjs.com/staged-publishing/)
- [Provenance](https://docs.npmjs.com/generating-provenance-statements/)
