// The MCP server over Streamable HTTP, for the hosted app. It is stateless: every request builds a fresh server,
// so nothing has to be remembered between calls and any Worker instance can answer. The tools are the same ones the
// stdio server offers; they call the app's own API in-process instead of over the network.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {InboxClient} from '../packages/mcp/src/inbox.js';
import {registerTools, SERVER_INFO, INSTRUCTIONS} from '../packages/mcp/src/tools.js';

// `handler` takes a Request for /api/... and returns the app's Response.
export async function handleMcp(request, handler) {
  const client = new InboxClient(undefined, (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.delete('Origin');   // in-process calls are not browser requests
    // The in-process call needs no abort timer or redirect policy, and not every runtime accepts those options on a Request.
    const {signal, redirect, ...rest} = init;
    return handler(new Request(url, {...rest, headers}));
  }, () => null);
  const server = new McpServer(SERVER_INFO, {instructions: INSTRUCTIONS});
  registerTools(server, client);
  const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
  await server.connect(transport);
  return transport.handleRequest(request);
}
