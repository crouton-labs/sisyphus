---
kind: knowledge
when-and-why-to-read: When you are issuing an orchestrator yield in sisyphus, this reference should be read because it captures the gotcha that sis orch yield --mode is required on every yield — there is no implicit keep-current-mode fallback.
short-form: The --mode flag is mandatory on every sis orch yield; no implicit keep-current fallback.
system-prompt-visibility: none
file-read-visibility: none
---
- `sis orch yield --mode <mode>` is required on every yield. Pass the current mode to stay in it; pass a different mode to transition. There is no implicit "keep current mode" fallback — the CLI rejects yields without `--mode`.
