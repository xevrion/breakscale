import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import {
  McpServer,
  type CallToolResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { buildDesignFile } from '../../src/designFile';
import { ShareLinkTooLargeError, buildShareUrl, decodeTopology } from '../../src/share';
import { fetchStored, hasStoredLink } from '../../src/share/store';
import { buildTopology } from './design';
import { DEFAULT_RUN, describeRun, runDesign } from './run';
// Build outputs, inlined by the bundler so the published server is one
// file with nothing to find on disk. tsc cannot type a text import.
// @ts-expect-error -- imported as text
import readme from '../dist/readme.md' with { type: 'text' };
// @ts-expect-error -- imported as text
import widgetHtml from '../dist/widget.html' with { type: 'text' };

const APP_URL = 'https://breakscale.tech/';
const RESOURCE_URI = 'ui://breakscale/view.html';

/** Loose on purpose: `buildTopology` gives better errors than a schema can. */
const node = z.looseObject({
  id: z.string(),
  kind: z.string().describe('Component kind, for example service, db, cache, lb'),
  label: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  config: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

const edge = z.looseObject({
  from: z.string(),
  to: z.string(),
  weight: z.number().optional(),
  control: z.boolean().optional(),
});

const design = {
  name: z.string().optional().describe('A short name for the design'),
  nodes: z.array(node),
  edges: z.array(edge).optional(),
  annotations: z.array(z.unknown()).optional(),
};

function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError } : {}) };
}

function rejected(errors: string[]): CallToolResult {
  return text(
    'The design was not accepted:\n' +
      errors.map((e) => `- ${e}`).join('\n') +
      '\nFix these and call again. read_me has the format.',
    true,
  );
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'Breakscale', version: '0.1.0' });

  server.registerTool(
    'read_me',
    {
      description:
        'Returns the Breakscale design format: every component, its settings and defaults, how requests route, and how to map real code onto components. Call this once before create_view.',
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => text(readme as string),
  );

  registerAppTool(
    server,
    'create_view',
    {
      title: 'Show design',
      description: `Shows a system design on a live Breakscale canvas the user can run, load and edit, and simulates it so you get real latency, throughput and failure numbers back.
Use it to draw an architecture, to turn code into a design, or to change a design. Call read_me first for the format.`,
      inputSchema: z.object(design),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (args): Promise<CallToolResult> => {
      const built = buildTopology(args);
      if (!built.ok) return rejected(built.errors);
      const { topology } = built;

      const run = runDesign(topology, DEFAULT_RUN);
      const lines = [describeRun(topology, run, DEFAULT_RUN)];
      try {
        // Said as an instruction because the link is the one part of this
        // the user needs verbatim: it opens the design in their browser,
        // and a model left to summarise tends to drop it.
        lines.push(
          '',
          `Link to the design (give this to the user as is; it opens on breakscale.tech): ${await buildShareUrl(topology, APP_URL)}`,
        );
      } catch (err) {
        if (!(err instanceof ShareLinkTooLargeError)) throw err;
        lines.push(
          '',
          'The design is too large for a link; use export_design to save it as a file.',
        );
      }
      lines.push(
        '',
        'To change it, call create_view again with the whole updated design, keeping the node ids. ' +
          'If the user edits it on the canvas, their version will appear in your context.',
      );
      // Text only. The view rebuilds the topology from the tool's input
      // rather than reading it from here: some hosts (Claude Code) show the
      // model structuredContent INSTEAD of the text, which swapped these
      // numbers for a wall of config.
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'export_design',
    {
      description:
        'Returns a design as the text of a .breakscale file, which the Breakscale app and its VS Code extension can open with Settings, Open a file. Takes the same input as create_view. Write the result to a file ending in .breakscale.',
      inputSchema: z.object(design),
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      const built = buildTopology(args);
      if (!built.ok) return rejected(built.errors);
      return text(buildDesignFile(built.topology, built.name));
    },
  );

  server.registerTool(
    'open_design',
    {
      description:
        'Reads a Breakscale share link (a breakscale.tech URL) and returns the design in it, ready to change and pass to create_view.',
      inputSchema: z.object({ link: z.string().describe('The whole share link') }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ link }): Promise<CallToolResult> => {
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        return text('That is not a URL.', true);
      }
      const result = hasStoredLink(url.search, url.hash)
        ? await fetchStored(url.search, url.hash)
        : await decodeTopology(url.hash);
      if (result.status === 'absent') {
        return text('That link does not carry a Breakscale design.', true);
      }
      if (result.status === 'invalid') return text(result.message, true);
      return text(JSON.stringify(result.topology));
    },
  );

  registerAppResource(
    server,
    'Breakscale view',
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml as string,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );

  return server;
}
