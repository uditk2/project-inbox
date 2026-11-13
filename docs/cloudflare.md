# Hosted mode on Cloudflare Workers

Project Inbox is local first: `npx project-inbox` runs a loopback app on your computer. Hosted mode is a second way to
run the same app, on a Cloudflare Worker, so nothing has to stay running on your machine. It is additional. The local
app, its npm package and its data are untouched.

Read this first: hosted mode changes the trust model. Your mail and your Resend API keys live in a Cloudflare account
(D1 database, encrypted keys) and the app is reachable from the internet behind an access token. The README's promise
of "no hosted account, no public endpoint" applies to local mode only.

## How it maps

| Local | Hosted |
|---|---|
| `node:sqlite` file in `~/.project-inbox` | Cloudflare D1 (the app already talks to its database through the D1 interface, so `src/` is shared as is) |
| Loopback-only check | `INBOX_TOKEN`: bearer token for tools, signed browser session for the web UI |
| Polling when you press Refresh | Resend webhook for near-instant mail, plus a 10 minute cron sync as a safety net |
| `project-inbox-mcp` finds the app by port | Same MCP server over https with a token, or the native endpoint `/mcp` |
| `static files from public/` | Workers static assets, always served through the Worker so access and security headers apply |
| Codex schedule scan reads `~/.codex` | Cannot read your computer. `project-inbox push-schedules` sends them |
| Resend keys encrypted with a key file | Resend keys encrypted with the `CREDENTIALS_KEY` secret (same AES-GCM code) |

Entry points: `src/worker.js` (routing), `src/hosted.js` (access, webhook, cron), `src/mcp-http.js` (MCP over HTTP),
`wrangler.jsonc`. The tool definitions live once, in `packages/mcp/src/tools.js`, and serve both the stdio server and
`/mcp`, so the two cannot drift.

## Access

- `Authorization: Bearer <INBOX_TOKEN>` works for `/api/*` and `/mcp`. Browsers never attach it on their own, so writes with it need no same-origin check.
- The web UI uses `/login` (paste the token once). That sets an HttpOnly, Secure, SameSite=Strict cookie that expires after 7 days. Writes with the cookie must be same-origin JSON, as in local mode. The cookie never opens `/mcp`.
- `INBOX_TOKEN` shorter than 32 characters, or unset, makes everything answer 503 instead of running open.
- Comparisons are constant time. There is no login rate limit inside the Worker. Add a Cloudflare rate limiting rule for `/login` and `/api/*`, or put Cloudflare Access in front of the UI paths.
- `/health` and `/webhooks/resend/<accountId>` are the only paths without the token. The webhook is protected by its own signature.

## Webhook

`POST /webhooks/resend/<accountId>`. Resend signs with Svix: HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<body>`, keyed
by the base64 part of the `whsec_` secret. The Worker checks the signature, refuses timestamps more than 5 minutes
off, and treats the event only as a nudge: it then runs the same sync a person triggers with Refresh, so a forged or
odd payload cannot add a message. Details:

- Event ids are stored in `webhook_events` after a successful sync, so a replay does nothing and a failed sync returns 502 so Resend retries.
- Any `email.*` event triggers up to 2 pages of sync. Other events are acknowledged and ignored.
- The signing secret comes from the account (`webhookSecret`, kept inside the encrypted credentials, set with `POST /api/accounts`) or from the `WEBHOOK_SECRETS_JSON` secret, for example `{"slayfit":"whsec_..."}`.
- The cron (`*/10 * * * *`, change it in `wrangler.jsonc`) syncs every account up to 3 pages and prunes event ids older than 30 days.

## Set it up

You need a Cloudflare account. Nothing below runs until you do it.

```sh
npm ci
npx wrangler login
npx wrangler d1 create project-inbox          # copy the database_id into wrangler.jsonc
npx wrangler d1 migrations apply project-inbox --remote

