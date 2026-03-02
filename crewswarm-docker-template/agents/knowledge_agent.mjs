#!/usr/bin/env node
/**
 * Knowledge Agent - Agentic RAG example
 * Answers questions using semantic search over a vector database
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'docs');

// Sample knowledge base
const SAMPLE_DOCS = [
    {
        id: 'intro',
        title: 'What is CrewSwarm?',
        content: `CrewSwarm is a multi-agent orchestration platform for building, deploying, and managing AI agent systems. 
        It provides a runtime for coordinating multiple specialist agents (coders, QA, PM, security, etc.) 
        that collaborate on complex tasks via a real-time message bus.`
    },
    {
        id: 'architecture',
        title: 'CrewSwarm Architecture',
        content: `CrewSwarm consists of three main layers:
        1. Dashboard (port 4319) - Web UI for monitoring and control
        2. crew-lead (port 5010) - Chat coordinator and task dispatcher
        3. Gateway Bridge - Agent daemons that execute tasks
        4. RT Bus (port 18889) - WebSocket message bus for inter-agent communication
        All state is persisted in PostgreSQL and shared memory.`
    },
    {
        id: 'deployment',
        title: 'How to Deploy CrewSwarm',
        content: `Deploy CrewSwarm using Docker:
        1. Clone the template repo
        2. Add API keys to .env
        3. Run: docker compose up -d --build
        4. Access dashboard at http://localhost:4319
        The system includes sample agents for knowledge, MCP tools, and general assistance.`
    },
    {
        id: 'agents',
        title: 'Adding Custom Agents',
        content: `To add your own agent:
        1. Create agents/my_agent.mjs
        2. Define the agent with model, tools, and instructions
        3. Register in app/main.mjs
        4. Rebuild with: docker compose up -d --build
        Agents can use any model provider (OpenAI, Groq, Anthropic, etc.)`
    }
];

// Simplified in-memory vector store for demo
class SimpleVectorStore {
    constructor() {
        this.docs = [];
    }

    async add(doc) {
        this.docs.push(doc);
    }

    async search(query, limit = 3) {
        // Simple keyword matching for demo
        const lowerQuery = query.toLowerCase();
        const results = this.docs
            .map(doc => {
                const titleMatch = doc.title.toLowerCase().includes(lowerQuery);
                const contentMatch = doc.content.toLowerCase().includes(lowerQuery);
                const score = (titleMatch ? 2 : 0) + (contentMatch ? 1 : 0);
                return { doc, score };
            })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(r => r.doc);
        
        return results;
    }

    async list() {
        return this.docs;
    }
}

const vectorStore = new SimpleVectorStore();

// Load documents
async function loadDocuments() {
    console.log('[knowledge-agent] Loading sample documents...');
    
    for (const doc of SAMPLE_DOCS) {
        await vectorStore.add(doc);
        console.log(`[knowledge-agent] Loaded: ${doc.title}`);
    }
    
    // Load any additional documents from data/docs/
    if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt') || f.endsWith('.md'));
        for (const file of files) {
            const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
            await vectorStore.add({
                id: file,
                title: file,
                content
            });
            console.log(`[knowledge-agent] Loaded: ${file}`);
        }
    }
    
    console.log(`[knowledge-agent] ✓ Loaded ${vectorStore.docs.length} documents`);
}

// Agent definition
export const knowledgeAgent = {
    id: 'knowledge-agent',
    name: 'Knowledge Agent',
    model: process.env.OPENAI_API_KEY ? 'openai/gpt-4o-mini' : 'groq/llama-3.3-70b-versatile',
    instructions: `You are a knowledge agent with access to a document database.
    
When answering questions:
1. Search the knowledge base for relevant context
2. Cite specific documents you reference
3. If information isn't in the knowledge base, say so clearly
4. Be concise but thorough

Available commands:
- "What documents do you have?" - List all documents
- "Search for X" - Find documents about X`,

    async handleMessage(message, context = {}) {
        const lowerMsg = message.toLowerCase();
        
        // List command
        if (lowerMsg.includes('what documents') || lowerMsg.includes('list documents')) {
            const docs = await vectorStore.list();
            const list = docs.map(d => `- ${d.title}`).join('\n');
            return {
                content: `I have access to ${docs.length} documents:\n\n${list}\n\nAsk me anything about these topics!`,
                sources: []
            };
        }
        
        // Search and answer
        const results = await vectorStore.search(message);
        
        if (results.length === 0) {
            return {
                content: "I couldn't find relevant information in my knowledge base about that topic. Try asking about CrewSwarm architecture, deployment, or adding agents.",
                sources: []
            };
        }
        
        // Build context from results
        const contextText = results.map(r => `[${r.title}]\n${r.content}`).join('\n\n---\n\n');
        const sources = results.map(r => ({ id: r.id, title: r.title }));
        
        // In a real implementation, this would call an LLM with the context
        // For demo, we'll return the most relevant document
        const answer = results[0].content;
        
        return {
            content: `Based on the documentation:\n\n${answer}\n\nSources: ${sources.map(s => s.title).join(', ')}`,
            sources
        };
    }
};

// CLI interface
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const command = process.argv[2];
    
    if (command === '--load') {
        await loadDocuments();
    } else {
        console.log('Knowledge Agent CLI');
        console.log('Usage: node knowledge_agent.mjs --load');
    }
}

// Initialize on import
await loadDocuments();
