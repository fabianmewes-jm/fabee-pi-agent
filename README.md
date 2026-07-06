# `@fabianmewes-jm/fabee-pi-agent`

`@fabianmewes-jm/fabee-pi-agent` is the forked npm package for the
`bee-pi-agent` Bee Dance speaking worker runtime. It executes coding-agent
turns over a local Unix socket.

It is intended to sit behind `@jobmatchme/bee-worker-sidecar`: the agent speaks
Bee Dance envelopes locally, while the sidecar handles NATS-facing transport and
subject routing.

## What this package does

- listens on a Unix socket for framed Bee Dance envelopes
- responds to `protocol.hello` with `protocol.welcome`
- accepts `turn.start` and `turn.cancel` commands
- executes turns with the familiar `pi-*` coding-agent tool stack
- emits Bee Dance event envelopes such as `run.started`, `item.appended`,
  `item.updated`, `run.completed`, and `run.failed`

## What this package does not do

- no direct NATS connection
- no Slack transport or gateway responsibilities
- no generic Slack ingress/response handling; individual tools may still return Slack-ready Markdown

## Design intent

The package is the local execution half of a two-container pod shape:

- `bee-pi-agent` owns agent execution and local state
- `bee-worker-sidecar` owns NATS connectivity and Bee subject routing

In this fork, the published npm package name is
`@fabianmewes-jm/fabee-pi-agent`, while the runtime binary and several runtime
identifiers still use the established `bee-pi-agent` naming.

That keeps the agent reusable for deployments that want Bee Dance semantics
without forcing every worker implementation to speak NATS directly.

## Upstream provenance

