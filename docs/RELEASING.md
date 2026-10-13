# Releasing the client SDKs

Eight packages are published from this repository by `.github/workflows/release-sdks.yml`:

| Package | Registry | Name | Source | Tag |
|---|---|---|---|---|
| TypeScript SDK | npm | `@recall-memory/sdk` | `packages/sdk` | `sdk-ts-vX.Y.Z` |
| Python SDK | PyPI | `recall-mem` (import `recall_memory`) | `sdks/python` | `sdk-py-vX.Y.Z` |
| Vercel AI SDK integration | npm | `@recall-memory/ai-sdk` | `packages/ai-sdk` | `ai-sdk-vX.Y.Z` |
| LangChain.js integration | npm | `@recall-memory/langchain` | `packages/langchain` | `langchain-vX.Y.Z` |
| Mastra integration | npm | `@recall-memory/mastra` | `packages/mastra` | `mastra-vX.Y.Z` |
| LangChain / LangGraph integration | PyPI | `langchain-recall` (import `langchain_recall`) | `sdks/python-integrations/langchain-recall` | `langchain-recall-vX.Y.Z` |
| OpenAI Agents SDK integration | PyPI | `openai-agents-recall` (import `openai_agents_recall`) | `sdks/python-integrations/openai-agents-recall` | `openai-agents-recall-vX.Y.Z` |
| CrewAI integration | PyPI | `crewai-recall` (import `crewai_recall`) | `sdks/python-integrations/crewai-recall` | `crewai-recall-vX.Y.Z` |

The three Python integrations depend on `recall-mem` (`>=0.1.1,<0.2`), so release a new
`recall-mem` first when an integration needs something it adds.

Pushing a tag is the whole release. The workflow tests the package, checks that the tag matches the
version in `package.json` / `pyproject.toml`, builds, and publishes. Nothing is published from a
branch or by hand.

The three framework integrations depend on the TypeScript SDK. In the repository that dependency is
`"@recall-memory/sdk": "workspace:^"`; the release job packs the integration with `pnpm pack`, which
writes the SDK's current version range (for example `^0.1.0`) into the published `package.json`,
and checks that no `workspace:` range is left. So **release the SDK first** when an integration
needs SDK changes that are not on npm yet. The frameworks themselves (`ai`, `@langchain/core`,
`@mastra/core`) and `zod` are peer dependencies: the app brings its own.

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
3. Add a pending publisher for each framework integration, with owner, repository and workflow as
   in the table above:

   | PyPI project name | Environment name |
   |---|---|
   | `langchain-recall` | `pypi` |
   | `openai-agents-recall` | `pypi-openai-agents-recall` |
   | `crewai-recall` | `pypi-crewai-recall` |

   PyPI refuses two pending publishers with the same repository, workflow and environment, so each
   new project gets its own environment (the release job picks it). They are new projects, so the
   pending publisher creates each one on its first release. Check first that the names are still
   free on PyPI.

## Releasing

Do the same for every package; only the file and the tag prefix differ.

1. Make sure CI is green on `main`. The release job runs the package's tests again (for the SDK
   only its unit tests; its end-to-end tests run in CI).
2. **Bump the version** (it must be a new version; a published version can never be replaced):
   * TypeScript SDK: `version` in `packages/sdk/package.json` **and** `VERSION` in
     `packages/sdk/src/version.ts` (a test fails if they differ).
   * Python SDK: `version` in `sdks/python/pyproject.toml` **and** `__version__` in
     `sdks/python/src/recall_memory/_version.py` (a test fails if they differ).
   * TypeScript integrations: `version` in `packages/ai-sdk/package.json`,
     `packages/langchain/package.json` or `packages/mastra/package.json`.
   * Python integrations: `version` in `sdks/python-integrations/<name>/pyproject.toml`
     **and** `__version__` in its `src/<module>/_version.py` (its `test_package.py` fails if they
     differ).
