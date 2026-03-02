/**
 * MCP Agent - Tool use example
 * Connects to external services via Model Context Protocol
 */

export const mcpAgent = {
    id: 'mcp-agent',
    name: 'MCP Agent',
    model: process.env.OPENAI_API_KEY ? 'openai/gpt-4o-mini' : 'groq/llama-3.3-70b-versatile',
    instructions: `You are an MCP agent with access to external tools via the Model Context Protocol.

You can:
- Search documentation and web resources
- Fetch content from URLs
- Access file systems (within allowed paths)
- Call external APIs

When asked about your capabilities, list the tools you have access to.
When using tools, explain what you're doing and what results you found.`,

    tools: [
        // Placeholder for MCP tools
        // In production, these would be loaded from MCP server configs
    ],

    async handleMessage(message, context = {}) {
        const lowerMsg = message.toLowerCase();
        
        // List tools
        if (lowerMsg.includes('what tools') || lowerMsg.includes('capabilities')) {
            return {
                content: `I have access to the following MCP tools:

**Documentation Search**
- Search CrewSwarm docs
- Search Agno docs
- Search general web resources

**Content Fetching**
- Fetch URL content
- Extract structured data
- Process documents

**File Operations** (within allowed paths)
- Read files
- List directories
- Search file contents

Ask me to use any of these tools to help you!`,
                tools: []
            };
        }
        
        // Search docs
        if (lowerMsg.includes('search') && (lowerMsg.includes('docs') || lowerMsg.includes('documentation'))) {
            return {
                content: `I would search the documentation for: "${message}"

In production, this would:
1. Connect to the CrewSwarm/Agno MCP server
2. Execute a documentation search
3. Return relevant results with citations

To enable full MCP functionality, configure MCP servers in your deployment.`,
                tools: ['mcp:search_docs']
            };
        }
        
        // Find examples
        if (lowerMsg.includes('example') || lowerMsg.includes('how to')) {
            return {
                content: `Looking for examples...

In production, this would:
1. Search code repositories via MCP
2. Find relevant examples
3. Extract and format code snippets

Example MCP setup:
\`\`\`json
{
  "mcpServers": {
    "crewswarm": {
      "url": "http://localhost:5020/mcp"
    }
  }
}
\`\`\`

Add MCP server configs to enable full tool functionality.`,
                tools: ['mcp:search_examples']
            };
        }
        
        return {
            content: `I'm an MCP agent that can connect to external tools and services.

Try asking me:
- "What tools do you have?"
- "Search the docs for X"
- "Find examples of Y"
- "Fetch content from URL"

To enable full functionality, configure MCP servers in your CrewSwarm deployment.`,
            tools: []
        };
    }
};