# Secrets (each prompts for the value; nothing goes in a file)
openssl rand -base64 36                        # use the output as INBOX_TOKEN
npx wrangler secret put INBOX_TOKEN
npx wrangler secret put CREDENTIALS_KEY        # 32+ random characters, see "Move your data" if you import
npx wrangler secret put MAIL_ACCOUNTS_JSON     # optional: [{"id":"slayfit","name":"SlayFit","mailbox":"udit@slayfit.fun","apiKey":"re_..."}]
npx wrangler secret put WEBHOOK_SECRETS_JSON   # {"slayfit":"whsec_..."} once the Resend webhook exists

npx wrangler deploy
```

Skip `MAIL_ACCOUNTS_JSON` if you prefer to add accounts in Settings after signing in; they are stored encrypted in D1.

In Resend, add a webhook per account: URL `https://<your-worker>/webhooks/resend/<accountId>`, events for received email (and sent, if you want sent mail to appear at once). Copy its signing secret into `WEBHOOK_SECRETS_JSON`.

Run locally against the real Workers runtime without touching Cloudflare: copy `.dev.vars.example` to `.dev.vars`, then
`npx wrangler d1 migrations apply project-inbox --local` and `npx wrangler dev --local`.

## Move your data

```sh
npx project-inbox export-sql --out inbox.sql
npx wrangler d1 execute project-inbox --remote --file inbox.sql
rm inbox.sql
```

The file holds your mail and your encrypted Resend keys, so keep it private. Account keys are sealed with the local
key in `~/.project-inbox/credentials.key`. To keep them working in the hosted app, set that same text as the
`CREDENTIALS_KEY` secret. Otherwise set a new key and re-enter the Resend keys in Settings. Messages too large for one D1
statement (over about 90 KB) are exported without their bodies and are fetched from Resend again when opened. The
import is repeatable: rows are replaced, not duplicated.

## Point your tools at it

Same npx MCP server, now with the hosted address and token. The token is read from the environment so it stays out of
your shell history:

```sh
export PROJECT_INBOX_TOKEN=...        # the INBOX_TOKEN value
npx project-inbox setup --remote https://<your-worker>
```

This registers Claude Code, Codex and Claude Desktop (whichever are installed) with `PROJECT_INBOX_URL` and
`PROJECT_INBOX_TOKEN` as environment variables for `project-inbox-mcp`. An existing local registration is left alone:
remove it first (for example `claude mcp remove project-inbox`), then run setup again, then restart the tool. The
token is stored in each tool's own config, like any other MCP server credential.

Clients that speak Streamable HTTP can use the endpoint directly, with no npx: `https://<your-worker>/mcp` and the
header `Authorization: Bearer <token>`. It is stateless and answers with plain JSON.

Anything else that called the local API (`http://127.0.0.1:8799/api/...`, for example a script that reads
verification mail) must switch to the https address and send the bearer header.

## Codex, Claude and Cowork schedules

The calendar's schedules come from agents. Claude and Cowork agents already save theirs through the `sync_schedules`
tool, which works the same hosted. The Codex scan reads files on your computer, which a Worker cannot do, so
`POST /api/schedules/scan` is refused in hosted mode and this runs on your computer instead:

```sh
PROJECT_INBOX_TOKEN=... npx project-inbox push-schedules --remote https://<your-worker>
```

It sends names, schedules and on/off state only, never prompts. Run it again after you add Codex automations, or put
it on a schedule.

## Limits and what is not done

- Not deployed anywhere by this change. Verified: unit tests, the Worker bundling with `wrangler deploy --dry-run`, migrations and the exported SQL on local D1, and the whole flow (UI session, API, webhook signature, MCP over HTTP, stdio MCP to a hosted app) against `wrangler dev --local`, which runs the real Workers runtime.
- Not verified: a real Cloudflare deploy, a real Resend webhook delivery (the signature scheme follows Svix's published format; the payload is deliberately not trusted), and `setup --remote` against the real Claude Code and Codex binaries (it is tested against their documented `mcp add` flags with a fake runner).
- Workers have request limits. A sync is bounded to 2 or 3 pages per run, and the first import of a large mailbox finishes over several cron ticks.
- D1 rows are limited to 2 MB. Very large mail bodies are fetched from Resend on demand.
- Attachments stream through the Worker from Resend's download link, as they do locally.
- Browser desktop notifications and the demo mode only exist locally.
