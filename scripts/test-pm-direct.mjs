#!/usr/bin/env node
/**
 * TEST PM PROMPT DIRECTLY WITH GROQ/CLAUDE
 * 
 * This tests if the PM prompt even works, bypassing OpenClaw Gateway entirely
 */

import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';

const SYSTEM_PROMPT = `You output dispatch plans as JSON. Nothing else.

Input: Create /tmp/test.txt with 'hello'
Output:
{"op_id":"op-001","summary":"Create test file","dispatch":[{"agent":"crew-coder","task":"Create /tmp/test.txt with content 'hello'. Use write tool.","acceptance":"File exists with correct content"}]}

Input: Fix login bug and add tests
Output:
{"op_id":"op-002","summary":"Fix login + tests","dispatch":[{"agent":"crew-fixer","task":"Debug src/auth/login.ts. Fix password validation.","acceptance":"Login works"},{"agent":"crew-qa","task":"Test login with valid and invalid credentials.","acceptance":"All tests pass"}]}

Agents: crew-coder, crew-qa, crew-fixer, security

Rules:
1. Output valid JSON starting with { and ending with }
2. At least 1 task in dispatch array
3. No other text

Now output your dispatch JSON:`;

const USER_MESSAGE = "Create /tmp/test-$(date +%s).txt with 'hello world'";

async function testWithGroq() {
  console.log('\n🧪 Testing with Groq Llama 3.3 70B...\n');
  
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_MESSAGE }
      ],
      temperature: 0.1,
      max_tokens: 500,
    });
    
    const response = completion.choices[0]?.message?.content || '';
    console.log('✅ Groq Response:');
    console.log(response);
    console.log('\n📊 Can we parse it as JSON?');
    
    try {
      const parsed = JSON.parse(response);
      console.log('✅ Valid JSON!');
      console.log(JSON.stringify(parsed, null, 2));
      return true;
    } catch (e) {
      console.log(`❌ Not valid JSON: ${e.message}`);
      return false;
    }
  } catch (error) {
    console.error('❌ Groq API Error:', error.message);
    return false;
  }
}

async function testWithClaude() {
  console.log('\n🧪 Testing with Claude Haiku 4.5...\n');
  
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: USER_MESSAGE }
      ],
    });
    
    const response = message.content[0]?.text || '';
    console.log('✅ Claude Response:');
    console.log(response);
    console.log('\n📊 Can we parse it as JSON?');
    
    try {
      const parsed = JSON.parse(response);
      console.log('✅ Valid JSON!');
      console.log(JSON.stringify(parsed, null, 2));
      return true;
    } catch (e) {
      console.log(`❌ Not valid JSON: ${e.message}`);
      return false;
    }
  } catch (error) {
    console.error('❌ Claude API Error:', error.message);
    return false;
  }
}

async function testWithFunctionCalling() {
  console.log('\n🧪 Testing with Groq + Function Calling (Swarm Pattern)...\n');
  
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  
  const FUNCTION_PROMPT = `You are a project planner. Analyze the user's request and decide which agents should work on it.

Available agents:
- crew-coder: Implements code, creates files
- crew-qa: Writes tests, validates functionality
- crew-fixer: Debugs and fixes bugs
- security: Audits code for vulnerabilities

When given a task, use the dispatch_task function to assign work to agents.`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: FUNCTION_PROMPT },
        { role: 'user', content: USER_MESSAGE }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'dispatch_task',
            description: 'Dispatch a task to a specialized agent',
            parameters: {
              type: 'object',
              properties: {
                agent: {
                  type: 'string',
                  enum: ['crew-coder', 'crew-qa', 'crew-fixer', 'security'],
                  description: 'The agent to assign this task to'
                },
                task: {
                  type: 'string',
                  description: 'Clear, atomic instruction for the agent'
                },
                acceptance: {
                  type: 'string',
                  description: 'Success criteria for this task'
                }
              },
              required: ['agent', 'task', 'acceptance']
            }
          }
        }
      ],
      tool_choice: 'auto',
      temperature: 0.1,
    });
    
    const response = completion.choices[0];
    console.log('✅ Groq Response (with tools):');
    console.log(JSON.stringify(response.message, null, 2));
    
    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
      console.log('\n✅ Model called dispatch_task!');
      return true;
    } else {
      console.log('\n❌ Model did not call any tools');
      return false;
    }
  } catch (error) {
    console.error('❌ Function calling test failed:', error.message);
    return false;
  }
}

// Run all tests
(async () => {
  console.log('🚀 Testing PM Prompt Direct to LLM\n');
  console.log('━'.repeat(60));
  
  const groqWorked = await testWithGroq();
  console.log('\n' + '━'.repeat(60));
  
  const claudeWorked = await testWithClaude();
  console.log('\n' + '━'.repeat(60));
  
  const functionCallingWorked = await testWithFunctionCalling();
  console.log('\n' + '━'.repeat(60));
  
  console.log('\n📊 RESULTS:');
  console.log(`  Groq JSON-only:        ${groqWorked ? '✅ WORKS' : '❌ FAILS'}`);
  console.log(`  Claude JSON-only:      ${claudeWorked ? '✅ WORKS' : '❌ FAILS'}`);
  console.log(`  Function calling:      ${functionCallingWorked ? '✅ WORKS' : '❌ FAILS'}`);
  
  console.log('\n💡 RECOMMENDATION:');
  if (functionCallingWorked) {
    console.log('  Use function calling pattern (OpenAI Swarm style)');
  } else if (groqWorked || claudeWorked) {
    console.log('  JSON-only prompt works - issue is in gateway-bridge');
  } else {
    console.log('  Prompt is fundamentally broken - needs redesign');
  }
})();

