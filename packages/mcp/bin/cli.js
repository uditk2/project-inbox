#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InboxClient } from '../src/inbox.js';
import { registerTools, SERVER_INFO, INSTRUCTIONS } from '../src/tools.js';

// PROJECT_INBOX_URL alone points at a local app. With PROJECT_INBOX_TOKEN it points at a hosted one (https).
const client = new InboxClient(process.env.PROJECT_INBOX_URL, undefined, undefined, process.env.PROJECT_INBOX_TOKEN);
const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
registerTools(server, client);
await server.connect(new StdioServerTransport());
