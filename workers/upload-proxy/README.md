# sisyphus-upload-proxy — operator runbook

Cloudflare Worker that accepts session uploads from sisyphus clients and writes
them to R2. Tokens are per-user; managed via `pnpm admin` from this directory.

Deployed at: `https://sisyphus-upload-proxy.rhyneer-silas.workers.dev`

## One-time setup

```bash
pnpm install
wrangler login
# wrangler kv namespace create TOKENS  ← skip; id already in wrangler.toml
wrangler deploy
```

## Mint a token

```bash
pnpm admin mint <userId>
# optional: pnpm admin mint <userId> --notes "Alice's laptop"
```

The plaintext token is printed **once**. Share it with the user:

```bash
sis admin configure-upload \
  "https://sisyphus-upload-proxy.rhyneer-silas.workers.dev/upload?token=<plaintext>"
```

## List / inspect tokens

```bash
pnpm admin list            # table: userId, createdAt, lastSeen, uploads, revoked
pnpm admin show <userId>   # full TokenRecord JSON
```

## Revoke / delete tokens

```bash
pnpm admin revoke <userId>   # soft-disable (revoked: true); record retained for audit
pnpm admin delete <userId>   # hard-delete KV key; cannot be undone
```

## Tail logs

```bash
pnpm tail
# or: wrangler tail
```

JSON-logged events: `upload`, `auth_fail`, `r2_write_fail`.

## Pull sessions (operator only)

Requires `SISYPHUS_R2_SECRET_KEY` in your shell (already in `~/.zshrc`).

```bash
# List a user's sessions
AWS_ACCESS_KEY_ID=2de04f094c404fa7be40eadb56a4ea4b \
AWS_SECRET_ACCESS_KEY=$SISYPHUS_R2_SECRET_KEY \
  aws s3 ls \
  s3://sisyphus-sessions-captaincrouton89/users/<userId>/ \
  --endpoint-url https://8c13ab7fc53dc5dfb06c42c05a0e58eb.r2.cloudflarestorage.com

# Download a session
AWS_ACCESS_KEY_ID=2de04f094c404fa7be40eadb56a4ea4b \
AWS_SECRET_ACCESS_KEY=$SISYPHUS_R2_SECRET_KEY \
  aws s3 cp \
  s3://sisyphus-sessions-captaincrouton89/users/<userId>/<sessionId>.zip . \
  --endpoint-url https://8c13ab7fc53dc5dfb06c42c05a0e58eb.r2.cloudflarestorage.com
```

## Bucket layout

```
users/{userId}/{sessionId}.zip
users/{userId}/{sessionId}.json
```