3. Commit and merge to `main`.
4. **Tag that commit and push the tag**:

   ```bash
   git checkout main && git pull
   git tag sdk-ts-v0.1.1 && git push origin sdk-ts-v0.1.1         # TypeScript SDK -> npm
   git tag sdk-py-v0.1.1 && git push origin sdk-py-v0.1.1         # Python SDK -> PyPI
   git tag ai-sdk-v0.1.0 && git push origin ai-sdk-v0.1.0         # @recall-memory/ai-sdk -> npm
   git tag langchain-v0.1.0 && git push origin langchain-v0.1.0   # @recall-memory/langchain -> npm
   git tag mastra-v0.1.0 && git push origin mastra-v0.1.0         # @recall-memory/mastra -> npm
   git tag langchain-recall-v0.1.0 && git push origin langchain-recall-v0.1.0          # -> PyPI
   git tag openai-agents-recall-v0.1.0 && git push origin openai-agents-recall-v0.1.0  # -> PyPI
   git tag crewai-recall-v0.1.0 && git push origin crewai-recall-v0.1.0                # -> PyPI
   ```

   The number after `v` must equal the version in the file you bumped, or the workflow fails before
   publishing. Every package is versioned and released independently; an integration needs the SDK
   version it depends on to be published already.

   Can't push tags from where you work? Run **Actions > Tag a release > Run workflow** on `main`
   with the tags (e.g. `ai-sdk-v0.1.0 mastra-v0.1.0`). It creates them on that commit and starts
   the release for each, the same as pushing them.
5. Watch **Actions > Release SDKs**. For PyPI, approve the `pypi` environment if you made yourself a
   reviewer.
6. Check the result: <https://www.npmjs.com/package/@recall-memory/sdk> (or `ai-sdk`, `langchain`,
   `mastra`) and <https://pypi.org/project/recall-mem/>, then try it in a clean directory:
   `npm install @recall-memory/sdk` / `pip install recall-mem`.

The first release of each integration creates its package inside the `recall-memory` npm
organisation with the same `NPM_TOKEN`; nothing else needs setting up.

### Dry run

**Actions > Release SDKs > Run workflow**, pick `npm`, `pypi` or one of the integrations (`ai-sdk`,
`langchain`, `mastra`, `langchain-recall`, `openai-agents-recall`, `crewai-recall`), leave
**publish** off. It installs, tests, builds and prints what would be published (`npm pack --dry-run`,
the packed tarball's files and dependencies, `twine check`), and publishes nothing. Run it on a
release tag with **publish** ticked only to retry a release whose publish step failed; it will refuse
to publish from a branch.

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

Every package is checked by tests (`packages/*/test/publish.test.ts`,
`sdks/python/tests/test_publish.py`, `sdks/python-integrations/*/tests/test_package.py`) so it
never names another product.

* npm: `dist/` (compiled JavaScript, `.d.ts` types, source maps), `README.md`, `LICENSE` (MIT) and
  `package.json`. Check locally with `cd packages/sdk && pnpm build && npm pack --dry-run`; for an
  integration, `pnpm --filter @recall-memory/ai-sdk... build && cd packages/ai-sdk && pnpm pack` and
  look inside the tarball (its `package.json` must name an SDK version range, not `workspace:`).
* PyPI: the wheel holds `recall_memory/` (including `py.typed`) and the MIT `LICENSE`; the
  source distribution adds `README.md` and `pyproject.toml` and leaves out the tests. Check locally
  with `python -m build sdks/python` and list the archives.
* PyPI, framework integrations: the same layout, with `langchain_recall/`, `openai_agents_recall/`
  or `crewai_recall/`. Check locally with `python -m build sdks/python-integrations/<name>`. Their
  end-to-end tests (`sdks/python-integrations/<name>/tests`, run in CI on every push) start the
  real server and drive each framework with a scripted model; the release job runs only the tests
  that need no server.
