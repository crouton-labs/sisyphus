---
description: Configure sisyphus to upload completed sessions to a Cloudflare Worker
argument-hint: <url-with-embedded-token>
---

Run this exactly:

```bash
sis admin report configure-upload "$0"
```

This registers the Worker URL + bearer token in `~/.sisyphus/config.json` (mode 0600). Completed sisyphus sessions will then auto-upload (zip + manifest) to the operator's R2 bucket. The token is stripped from the URL and stored separately. To disable later, remove the `upload` block from the global config.
