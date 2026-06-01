---
description: Configure sisyphus to upload completed sessions to a Cloudflare Worker
argument-hint: "<url-with-embedded-token>"
---

The user wants to configure sisyphus session upload. Run this exactly, substituting the URL-with-embedded-token they provided:

```bash
sis admin report configure-upload "$1"
```

If no URL was provided as an argument, ask the user for the upload URL (with embedded token) before running.

This registers the Worker URL + bearer token in `~/.sisyphus/config.json` (mode 0600). Completed sisyphus sessions will then auto-upload (zip + manifest) to the operator's R2 bucket. The token is stripped from the URL and stored separately. To disable later, remove the `upload` block from the global config.
