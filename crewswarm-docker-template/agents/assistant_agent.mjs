/**
 * Assistant Agent - General purpose helper with memory
 */

export const assistantAgent = {
    id: 'assistant-agent',
    name: 'Assistant',
    model: process.env.OPENAI_API_KEY ? 'openai/gpt-4o' : 'groq/llama-3.3-70b-versatile',
    instructions: `You are a helpful assistant with memory and tool access.

You can:
- Answer general questions
- Help with planning and organization
- Remember context from previous conversations
- Use tools to accomplish tasks

Be concise, friendly, and helpful. When you don't know something, say so clearly.`,

    memory: new Map(), // Simple in-memory storage

    async handleMessage(message, context = {}) {
        const userId = context.userId || 'default';
        const sessionId = context.sessionId || 'default';
        const memoryKey = `${userId}:${sessionId}`;
        
        // Retrieve session memory
        if (!this.memory.has(memoryKey)) {
            this.memory.set(memoryKey, []);
        }
        const history = this.memory.get(memoryKey);
        
        // Add user message to history
        history.push({ role: 'user', content: message });
        
        // Keep last 10 messages
        if (history.length > 10) {
            history.splice(0, history.length - 10);
        }
        
        // Generate response
        const lowerMsg = message.toLowerCase();
        let response = '';
        
        if (lowerMsg.includes('hello') || lowerMsg.includes('hi')) {
            response = `Hello! I'm your CrewSwarm assistant. I can help with:

- Planning projects and roadmaps
- Writing documentation
- Answering questions about your work
- Organizing tasks and ideas

I remember our conversation history, so feel free to reference things we've discussed. What would you like help with?`;
        } else if (lowerMsg.includes('help') || lowerMsg.includes('what can you')) {
            response = `I'm here to help! I can:

**Planning & Organization**
- Create project roadmaps
- Break down complex tasks
- Suggest next steps

**Writing & Documentation**
- Draft README files
- Write technical documentation
- Create project descriptions

**Context & Memory**
- Remember our conversation
- Build on previous discussions
- Track project details

**Coordination**
- Suggest which agents to use for specific tasks
- Help orchestrate multi-agent workflows

What would you like to work on?`;
        } else if (lowerMsg.includes('remember') || lowerMsg.includes('previous') || lowerMsg.includes('we discussed')) {
            if (history.length <= 1) {
                response = "This is our first conversation in this session. As we chat, I'll remember what we discuss.";
            } else {
                const summaryPoints = history
                    .slice(0, -1)
                    .filter(m => m.role === 'user')
                    .slice(-3)
                    .map(m => `- ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`);
                response = `Here's what we've discussed recently:\n\n${summaryPoints.join('\n')}\n\nWhat would you like to know about these topics?`;
            }
        } else if (lowerMsg.includes('roadmap') || lowerMsg.includes('plan')) {
            response = `I can help you create a project roadmap!

To get started, tell me:
1. What are you building?
2. What's the main goal or outcome?
3. Any constraints or requirements?

I'll help break it down into phases and suggest which agents can help with each part.`;
        } else if (lowerMsg.includes('readme') || lowerMsg.includes('documentation')) {
            response = `I can help you write documentation!

For a good README, let's cover:
- **What** the project does (one-line summary)
- **Why** it exists (problem it solves)
- **How** to use it (quick start)
- **Who** it's for (target audience)

Tell me about your project and I'll draft a README for you.`;
        } else {
            // Generic helpful response
            response = `I understand you're asking about: "${message}"

I'm a general-purpose assistant in demo mode. In production, I would:
1. Call a language model with full conversation history
2. Use tools to accomplish tasks
3. Coordinate with other agents when needed

For now, try asking me about:
- Creating roadmaps or plans
- Writing documentation
- Reviewing conversation history

How can I help you today?`;
        }
        
        // Add assistant response to history
        history.push({ role: 'assistant', content: response });
        
        return {
            content: response,
            memory: {
                messages: history.length,
                session: sessionId
            }
        };
    }
};
