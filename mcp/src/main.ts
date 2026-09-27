import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import cors from 'cors';
import type { Request, Response } from 'express';
import { createServer } from './server';

/*
 * `--stdio` for an agent that starts the server itself (Claude Code, Claude
 * Desktop, Cursor, VS Code). Without it, Streamable HTTP on /mcp, stateless:
 * a fresh server per request, which is what lets a host scale it out.
 */

async function serveHttp(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  // Loopback by default, which also turns on the SDK's DNS rebinding
  // protection. A hosted deployment sets HOST=0.0.0.0 and sits behind TLS.
  const host = process.env.HOST ?? '127.0.0.1';
  // A tunnel (cloudflared, ngrok) arrives on loopback carrying its own
  // hostname, which the localhost check refuses. ALLOWED_HOSTS names it,
  // keeping the check on rather than binding wide open to get past it.
  const extra = (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const app = createMcpExpressApp({
    host,
    ...(extra.length > 0 ? { allowedHosts: ['localhost', '127.0.0.1', ...extra] } : {}),
  });
  app.use(cors());

  app.all('/mcp', async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.listen(port, host, (err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Breakscale MCP on http://localhost:${port}/mcp`);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--stdio')) {
    await createServer().connect(new StdioServerTransport());
  } else {
    await serveHttp();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