This package is derived in part from
[`pi-mom`](https://github.com/badlogic/pi-mono/tree/main/packages/mom) by Mario
Zechner. The upstream package is MIT licensed, and selected files in this
package were copied or adapted under that license.

See [UPSTREAM.md](./UPSTREAM.md) for file-level provenance details.

## Socket protocol

`bee-pi-agent` exchanges framed Bee Dance envelopes over a Unix socket. The
expected local flow is:

- sidecar sends `protocol.hello`
- agent replies with `protocol.welcome`
- sidecar sends `turn.start`
- agent streams event envelopes back on the same socket
- sidecar may send `turn.cancel`

The default socket path is `/var/run/bee/worker.sock`.

## Run locally

```bash
npm install
npm run build
BEE_PI_AGENT_WORKSPACE_ROOT=/workspace \
BEE_PI_AGENT_SOCKET=/tmp/fabee-pi-agent.sock \
node dist/main.js
```

## Environment

Primary variables:

- `BEE_PI_AGENT_WORKSPACE_ROOT` required workspace root for this worker instance
- `BEE_PI_AGENT_WORKSPACE_CWD` optional working directory inside the workspace
- `BEE_PI_AGENT_STATE_DIR` optional worker state directory
- `BEE_PI_AGENT_MEMORY_FILE` optional memory file path
- `BEE_PI_AGENT_SKILLS_DIR` optional skills directory path
- `BEE_PI_AGENT_SANDBOX` optional `host` or `docker:<container>`
- `BEE_PI_AGENT_DOCKER_WORKSPACE_ROOT` optional visible workspace root inside docker, default `/workspace`
- `BEE_PI_AGENT_SYSTEM_PROMPT_APPEND` optional additional fixed instructions
- `BEE_PI_AGENT_BLOB_STORE_ROOT` optional blob-store root for attachments and artifacts
- `BEE_PI_AGENT_ARTIFACT_INLINE_MAX_BYTES` optional max artifact size embedded into Bee Dance `artifactRef.uri` for downstream uploads; default `5000000` (5 MB). Because inline artifacts are base64-encoded in Bee Dance events, the NATS/server transport payload limit must allow roughly 1.4x this size plus envelope overhead.
- `BEE_PI_AGENT_AUTH_FILE` optional auth file override
- `BEE_PI_AGENT_MODEL_PROVIDER` optional provider override
- `BEE_PI_AGENT_MODEL_ID` optional model override
- `BEE_PI_AGENT_THINKING_LEVEL` optional reasoning level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`; default `off`
- `BEE_PI_AGENT_TOOL_MODULES` optional comma-separated extra tool modules
- `BEE_PI_AGENT_ENABLE_COMPANY_BRIEFING` optional `true`/`1` env gate for the baked-in `company_briefing` worker tool
- `BEE_PI_AGENT_COMPANY_BRIEFING_DBT_TARGET` optional dbt target for `company_briefing`, defaulting to `prod`
- `BEE_PI_AGENT_COMPANY_BRIEFING_QUERY_TIMEOUT_SECONDS` optional BI query timeout for `company_briefing`, default `45`
- `BEE_PI_AGENT_DBT_PROJECT_DIR` optional dbt project directory for the built-in `dbt` tool
- `BEE_PI_AGENT_DBT_PROFILES_DIR` optional dbt profiles directory for the built-in `dbt` tool
- `BEE_PI_AGENT_DBT_COMMAND` optional dbt executable path or command name for the built-in `dbt` tool
- `BEE_PI_AGENT_DBT_TARGET` optional default dbt target for the built-in `dbt` tool
- `BEE_PI_AGENT_SOCKET` optional Unix socket path, default `/var/run/bee/worker.sock`

For OAuth-backed OpenAI usage with a `pi-ai` `auth.json`, use
`BEE_PI_AGENT_MODEL_PROVIDER=openai-codex`. Plain `openai` expects an API key
based provider flow instead.

For migration convenience, the older `PI_AGENT_WORKER_*` variables are still
accepted as fallbacks.

## Built-in dbt tool

The worker now includes a built-in `dbt` tool so the agent can:

- list models and analyses via `dbt list`
- preview model output via `dbt show --select ...`
- execute inline SQL via `dbt show --inline ...`
- run targeted `dbt compile`, `test`, and `parse`

The tool intentionally does not expose `dbt build` or `dbt run`; analytics answers should query already-built prod models rather than building models from Slack-triggered turns.

For reliable operation outside a dbt repo, set:

```bash
BEE_PI_AGENT_DBT_PROJECT_DIR=/path/to/dbt-project
BEE_PI_AGENT_DBT_PROFILES_DIR=/path/to/dbt-profiles-dir
BEE_PI_AGENT_DBT_COMMAND=/path/to/dbt
BEE_PI_AGENT_DBT_TARGET=dev
```

If `BEE_PI_AGENT_DBT_COMMAND` is not set, the tool tries a local `.venv/bin/dbt` first and then falls back to `dbt` on `PATH`.

## Built-in Company Briefing tool

The image contains an optional `company_briefing` worker tool for JobMatch Company Briefings. It is not exposed by default. Enable it either with:

```bash
BEE_PI_AGENT_ENABLE_COMPANY_BRIEFING=true
```

or by loading the baked module explicitly:

```bash
BEE_PI_AGENT_TOOL_MODULES=./dist/tools/company-briefing.js
```

The tool contract is `companyId`. It queries already-built Analytics/dbt models with the prod target by default, and returns Slack-ready Markdown plus structured non-raw signal details. Company Briefings should use this tool and should not be reconstructed through arbitrary dbt/BI queries in the agent prompt path.

Required operational configuration:

```bash
BEE_PI_AGENT_DBT_PROJECT_DIR=/path/to/dbt-project
BEE_PI_AGENT_DBT_PROFILES_DIR=/path/to/dbt-profiles-dir
```

In JobMatch Kubernetes deployments, Analytics dbt credentials are provided by Flux infra (for example via `analytics-db-credentials`); this app chart does not create them.

The older `PI_AGENT_WORKER_*` variable names are accepted as fallbacks for the Company Briefing settings as well.

## Docker image

A Dockerfile is included for runtime image builds. Build it locally with:

```bash
docker build -t fabee-pi-agent:local .
```

In this fork, the Docker image is built directly from the repository source.
The release flow does not require publishing the npm package first.

The image is designed to be paired with `bee-worker-sidecar` in the same pod.

## Helm chart

This repo currently still contains a reusable Helm chart under
[`charts/fabee-pi-agent`](./charts/fabee-pi-agent).
The chart deploys:

- one `bee-pi-agent` container
- one `bee-worker-sidecar` container
- optional `fabee-log-exporter` and `fabee-log-read-api` sidecars
- one shared socket volume mounted at `/var/run/bee`

`logReadApi` is disabled by default. When enabled it mounts the shared workspace,
serves `/health` plus the read API on the configured port, and expects
`logReadApi.bearerTokenSecretName` / `logReadApi.bearerTokenSecretKey` for auth.

It also supports the same workspace, auth, and git bootstrap patterns that were
used in the earlier `pi-agent-worker` deployment.

Note: the chart packaging in this repository now uses `fabee-pi-agent`, while runtime identifiers and several defaults still intentionally use established `bee-pi-agent` naming for compatibility.

## License

MIT
