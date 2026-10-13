# Security policy

## Reporting a vulnerability

Please **do not open a GitHub issue** for a security problem. Email
**security@recallmem.dev** (put "Security" in the subject) and include:

- what you found and where: the host, endpoint or page, or the plugin, SDK or server version;
- the steps to reproduce it, and a proof of concept if you have one;
- the impact you think it has;
- how we can reach you, and whether you would like to be credited.

Do not include other people's personal data beyond what is needed to show the problem.

## What happens next

- We confirm that we received your report within five working days, investigate it, and keep you
  informed of our progress.
- Please keep the details confidential until the problem is fixed. We aim to fix serious problems
  within 90 days and agree with you when details can be published.
- If you want, we credit you once the problem is fixed. We do not currently pay rewards (no bug
  bounty).

## Scope

In scope: the code in this repository (the server, the SDKs, the integrations and the eval
harness) and the hosted service at recallmem.dev, app.recallmem.dev and api.recallmem.dev.

Testing against the hosted service is covered by the safe-harbour terms and rules on
**[recallmem.dev/security](https://recallmem.dev/security)**: test only against accounts you own
or may test, do not access or keep other people's data, and do not disrupt the service (no denial
of service, load testing or spam). That page also lists what is out of scope and how we protect
data. Machine-readable contact details are in
[security.txt](https://recallmem.dev/.well-known/security.txt).

## Supported versions

Security fixes go into the latest version on `main` and the latest published SDK releases
(`@recall-memory/sdk` on npm, `recall-mem` on PyPI). If you self-host the server, run a recent
commit of `main`.
