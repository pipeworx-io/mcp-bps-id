# mcp-bps-id

BPS — Badan Pusat Statistik (Statistics Indonesia) WebAPI MCP.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 965+ live data sources.

## Tools

| Tool | Description |
|------|-------------|

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "bps-id": {
      "url": "https://gateway.pipeworx.io/bps-id/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 965+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Bps Id data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/bps_list \
  -H 'Content-Type: application/json' \
  -d '{"model":"subject"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/bps_list`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
