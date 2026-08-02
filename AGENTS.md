# AGENTS.md

routedjs — file-system routing for APIs. Drop a file, get an endpoint. Runs on
Bun; adapters for Hono, Express, Koa, and Elysia; generates route manifests,
typed clients, and OpenAPI.

## Commands

- `bun install` — install dependencies
- `bun test src` — run the test suite
- `bun run typecheck` — `tsc --noEmit`
- `bun run build` — bundle with tsup
- `bun run examples:generate` — regenerate example manifests (run after any codegen change and commit the result)

## Releases are fully automated — commit messages control them

Every push to `main` runs semantic-release (`.github/workflows/publish.yml`,
config in `.releaserc.json`). It analyzes conventional commits since the last
tag, then bumps the version, writes `CHANGELOG.md`, commits both back, tags,
creates the GitHub Release, and publishes to npm via OIDC trusted publishing.

Rules that follow from this:

- **Write conventional commit messages.** `fix:` → patch, `feat:` → minor,
  `feat!:` or a `BREAKING CHANGE:` footer → major. `chore:`, `ci:`, `docs:`,
  `refactor:`, `test:` → no release. A commit that changes runtime or codegen
  behavior MUST be typed `fix:` or `feat:` — otherwise it silently ships in
  some later unrelated release.
- **Never bump `version` in `package.json` manually.** The release bot owns it.
- **Never create `v*` tags or GitHub releases manually.**
- **Never edit `CHANGELOG.md` by hand.** It is generated.
- Merging/pushing to `main` IS releasing. Don't push a `fix:`/`feat:` commit
  to `main` unless it should publish to npm.
- The release bot pushes a `chore(release): x.y.z [skip ci]` commit to `main`
  after each release — `git pull` before continuing local work.

## Codegen determinism is load-bearing

Generated output (`routed.gen.ts` manifests, typed clients, OpenAPI) must be
**byte-identical across machines, file systems, and locales** for the same
route files. Downstream consumers diff generated clients; any nondeterminism
shows up as spurious churn.

- Never let output order depend on file-system scan order (`Bun.Glob.scan`
  order is readdir order and varies by machine). Always sort scanned results
  with a total order before generating.
- Never use `localeCompare` for ordering that reaches generated output — ICU
  collation varies by environment. Use `compareCodePoints` from
  `src/core/path.ts`.
- `compareRoutePathSpecificity` must remain a total order: it returns 0 only
  for identical paths. Keep that property if you touch it.
- After changing anything under `src/codegen`, `src/client`, `src/openapi`, or
  the framework codegen in `src/frameworks`, run `bun run examples:generate`
  and commit the regenerated examples.
