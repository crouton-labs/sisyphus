# Contributing to sisyphus

Issues and pull requests are welcome at [github.com/crouton-labs/sisyphus](https://github.com/crouton-labs/sisyphus).

## Before you start

- **Bugs:** open an issue with the sisyphus version (`sis --version`), your OS, your tmux version, and the command that failed with its output.
- **Features and larger changes:** open an issue first, so the direction is agreed before you write the code.
- **Questions:** ask in [Discord](https://discord.gg/afwW4saEtr) or open an issue.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 22 or later (`engines` in `package.json` and CI both say 22), [pnpm](https://pnpm.io) (CI uses pnpm 10), and tmux 3.2 or later to run sisyphus itself.

```bash
git clone git@github.com:crouton-labs/sisyphus.git
cd sisyphus
pnpm install --frozen-lockfile
pnpm build
```

`pnpm dev` rebuilds on change, and `pnpm dev:daemon` also restarts the daemon after each build.

## Run the tests

```bash
pnpm test
```

This runs the unit tests in `src/__tests__/` with the Node test runner. Tests that create asks should set `SISYPHUS_DISABLE_NOTIFY=1`, or they fire real OS notifications; see [`src/__tests__/CLAUDE.md`](src/__tests__/CLAUDE.md).

The integration harness packs the package and runs it inside Docker containers, so it needs a running Docker daemon:

```bash
bash test/integration/run.sh
```

CI runs it on Linux, and also installs the packed tarball on macOS and runs `sisyphus doctor`.

## Pull requests

- Branch from the current `main`, and keep one change per pull request.
- Describe what changed and why in the pull request body, and say how you tested it.
- Add or update a test in `src/__tests__/` for behavior you change.
- Do not bump the version. The publish workflow runs `npm version patch` on every merge to `main`.
- Keep the history linear: rebase onto `main` rather than merging it into your branch.
- Commit messages follow the style of the existing log: a short imperative subject with a prefix such as `fix(ask):`, `feat(status-bar):` or `docs:`.

## Repository layout

| Path | Contents |
|---|---|
| [`src/`](src) | The `sis` CLI (`cli/`), the `sisyphusd` daemon (`daemon/`), the dashboard (`tui/`), and shared code (`shared/`) |
| [`templates/`](templates) | Prompts and files that sisyphus installs for orchestrators and agents |
| [`plugins/`](plugins), [`crtr-plugins/`](crtr-plugins), [`pi-plugins/`](pi-plugins) | Claude Code, crouter and pi plugins |
| [`native/`](native) | The Swift notification app for macOS |
| [`workers/upload-proxy/`](workers/upload-proxy) | The Cloudflare Worker that receives session uploads |
| [`deploy/`](deploy) | Terraform for remote hosts |
| [`test/integration/`](test/integration) | The Docker integration harness |

## License

sisyphus is licensed under MIT. By contributing, you agree that your contribution is licensed under the same terms.
