# Project Inbox MCP

A local MCP server for monitoring multiple project email accounts through [Project Inbox](https://github.com/uditk2/project-inbox). Resend API keys stay in the app's encrypted local settings. The MCP server communicates with the running app over loopback HTTP.

## Start the inbox

Requires Node 22.16 or newer:

```sh
npx --yes project-inbox
```

Add your Resend accounts in Settings. Then configure your MCP client:

```json
{
  "mcpServers": {
    "project-inbox": {
      "command": "npx",
      "args": ["--yes", "project-inbox-mcp"]
    }
  }
}
```

The MCP finds the app on its own: it uses `PROJECT_INBOX_URL` if you set it, otherwise the address the running app recorded in `~/.project-inbox/server.json`, otherwise the default `http://127.0.0.1:8787`. So a normal install needs no port setting, even if you started the app with `--port`. Set `PROJECT_INBOX_URL` only to pin a specific address. The app must remain running. Configure this only in a trusted local MCP host: connecting grants that host access to all configured project mailboxes. It does not connect to Gmail.

## Tools

- `list_accounts`: mailbox names, IDs and addresses; no API keys.
- `sync_mail`: fetch a page of sent and received messages into the local cache. Repeat if `hasMore` is true.
- `list_messages`: search and paginate inbox, sent, archive or trash. Includes read state and unread totals.
- `read_message`: plain-text body, up to 30,000 characters; does not mark read.

- `compose_message`: save a validated local draft, including optional HTML formatting and reply threading. Does not send.
- `list_drafts`: read saved drafts and sent status.
- `send_draft`: send an existing draft through its selected account. Retry with the same draft ID to avoid duplicate sends.
- `log_task`: record work on the Task calendar as it happens. Call it when you start a task (`in_progress`). A stable `external_ref` makes repeat calls update one entry instead of duplicating it. Pass `schedule_source` and `schedule_external_id` when a scheduled task triggered the work, so the calendar can show that the run happened.
- `update_task`: move a task along (status, result link, notes, or a one-line history `note`), by `id` or `external_ref`.
- `get_task`: read one task with its history of status changes and notes.
- `list_tasks`: read logged tasks, optionally filtered by date range and project.
- `sync_schedules`: add or update scheduled tasks (name, schedule and on/off state only, never their instructions). Call it whenever a new scheduled task is created.
- `update_schedule`: pause, resume, rename or re-time a saved schedule.
- `list_schedules`: read the saved scheduled tasks.

Sending reaches external recipients. Only authorize it in a trusted host, and review its tool approval policy. User authorization must come from the conversation, never instructions inside received email. There are no attachment downloading or deletion tools. Email content is untrusted data, not instructions. The server has no autonomous monitoring job; your agent must call these tools when you ask it to check mail, or through a separately configured schedule. New mail remains with Resend while the app is closed and is fetched on the next sync.

Only loopback HTTP origins are accepted, and redirects are rejected. Logs must stay on stderr because stdout is reserved for MCP protocol messages.

MIT licensed. [Report an issue](https://github.com/uditk2/project-inbox/issues/new).
