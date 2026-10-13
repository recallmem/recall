## What changed and why

<!-- One purpose per pull request. What does it do for users or for the code, and why now? -->

## How it was checked

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] Python SDK tests pass, if `sdks/python` changed (`python3 -m pytest sdks/python/tests -q`)
- [ ] New behaviour has a test
- [ ] Site or dashboard changes: looked at on desktop and phone (screenshots below)

## Licence and sign-off

- [ ] Every commit is signed off (`git commit -s`), certifying the
      [Developer Certificate of Origin](https://developercertificate.org). Changes to
      `packages/server/` are contributed under the FSL, everything else under MIT
      (see [CONTRIBUTING.md](../CONTRIBUTING.md#licensing-of-contributions)).

## Notes for the reviewer

<!-- Migrations, new environment variables, anything a deploy needs. -->
