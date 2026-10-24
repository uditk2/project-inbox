# Client interface

Project Inbox is a local browser application with a compact mail layout: project navigation, message list, and reader. A deep navy sidebar separates project context from the warm white reading space. Cobalt marks primary actions and the selected message. Project chips keep account context visible.

The interface is framework-free and uses system fonts. It requests no remote scripts, fonts, or images. The layout adapts to a list-to-reader flow on phones. Command/Control K focuses search; compose and reply use an accessible native dialog.

No sign-in is required. The app is served by the local npm process on the Mac. First-time users see a focused onboarding screen and connect their first Resend project through Settings. Existing connections persist locally, so users do not reenter API keys each visit. Project IDs are limited to 48 characters and become read-only when editing an existing account.

Settings support adding and editing projects with full-access Resend keys. Existing credentials are never displayed; blank keys preserve the saved key when editing. Secret fields clear immediately after submission and on close. Credentials are encrypted locally. Polling retrieves incoming mail without a public webhook or server. Each refresh processes at most three pages sequentially with provider-rate spacing, rotates the starting project, and avoids overlapping synchronization.

Live messages come from the local API. Demo mode is visibly identified and cannot send or save credentials. Email text is preferred; HTML-only content is isolated in a sandboxed iframe with restrictive content security policy and remote content disabled.

Desktop notifications require opt-in and show message counts rather than private subject lines. Visible pages refresh about once a minute and on return. Closed-app background notifications are outside this browser client's scope.

Visual checks used fictional Studio and Workshop demo accounts. Checked message selection/read state, project editing, and reply addressing with sending disabled. Reference captures are saved outside the repository at `/private/tmp/project-inbox-ui.png` and `/private/tmp/project-inbox-settings.png`.

Compose supports font family and size, bold/italic/underline, lists, safe links, and clear formatting. The editable message produces both plain text and HTML. Pasted or dropped content is inserted as text, preventing imported active HTML. Links accept only HTTP, HTTPS, and mailto protocols. Empty messages and HTML over 100,000 characters are rejected before sending. Formatting changes reset the send retry identifier just like text edits.

Rich compose visual checks confirmed combined bold and Georgia styling survive together, invalid script links are rejected, and HTTPS links preserve selected formatting. No email was sent during these checks. Reference: `/private/tmp/project-inbox-rich-compose.png`.
