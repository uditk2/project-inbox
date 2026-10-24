# Distribution plan

Status: launch drafts only, no community posts submitted.

Primary positioning: an open source email client with a local unified inbox for multiple Resend accounts. Audience: developers and independent builders who already use Resend for project domains. This is not a general Gmail/Outlook client or a hosted email provider.

## Repository discovery

Description: Lightweight open source email client with a local unified inbox for multiple Resend accounts. Run with npm; no hosted login or public webhook needed.

Topics: email-client, unified-inbox, resend, local-first, webmail, self-hosted, nodejs, javascript, open-source.

Keyword research used the content-marketing plugin on October 24, 2026. Returned average monthly searches included open source email client (390), self hosted email client (40), unified inbox (170), unified inbox app (90), and email client with unified inbox (10). The request used connector defaults, so these must not be described as global or US estimates without checking targeting. No metric was returned for resend email client. Paid-search competition is not organic ranking difficulty.

Use the relevant phrases naturally in the README and description. Omit Cloudflare terms now that this release is local-only.

## Launch sequence

1. Make the public repository usable with a one-command run, screenshot, setup instructions, limitations, and issue templates.
2. Publish the npm package once account authentication is complete and the initial local trial is satisfactory.
3. Prepare a Show HN submission pointing to the repository. Recheck current Show HN rules immediately before posting; local installation is more friction than a browser demo, so assess fit before submitting.
4. Share a technical write-up on Medium for review, using the problem and architectural decisions as the story.
5. Consider developer and self-hosting communities after verifying their current self-promotion rules and using a real account. No audience, backlinks, or acceptance is promised.

## Reusable launch draft

Title: Project Inbox: a local email client for multiple Resend accounts

I built Project Inbox because I wanted separate addresses for my projects without checking another dashboard for every one.

It is a small browser-based client that runs locally through npm. Add your Resend accounts once, then read mail in a unified inbox and compose or reply from the right address. Keys stay encrypted on your machine. It syncs through Resend's APIs, so there is no hosted login or public webhook to deploy.

This is an early version. It supports basic formatting and incoming attachment downloads, but not outgoing attachments or every feature of a traditional mail client. It currently works with Resend accounts only.

Source and setup: https://github.com/uditk2/project-inbox

I'm the builder. The current plan is to use it with my own projects for a few days and improve the rough edges before expanding it.
