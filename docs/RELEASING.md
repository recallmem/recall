# Releasing the client SDKs

Two packages are published from this repository by `.github/workflows/release-sdks.yml`:

| SDK | Registry | Package | Source | Tag |
|---|---|---|---|---|
| TypeScript | npm | `@recall-memory/sdk` | `packages/sdk` | `sdk-ts-vX.Y.Z` |
| Python | PyPI | `recall-mem` (import `recall_memory`) | `sdks/python` | `sdk-py-vX.Y.Z` |

Pushing a tag is the whole release. The workflow tests the SDK, checks that the tag matches the
version in `package.json` / `pyproject.toml`, builds, and publishes. Nothing is published from a
branch or by hand.

## One-time setup (the owner does this once)

These steps need your own npm, PyPI and GitHub accounts; they cannot be done from the repository.

### 1. GitHub repository

1. **Provenance comes with a public repository.** npm provenance (the signed "built from this
   commit on GitHub Actions" badge) and PyPI attestations only work for public repositories. The
   workflow adds them automatically when the repository (`recallmem/recall`) is public and
   publishes without them while it is private, so releasing works either way.
2. Create the GitHub environment **`pypi`**: repository **Settings > Environments > New
   environment**, name `pypi`. Optionally add yourself as a required reviewer so every PyPI release
   waits for your approval.

### 2. npm

1. Sign in at <https://www.npmjs.com> (create an account if you have none, and enable 2FA).
2. Create the organisation **`recall-memory`**: avatar menu > **Add Organization**, name
   `recall-memory`, the free (public packages) plan. The package name `@recall-memory/sdk` lives in
   this scope.
3. Create an **automation token** (it bypasses 2FA, which CI needs): avatar menu > **Access
   Tokens** > **Generate New Token** > **Granular Access Token** (or classic "Automation"). Give it
   read and write access to the `@recall-memory` scope, with a sensible expiry.
4. Save it as the repository secret **`NPM_TOKEN`**: repository **Settings > Secrets and variables >
   Actions > New repository secret**, name `NPM_TOKEN`.

The first `npm publish --access public` creates the package inside the organisation; later releases
reuse it.

### 3. PyPI

1. Sign in at <https://pypi.org> (create an account if you have none, and enable 2FA).
2. Add a **pending trusted publisher** (this lets the first release create the project without any
   API token): <https://pypi.org/manage/account/publishing/> > **Add a new pending publisher**:

   | Field | Value |
   |---|---|
   | PyPI project name | `recall-mem` |
   | Owner | `recallmem` |
   | Repository name | `recall` |
   | Workflow name | `release-sdks.yml` |
   | Environment name | `pypi` |

   No PyPI token is ever stored in GitHub. After the first release the pending publisher becomes a
   normal trusted publisher of the project. `recall-mem` already exists on PyPI, so add the table's
   publisher under the project's **Settings > Publishing** rather than as a pending publisher.

## Releasing

Do the same for either SDK; only the file and the tag prefix differ.

1. Make sure CI is green on `main`. The release job runs the SDK's unit tests again, but the
   end-to-end tests only run in CI.
2. **Bump the version** (it must be a new version; a published version can never be replaced):
   * TypeScript: `version` in `packages/sdk/package.json` **and** `VERSION` in
     `packages/sdk/src/version.ts` (a test fails if they differ).
   * Python: `version` in `sdks/python/pyproject.toml` **and** `__version__` in
     `sdks/python/src/recall_memory/_version.py` (a test fails if they differ).
3. Commit and merge to `main`.
4. **Tag that commit and push the tag**:

   ```bash
   git checkout main && git pull
   git tag sdk-ts-v0.1.1 && git push origin sdk-ts-v0.1.1   # TypeScript SDK -> npm
   git tag sdk-py-v0.1.1 && git push origin sdk-py-v0.1.1   # Python SDK -> PyPI
   ```

   The number after `v` must equal the version in the file you bumped, or the workflow fails before
   publishing. The two SDKs are versioned and released independently.
5. Watch **Actions > Release SDKs**. For PyPI, approve the `pypi` environment if you made yourself a
   reviewer.
6. Check the result: <https://www.npmjs.com/package/@recall-memory/sdk> and
   <https://pypi.org/project/recall-mem/>, then try it in a clean directory:
   `npm install @recall-memory/sdk` / `pip install recall-mem`.

### Dry run

**Actions > Release SDKs > Run workflow**, pick `npm` or `pypi`, leave **publish** off. It installs,
tests, builds and prints what would be published (`npm pack --dry-run`, `twine check`), and publishes
nothing. Run it on a release tag with **publish** ticked only to retry a release whose publish step
failed; it will refuse to publish from a branch.

### If something goes wrong

* **The version check failed**: the tag does not match the file. Delete the tag
  (`git push origin :refs/tags/sdk-ts-v0.1.1`, `git tag -d sdk-ts-v0.1.1`), fix the version, tag
  again.
* **npm says the version already exists / PyPI says the file already exists**: that version is
  taken for good. Bump to the next version and tag again.
* **npm `E404` or `E403` on publish**: the `recall-memory` organisation does not exist yet, or
  `NPM_TOKEN` lacks write access to the `@recall-memory` scope.
* **PyPI `invalid-publisher`**: the pending publisher's owner, repository, workflow file name or
  environment name differs from the table above (they must match exactly).

## What gets published

Both packages are checked by tests (`packages/sdk/test/publish.test.ts`,
`sdks/python/tests/test_publish.py`) so they never name another product.

* npm: `dist/` (compiled JavaScript, `.d.ts` types, source maps), `README.md`, `LICENSE` (MIT) and
  `package.json`. Check locally with `cd packages/sdk && pnpm build && npm pack --dry-run`.
* PyPI: the wheel holds `recall_memory/` (including `py.typed`) and the MIT `LICENSE`; the
  source distribution adds `README.md` and `pyproject.toml` and leaves out the tests. Check locally
  with `python -m build sdks/python` and list the archives.
