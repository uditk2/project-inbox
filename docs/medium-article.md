# I Wanted One Inbox. So I Built an Email Client.

A local-first, open source email client for the Resend accounts behind my projects.

DRAFT FOR REVIEW, NOT PUBLISHED

I wanted a separate email address for each project. SlayFit should have its own inbox. Review Assist should have its own inbox. Neither needed to disappear into my personal Gmail.

Sending was already available through Resend. Receiving was possible too. The missing piece was the place where I could sit down, read the mail, and reply from the right address without checking several dashboards.

That small gap became Project Inbox, an open source email client that runs locally and combines multiple Resend accounts in one browser interface. I built it with help from AI coding agents, including a separate agent for the client design.

## The first plan was bigger than the problem

Our first sketch had a public webhook endpoint on Cloudflare, a database, and a desktop app. Resend would notify the server about incoming mail. The server would store it. The desktop app would connect to that server.

That is a reasonable design for a service that must collect events continuously or support several people across devices. We also considered Google sign-in and a hosted version.

Then I asked a simpler question: if Resend already stores received messages and exposes a listing API, why should my first version depend on a second always-available service?

Resend documents listing received emails with pagination, which makes polling and backfilling possible without a webhook. That changed the architecture.

## A local client was enough for the first version

Project Inbox starts a small Node process bound to the loopback address on my computer. It serves the browser interface, calls Resend, and uses SQLite for local persistence.

Opening the client triggers synchronization. While the page is active, it checks periodically for new mail. If the app is closed, messages continue arriving at Resend. The next sync can retrieve the messages the provider still retains.

The browser is the interface. The local Node process is the bridge to Resend. This avoids depending on direct browser access to the provider API and gives us one place to handle credentials, request limits, and persistence.

There is no hosted account to create and no public endpoint to expose. The first screen asks for a project name, mailbox address, and Resend key. Add another account and it joins the same unified inbox.

## Entering a key once should actually mean once

I did not want to paste an API key every time I opened the app. Connected accounts therefore live in the local SQLite database. The application encrypts their API keys using AES-GCM and generates a separate encryption key on the same computer.

The settings screen never receives saved API keys back from the server. It can update a key or keep the existing one. Restarting the app does not discard the accounts.

This is a specific protection with a specific limit: a copied database does not expose those keys without the encryption key. Someone who controls the computer and can read both files is outside that protection. Cached email content is not encrypted by the app itself.

For a local tool, that boundary is more useful to explain clearly than a vague promise that everything is secure.

## The small details are still email-client work

A unified inbox needs more than a list API. Messages need read state, an archive, account filters, a reader, and a way to reply through the account that received the conversation.

The first version includes those pieces, plus a composer with font choices, sizes, emphasis, lists, and links. Outgoing messages carry plain text and sanitized HTML. Incoming HTML is isolated, with scripts and remote content blocked.

Sync imports bounded pages and persists its progress, so an interrupted history import can continue later. Full bodies are loaded when a message is opened. Provider requests are spaced out rather than firing every account at once.

Sending uses a persistent request identifier and Resend's idempotency mechanism. That matters when a request succeeds at the provider but the browser loses the response. Retrying should not casually send another copy.

## A domain still needs somewhere to receive mail

Building the client did not remove the DNS work. SlayFit initially forwarded incoming mail through Cloudflare to Gmail. That arrangement could verify an address, but it would not put incoming messages into the Resend account the client reads.

We switched the incoming route to the receiving record supplied by Resend. Outgoing domain verification and incoming mail routing are separate checks. A working send test does not establish that receiving works.

The first live outgoing test reached its destination. Receiving configuration was subsequently verified by Resend; a full incoming-message test remains part of the rollout.

## Keep the first release small enough to use

The code separates routing, synchronization, sending, formatting, credential handling, and storage. The client uses ordinary HTML, CSS, and JavaScript. There is no frontend framework build step and no Docker requirement.

The package is designed to start with one npm command. The public GitHub source can be used independently of an npm registry release, and the repository includes CI checks and a publishing workflow.

It is deliberately an early Resend client. Outgoing attachments, calendar features, mobile synchronization, and notifications while everything is closed are not part of this release.

My next step is to use it with my own projects for a few days. That should tell me more than adding hosted sign-in before the local workflow has settled.

If you also have several project addresses on Resend and want one place to manage them, the source and setup instructions are available in the Project Inbox repository. The useful question for this first version is whether it makes that daily task easier.

[Project Inbox source and setup](https://github.com/uditk2/project-inbox) · [Resend received-mail API](https://resend.com/docs/api-reference/emails/list-received-emails)

