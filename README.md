# Code Chat

Code Chat gives clients a private place to ask how your application works. Every answer starts with a local CodeGraph lookup. OpenAI or Gemini uses the results to explain workflows, features, and business rules in everyday language.

The app uses Node.js, SQLite, and plain HTML, CSS, and JavaScript. It uses markdown-it to format replies and the separately installed CodeGraph executable. There is no build step.

## Run locally

Use Node.js **22.16 or later**, Git, and the [CodeGraph CLI](https://github.com/colbymchenry/codegraph) on your `PATH`. If CodeGraph is installed in a different location, set `CODEGRAPH_BIN` to the absolute path of its executable. The integration was developed against CodeGraph 1.6.3.

1. Initialize CodeGraph in the private repository you want clients to ask about. Run this under the account that will run Code Chat.

   ```sh
   codegraph init --yes --local-only /srv/private-repo
   codegraph status /srv/private-repo
   ```

2. From this app's directory, create a private configuration file.

   ```sh
   install -m 600 .env.example .env
   ```

   Set `REPO_PATH` to the indexed checkout. Choose a provider and set its key.

   | Setting | Value |
   | --- | --- |
   | `LLM_PROVIDER=openai` | Set `OPENAI_API_KEY`. The default model is `gpt-4.1-mini`. |
   | `LLM_PROVIDER=gemini` | Set `GEMINI_API_KEY`. The default model is `gemini-3.5-flash-lite`. |

   Set `LLM_MODEL` to override the default with a model that supports function calling. By default, `DATABASE_PATH` is `./data/code-chat.sqlite` and the server listens at `127.0.0.1:3000`. Both npm commands load `.env` from the app directory. Existing process environment values take precedence.

3. Create a client account and start the app.

   ```sh
   npm ci
   npm run create-user -- client@example.com
   npm start
   ```

   The command prints a generated password once. Share it with the client through a secure channel. Run the command again with a different email for each client. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and sign in. If you change the browser URL, set `APP_ORIGIN` to match it exactly, including any non-default port.

## Deploy on a VPS

Run one app process under a dedicated, unprivileged account with read access to the repository and write access to its `.codegraph/` directory and the SQLite directory. Use a persistent local disk for `DATABASE_PATH`. Run the account-creation command from the same app directory as that account so it uses the same database.

Keep the Node server on loopback and put it behind an HTTPS reverse proxy. For example, point `chat.example.com` at the VPS and configure Caddy.

```caddyfile
chat.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Set `APP_ORIGIN=https://chat.example.com` in `.env`. This enables secure session cookies and allows form submissions from that origin.

To keep the app running after reboots, use a process supervisor. This example assumes system-wide Node and CodeGraph binaries. Adjust the user and paths to match your install.

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

Save it as `/etc/systemd/system/code-chat.service`, then run `sudo systemctl daemon-reload` and `sudo systemctl enable --now code-chat`.

Update the target checkout with `git -C /srv/private-repo pull --ff-only`. Code Chat keeps a CodeGraph MCP process open with file watching enabled. Give the watcher a moment to index the changed files. To check the index, use `codegraph status /srv/private-repo`. If a manual catch-up is needed, run `codegraph sync /srv/private-repo` under the same service account.

## Data and access

- Account creation is a server-side CLI operation. Passwords are salted and hashed with scrypt. Browser sessions expire after seven days and can be ended early by signing out.
- Each account sees only its own conversation history. All accounts on one instance ask about the same `REPO_PATH`. Give access to clients authorized to learn about that repository.
- Questions are saved before generation. If an answer fails, the client can retry the latest unanswered question from the same conversation. Successful answers are appended alongside questions. The app has no edit or delete UI or API for chats or messages. SQLite triggers reject updates and deletes on both tables.
- The model receives the current question, up to seven preceding answered turns, and relevant source excerpts returned by CodeGraph. Keep secrets and data files out of the target checkout. Provider data-handling terms apply to the material sent to the provider. Use an indexed checkout approved for that transfer.
- Back up SQLite regularly to retain permanent history after disk failure or migration. Use SQLite's backup command while the app is running. For a filesystem copy, stop the app and all other database writers first.

## Project structure

```text
.env.example     Runtime configuration template
.gitignore       Local config, database data, and index exclusions
package.json     Start and account-creation commands
package-lock.json Pinned Markdown parser dependencies
README.md        Setup and operations
public/
  login.html     Client sign-in
  index.html     Conversation workspace
  app.css        Responsive styles
  app.js         Message submission, history, and status updates
  theme.js       Dark and light appearance preference
src/
  server.js      HTTP routes, sessions, and conversation handling
  auth.js        Password and session hashing
  create-user.js Admin account-creation CLI
  db.js          SQLite initialization
  schema.sql     Users, sessions, conversations, and append-only messages
  codegraph.js   Local CodeGraph MCP connection
  llm.js         Provider adapters and required tool lookup
```
