# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately, by email to **rhyneer.silas@gmail.com**. Do not open a public GitHub issue or pull request for a suspected vulnerability.

Include what you found, the version (`sis --version`) and platform, and the steps or a proof of concept that reproduce it. If the report involves a token or credential, redact it.

Reports are read by a single maintainer, and no response time is guaranteed. Fix timelines depend on severity and on what the fix involves. Say in your report if you want credit in the fix.

## Supported versions

Fixes land on `main` and ship in the next published release of the [`sisyphi`](https://www.npmjs.com/package/sisyphi) package. Only the latest published version is supported.

## What is in scope

The code in this repository: the `sis` CLI, the `sisyphusd` daemon and its Unix socket, the dashboard, and the session upload Worker in [`workers/upload-proxy/`](workers/upload-proxy). Of particular interest:

- Access to the daemon socket by another user.
- Upload tokens or other credentials leaking through logs, process arguments or uploaded session archives.
- A project-local config redirecting session uploads, which only the global config is meant to control.
- The upload Worker accepting a request without a valid token, or letting one user read or write another user's uploads.

sisyphus runs Claude Code agents in tmux panes with your user's permissions, and by default starts them with permission prompts skipped. That is what it is for, not a vulnerability. An agent or a model doing something harmful with that access is outside this policy.
