# Breakscale MCP server

This lets an AI assistant work with Breakscale for you. Ask it to draw a rate limiter, or to read your code and turn the architecture into a design, and it builds the design, runs it through the same simulation engine as breakscale.tech, and comes back with real numbers: where the latency goes, what saturates first, what fails and why. It also gives you a breakscale.tech link that opens the design straight in your browser.

In assistants that support [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) the design also opens as a live Breakscale canvas right in the chat. You can press play, drag the traffic up, move things around, and whatever you change goes back to the assistant, so its next edit starts from what you are looking at.

| Tool            | What it does                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------- |
| `read_me`       | The design format, every component and setting, and how real code maps onto components       |
| `create_view`   | Validates a design, simulates 30 seconds of it, and shows it on the canvas                   |
| `export_design` | Returns the design as a `.breakscale` file, which the app and the VS Code extension can open |
| `open_design`   | Reads a breakscale.tech share link back into a design, so you can ask for changes to it      |

## Connect your assistant

All you need is [Node](https://nodejs.org) 20 or newer. Every assistant starts the server the same way, and there is nothing to clone or build:

```
npx -y breakscale-mcp --stdio
```

Which assistants draw the canvas in the chat, according to the [MCP client matrix](https://modelcontextprotocol.io/extensions/client-matrix):

| Canvas in the chat                                  | Numbers and a link only                               |
| --------------------------------------------------- | ----------------------------------------------------- |
| VS Code with Copilot, Cursor, Claude Desktop, Goose | Claude Code, Codex, Gemini CLI, Windsurf / Devin, Zed |

### Claude Code

```bash
claude mcp add --scope user breakscale -- npx -y breakscale-mcp --stdio
```

`--scope user` makes it available in every project, which is what you want for "read my code and turn it into a design". Without it the server is only added for the folder you ran the command in. Run `/mcp` inside Claude Code to check it connected, and `claude mcp remove breakscale --scope user` to take it out again.

To share it with everyone working in one repo instead, put this in `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "breakscale": {
      "command": "npx",
      "args": ["-y", "breakscale-mcp", "--stdio"]
    }
  }
}
```

### VS Code with GitHub Copilot

From a terminal:

```bash
code --add-mcp '{"name":"breakscale","type":"stdio","command":"npx","args":["-y","breakscale-mcp","--stdio"]}'
```

Or run **MCP: Add Server** from the command palette, choose a command (stdio) server, enter `npx -y breakscale-mcp --stdio`, and pick Global to have it everywhere. For one workspace only, put this in `.vscode/mcp.json` (the key is `servers`, not `mcpServers`):

```json
{
  "servers": {
    "breakscale": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "breakscale-mcp", "--stdio"]
    }
  }
}
```

Then ask in Copilot Chat in agent mode. The canvas appears inline when the setting `chat.mcp.apps.enabled` is on.

### Cursor

Put this in `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "breakscale": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "breakscale-mcp", "--stdio"]
    }
  }
}
```

### Claude Desktop

Open **Settings > Developer > Edit Config**, add the server, and restart the app completely:

```json
{
  "mcpServers": {
    "breakscale": {
      "command": "npx",
      "args": ["-y", "breakscale-mcp", "--stdio"]
    }
  }
}
```

### Codex CLI

```bash
codex mcp add breakscale -- npx -y breakscale-mcp --stdio
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.breakscale]
command = "npx"
args = ["-y", "breakscale-mcp", "--stdio"]
```

### Gemini CLI

In `~/.gemini/settings.json`, or `.gemini/settings.json` for one project:

```json
{
  "mcpServers": {
    "breakscale": {
      "command": "npx",
      "args": ["-y", "breakscale-mcp", "--stdio"]
    }
  }
}
```

### Windsurf / Devin Desktop

```bash
devin mcp add -s user breakscale -- npx -y breakscale-mcp --stdio
```

Or open the MCP config file from the Cascade panel's menu and add the same `mcpServers` block as Claude Desktop's.

### Goose

Extensions > Add custom extension, type Standard IO, command `npx -y breakscale-mcp --stdio`. In the CLI, `goose configure` > Add Extension > Command-line Extension.

### Zed

In `settings.json`, or Settings > AI > MCP Servers > Add Local Server:

```json
{
  "context_servers": {
    "breakscale": {
      "command": "npx",
      "args": ["-y", "breakscale-mcp", "--stdio"],
      "env": {}
    }
  }
}
```

### Anything else

Anything that speaks MCP can run `npx -y breakscale-mcp --stdio`. Without `--stdio` it serves Streamable HTTP at `http://localhost:3001/mcp` instead: `PORT` changes the port, `HOST` the address it binds to, and `ALLOWED_HOSTS` adds hostnames it will answer to besides localhost.

## Things to try

- "Make a rate limiter diagram in Breakscale."
- "Read this repo and turn its architecture into a Breakscale design. Tell me which numbers you had to guess."
- "Double the traffic. What breaks first?" and then "Fix it without adding more servers."
- Paste a breakscale.tech share link and ask for a change to it.
- "Save it as a .breakscale file."

To open a saved `.breakscale` file, use **Settings > Open a file** on breakscale.tech, or in the VS Code extension after running **Open Breakscale**. Opening the file directly in an editor shows its JSON; the extension does not claim the file type.

## Working on it

You need [Bun](https://bun.sh) to build it from this repo:

```bash
cd mcp
bun install
bun run build
```

That produces `dist/index.js`, one file with the canvas and the engine inside it. Point an assistant at it with `node /path/to/breakscale/mcp/dist/index.js --stdio` in place of the `npx` command to try your changes.

The server imports the engine and the app straight from `../src`, so there is no second copy of anything. `widget/` is the canvas a chat host draws: the whole app, seeded with the design through the same storage shim idea the VS Code panel uses. `bun run typecheck` checks this package, and its tests live in `src/` and run with the rest of the suite from the repo root.

To try the canvas without an assistant, the MCP Apps repo has a small test host: build `examples/basic-host` from [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps), start this server with `node dist/index.js`, and run the host with `SERVERS='["http://localhost:3001/mcp"]'`.
