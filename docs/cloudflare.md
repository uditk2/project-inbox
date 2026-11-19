# Run Project Inbox on Cloudflare

The same app, hosted on a Cloudflare Worker with a D1 database. People sign in with Google. Agents use API tokens. The local `npx project-inbox` app is unchanged and does not need any of this.

## Set up

```sh
npm install
npx wrangler login
npx wrangler d1 create project-inbox      # copy database_id into wrangler.jsonc
```

In `wrangler.jsonc`, set `ALLOWED_EMAILS` to the Google addresses allowed in (comma separated). Then:

```sh
npm run cf:migrate                        # creates the tables in D1
npx wrangler secret put SESSION_SECRET    # openssl rand -base64 48
npx wrangler secret put CREDENTIALS_KEY   # a different openssl rand -base64 48
npm run cf:deploy                         # prints https://project-inbox.<you>.workers.dev
```

Keep `CREDENTIALS_KEY`. It encrypts the Resend keys stored in D1, and changing it makes them unreadable.

## Google login

1. Google Cloud Console, **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**.
2. Add the authorized redirect URI `https://<your-worker-url>/auth/callback`.
3. Save the client, then:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Open the Worker URL, sign in, and add your Resend accounts in Settings. Only addresses in `ALLOWED_EMAILS` get in. If it is empty or a secret is missing, nobody does.

## Point the MCP at it

Open **Agent access** in the sidebar and create a token. It is shown once.

```sh
claude mcp add project-inbox -e PROJECT_INBOX_URL=https://<your-worker-url> -e PROJECT_INBOX_TOKEN=pi_... -- npx --yes project-inbox-mcp
```

For Claude Desktop or Codex, add the same two values as `env` for the `project-inbox-mcp` server. Without `PROJECT_INBOX_URL` the MCP keeps using your local app. Tokens cannot create other tokens.

## Move your existing local data

Resend keys are not exported. Add them again in the hosted Settings. Mail itself syncs from Resend.

```sh
node scripts/export-for-d1.mjs > project-inbox-export.sql      # tasks, schedules, drafts, feedback
npx wrangler d1 execute project-inbox --remote --file project-inbox-export.sql
```

Add `--messages` to also copy cached mail with its read, archive and trash state. Large mailboxes can exceed D1 import limits.

## Develop locally

```sh
cp .dev.vars.example .dev.vars            # fill in values
npx wrangler d1 migrations apply project-inbox --local
npm run cf:dev
```

## Differences from the local app

- Importing Codex schedules is local only. Agents can still save schedules with `sync_schedules`.
- Mail cache, drafts and tasks live in D1 instead of `~/.project-inbox`.
- Sessions last 14 days. Removing an address from `ALLOWED_EMAILS` ends its sessions immediately.
