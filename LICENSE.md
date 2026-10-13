# Licensing

Recall is made by Smidt Beheer (KvK 99124254, the Netherlands). This repository holds two kinds of
code under two licences: the server is source-available, and everything you build on is open
source.

| Directory | Licence | Licence file |
|---|---|---|
| `packages/server/` (the Recall server) | Functional Source License 1.1, Apache 2.0 future licence (`FSL-1.1-ALv2`) | [`packages/server/LICENSE.md`](packages/server/LICENSE.md) |
| `packages/sdk/` (TypeScript SDK) | MIT | [`packages/sdk/LICENSE`](packages/sdk/LICENSE) |
| `sdks/` (Python SDK) | MIT | [`sdks/python/LICENSE`](sdks/python/LICENSE) |
| `integrations/` (Claude Code and Codex plugins, MCP setup, OpenClaw, Hermes, Agent Skill) | MIT | [`integrations/LICENSE`](integrations/LICENSE) |
| `examples/` | MIT | [`examples/LICENSE`](examples/LICENSE) |
| `evals/` (the benchmark harness) | MIT | [`evals/LICENSE`](evals/LICENSE) |

Everything else in the repository (the root configuration, `Dockerfile`, `docker-compose.yml`,
`docs/`, `scripts/` and `.github/`) is MIT as well, under the same notice as `examples/LICENSE`.
Files that carry their own licence keep it: the fonts in `packages/server/public/fonts/` come with
their own licence files, and `evals/src/beam/reference.ts` keeps the MIT notice of the BEAM code it
ports.

## The server: Functional Source License

You may use, copy, modify and redistribute the server for any purpose except a **Competing Use**.
That includes running it in production for your own product or company, self-hosting it for your
team or your customers' agents, changing it, and using it for research and teaching.

**Competing Use, in one paragraph.** You may not make the server available to others as a
commercial product or service that substitutes for Recall, that substitutes for another Recall
product or service built on it, or that offers the same or substantially similar functionality. In
practice: do not sell hosted Recall, or a memory API built from this code, to third parties. Using
Recall inside your own product, where memory is one part of what your customers buy, is a permitted
use. The exact wording is in [`packages/server/LICENSE.md`](packages/server/LICENSE.md), and it is
what counts.

**Every version becomes Apache 2.0 after two years.** Each version of the server is also licensed
under the Apache License 2.0 from the second anniversary of the day it was made available (pushed
to this repository or published). After that date the Competing Use restriction no longer applies
to that version.

The FSL is a [Fair Source](https://fair.io) licence, written by Sentry; [fsl.software](https://fsl.software)
explains it in more detail.

## SDKs, integrations, examples and evals: MIT

Use them for anything, including in closed-source and commercial software, as long as you keep the
copyright notice and the licence text. Copyright (c) 2026 Smidt Beheer.

## Names and logos

Neither licence grants rights to the Recall name, the elephant logo or the other artwork of
recallmem.dev beyond saying where the software comes from.

## Contributions

Contributions are licensed under the licence of the directory they change: FSL for
`packages/server/`, MIT for everything else. See [CONTRIBUTING.md](CONTRIBUTING.md).

Questions about licensing: support@recallmem.dev.
