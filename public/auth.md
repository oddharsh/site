# Authentication

The public machine interfaces of `aadhar.sh` are anonymous and read-only. They
do not issue bearer credentials or unlock private data.

- Site MCP: <https://aadhar.sh/mcp>
- Serendipity MCP: <https://aadhar.sh/serendipity/mcp>
- Discovery card: <https://aadhar.sh/.well-known/agent-card.json>
- API catalog: <https://aadhar.sh/.well-known/api-catalog>

The only authenticated operations are private owner workflows such as coffee
approval. Those capabilities are not agent APIs and are not advertised here.
