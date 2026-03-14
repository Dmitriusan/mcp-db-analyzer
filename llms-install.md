# Install mcp-db-analyzer via Cline

Run in Cline terminal:

```bash
npx -y mcp-db-analyzer
```

# Configuration

| Env var | Default | Description |
|---|---|---|
| `DATABASE_URL` | (required) | Connection string — `postgresql://user:pass@host/db`, `mysql://...`, or `sqlite:///path/to/db.sqlite` |

Add to your MCP client config:

```json
{
  "mcpServers": {
    "db-analyzer": {
      "command": "npx",
      "args": ["-y", "mcp-db-analyzer"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@localhost:5432/mydb"
      }
    }
  }
}
```

The server is read-only — it does not execute writes or schema changes.
