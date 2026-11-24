# Code Chat

Code Chat gives clients a private place to ask how their assigned applications work. Every answer starts with a local CodeGraph lookup (`codegraph_explore`), and OpenAI or Gemini uses the results to explain workflows, features, and business rules in everyday language.

The app uses Node.js, built-in `node:sqlite`, and plain HTML, CSS, and JavaScript. It uses pinned `markdown-it` to format replies safely and the separately installed CodeGraph CLI (`>=1.6.3`). There is no build step.

## Run locally

Use Node.js **22.16 or later**, Git, and the [CodeGraph CLI](https://github.com/colbymchenry/codegraph) on your `PATH`. If CodeGraph is installed in a different location, set `CODEGRAPH_BIN` to the absolute path of its executable.

1. Place the repositories you want to manage inside one parent directory (for example `/srv/projects/acme-app`, `/srv/projects/billing-portal`).

2. From this app's directory, create a private configuration file.

   ```sh
   install -m 600 .env.example .env
   ```

   Set `PROJECTS_BASE_DIR` to the parent directory containing your projects. Choose an LLM provider and set its key:

   | Setting | Value |
   | --- | --- |
   | `LLM_PROVIDER=openai` | Set `OPENAI_API_KEY`. The default model is `gpt-4.1-mini` (used for both guardrail classification and chat answers). |
   | `LLM_PROVIDER=gemini` | Set `GEMINI_API_KEY`. The default chat model is `gemini-3.5-flash-lite`; guardrail classification is routed to `gemini-decision-1` (not `LLM_MODEL`). |

   Set `LLM_MODEL` to override the chat model with one that supports function calling. When `LLM_PROVIDER=openai`, guardrail checks run against that selected OpenAI `LLM_MODEL`; when `LLM_PROVIDER=gemini`, guardrail classification routes to `gemini-decision-1` instead of `LLM_MODEL` (override with `GEMINI_GUARDRAIL_MODEL` only if needed). By default, `DATABASE_PATH` is `./data/code-chat.sqlite` and the server listens at `127.0.0.1:3000`. Optional MCP pool tuning: `CODEGRAPH_MCP_MAX_WORKERS` (default `4`) and `CODEGRAPH_MCP_IDLE_MS` (default `600000` / 10 minutes).

3. Install dependencies, bootstrap your first admin account, and start the app.

   ```sh
   npm ci
   npm run create-user -- --admin admin@example.com --name "Site Admin"
   npm start
   ```

   The CLI prints a generated password once. Open [http://127.0.0.1:3000/login](http://127.0.0.1:3000/login) and sign in as the admin to land on `/admin`. If you change the browser URL, set `APP_ORIGIN` to match it exactly, including any non-default port.

   Other CLI forms:
   ```sh
   npm run create-user -- client@example.com --name "Client Name"
   npm run create-user -- --promote-admin existing@example.com
   ```

## Admin & Client Workflow

- **Admin (`/admin`)**:
  - **Clients**: create client or admin accounts (one-time generated password), edit display name/email, reset passwords (immediately signing out active sessions), enable/disable accounts (immediately invalidating sessions), and assign projects to clients.
  - **Projects**: add projects using paths relative to `PROJECTS_BASE_DIR` (validated with `realpath` containment—`..` traversal and escaping symlinks are rejected), inspect `codegraph status`, and trigger asynchronous `codegraph init --yes --local-only` or `codegraph sync` with per-project locking and live log output. Deleting a project keeps its conversation history in Admin History by default unless **"Also delete all conversation history for this project"** is checked.
  - **History**: inspect full read-only client conversations filterable by client and project (including revoked-access and deleted-project retained threads). Admins cannot send chat messages.
- **Clients (`/`)**:
  - After signing in, clients pick one of their assigned projects from the top of the collapsible left sidebar, browse that project's conversation threads, and start or continue chats scoped to that project.
  - Only indexed projects can be queried. Revoking a project or disabling a client account takes effect immediately.

## Deploy on a VPS

Run one app process under a dedicated, unprivileged account with read access to the repositories under `PROJECTS_BASE_DIR` and write access to each repository's `.codegraph/` directory and the SQLite directory. Use a persistent local disk for `DATABASE_PATH`.

Keep the Node server on loopback and put it behind an HTTPS reverse proxy (for example Caddy):

```caddyfile
chat.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Set `APP_ORIGIN=https://chat.example.com` in `.env` to enable `__Host-codechat` secure cookies, HSTS, and strict `Origin` checks on all state-changing requests.

Example systemd unit (`/etc/systemd/system/code-chat.service`):

```ini
[Unit]
Description=Code Chat
After=network.target

[Service]
User=codechat
WorkingDirectory=/srv/code-chat
ExecStart=/usr/bin/node --env-file-if-exists=.env src/server.js
Restart=on-failure
KillMode=mixed
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
```

Code Chat lazy-starts per-project CodeGraph MCP workers with file watching enabled by default, evicts idle or least-recently-used workers to keep memory bounded, stops a project's worker before admin `init`/`sync`/delete, and shuts down all workers and SQLite cleanly on `SIGTERM`/`SIGINT`.

## Testing

Run the automated test suite with Node 22.16+:

```sh
npm test
```

## Data and Security

- Passwords use scrypt hashing with random salts and constant-time verification; 7-day sessions are SHA-256 hashed in SQLite (`HttpOnly; SameSite=Strict`).
- All non-`GET`/`HEAD` requests must match `APP_ORIGIN` exactly (`403` otherwise). Strict CSP disallows inline scripts and styles.
- CodeGraph CLI commands run via `spawn`/`execFile` (`shell: false`) with a minimal environment (LLM API keys are never passed to CodeGraph).
- Questions are saved before generation with idempotent `requestId` and retry for the latest unanswered question; the model receives up to seven prior answered turns plus CodeGraph evidence.
- **Guardrails**: Client questions pass through multi-layer guardrails that block code/script/SQL generation, code or database editing requests, source/secret extraction, prompt injection, and off-topic requests:
  - Fast server-side input filter blocks obvious disallowed requests before calling CodeGraph or the LLM.
  - Pre-lookup LLM guardrail classifier evaluates remaining requests before any CodeGraph lookup or chat generation runs: when `LLM_PROVIDER=gemini` it calls the dedicated **`gemini-decision-1`** model via the Gemini Decisions API (`POST /v1beta/decisions`, separate from `LLM_MODEL`), and when `LLM_PROVIDER=openai` it calls the configured OpenAI **`LLM_MODEL`**.
  - Hardened read-only system instructions and a post-LLM output filter block fenced code blocks and raw scripts/SQL before saving replies.
- SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers protect `chats` and `messages` as append-only (the sole exception is explicit admin project deletion with `deleteChats: true`, executed inside a single atomic transaction that immediately restores the triggers).
- Back up SQLite regularly using SQLite's online backup command while running, or stop the service before copying the database files.

## Project structure

```text
.env.example            Runtime configuration template
.gitignore              Local config, database data, and index exclusions
package.json            Start, account-creation, and test commands
package-lock.json       Pinned Markdown parser dependencies
README.md               Setup and operations
public/
  login.html            Sign-in page
  index.html            Client ChatGPT-style multi-project workspace
  admin.html            Admin dashboard (Clients, Projects, History)
  app.css               Shared responsive styles & theme tokens
  app.js                Client workspace & login behavior
  admin.js              Admin dashboard client
  markdown.js           Shared safe markdown-it configuration
  theme.js              Dark and light appearance preference
src/
  server.js             Process entrypoint and graceful shutdown
  app.js                HTTP routes, auth/role guards, admin & chat APIs
  auth.js               Password and session hashing
  create-user.js        CLI for bootstrapping admins and creating users
  db.js                 SQLite initialization
  schema.sql            Base SQLite tables and append-only triggers
  migrations.js         Transactional PRAGMA user_version migrations
  paths.js              PROJECTS_BASE_DIR realpath containment checks
  codegraph.js          JSON-RPC CodeGraph MCP client
  codegraph-cli.js      Safe async status / init / sync runner with locking
  codegraph-manager.js  Bounded LRU / idle-evicting per-project MCP pool
  llm.js                OpenAI and Gemini adapters with required tool lookup
test/                   node:test integration & hardening test suite
```
