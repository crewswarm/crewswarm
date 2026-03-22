#!/usr/bin/env node
/**
 * Ollama Local LLM Integration
 * Tests local models (Llama, Qwen, etc.) via Ollama
 */

async function testOllamaAvailability() {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    if (!response.ok) throw new Error('Ollama not responding');
    
    const data = await response.json();
    return {
      available: true,
      models: data.models || []
    };
  } catch (err) {
    return {
      available: false,
      error: err.message
    };
  }
}

async function callOllama(model, prompt, options = {}) {
  const requestBody = {
    model,
    prompt,
    stream: false,
    options: {
      temperature: options.temperature || 0.7,
      num_predict: options.maxTokens || 2000,
      ...options
    }
  };
  
  const startTime = Date.now();
  
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      throw new Error(`Ollama error: ${response.statusText}`);
    }
    
    const data = await response.json();
    const timeMs = Date.now() - startTime;
    
    return {
      success: true,
      result: data.response,
      model: data.model,
      tokenCount: {
        prompt: data.prompt_eval_count || 0,
        completion: data.eval_count || 0,
        total: (data.prompt_eval_count || 0) + (data.eval_count || 0)
      },
      timeMs,
      cost: 0 // Local models are free!
    };
  } catch (err) {
    return {
      success: false,
      result: err.message,
      timeMs: Date.now() - startTime,
      cost: 0
    };
  }
}

// Recommended local models for each tier
const OLLAMA_MODELS = {
  chat: [
    'llama3.2:3b',      // Fast, good for chat
    'qwen2.5:7b',       // Balanced
    'gemma2:9b'         // Google's model
  ],
  reasoning: [
    'qwen2.5:32b',      // Best reasoning
    'llama3.1:70b',     // Large, slow but smart
    'deepseek-r1:7b'    // DeepSeek's reasoning model
  ],
  execution: [
    'qwen2.5-coder:7b', // Best for code
    'codellama:13b',    // Meta's code model
    'llama3.2:3b'       // Fast fallback
  ]
};

async function benchmarkOllama() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           OLLAMA LOCAL LLM BENCHMARK                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  // Check Ollama availability
  console.log('🔍 Checking Ollama installation...');
  const status = await testOllamaAvailability();
  
  if (!status.available) {
    console.log('\n❌ Ollama not available');
    console.log('   Error:', status.error);
    console.log('\n   Install Ollama: https://ollama.ai/download');
    console.log('   Then run: ollama serve');
    console.log('   Pull models: ollama pull llama3.2');
    return;
  }
  
  console.log('✅ Ollama is running');
  console.log('\nInstalled models:');
  status.models.forEach((m) => {
    console.log(`  • ${m.name} (${(m.size / 1e9).toFixed(1)}GB)`);
  });
  
  // Test each recommended model
  console.log('\n\n📊 BENCHMARKING MODELS\n');
  
  const testPrompts = {
    simple: 'Explain what a JWT token is in one sentence.',
    medium: 'Write a Python function to validate JWT tokens with error handling.',
    complex: 'Design a REST API authentication system architecture with JWT, including database schema and security considerations.'
  };
  
  for (const [tier, models] of Object.entries(OLLAMA_MODELS)) {
    console.log(`\n${'='.repeat(66)}`);
    console.log(`Tier: ${tier.toUpperCase()}`);
    console.log('='.repeat(66));
    
    for (const model of models) {
      // Check if model is installed
      const installed = status.models.some((m) => m.name.startsWith(model));
      
      if (!installed) {
        console.log(`\n  ⚠️  ${model} - NOT INSTALLED`);
        console.log(`     Run: ollama pull ${model}`);
        continue;
      }
      
      console.log(`\n  🧪 Testing: ${model}`);
      
      // Test with medium complexity prompt
      const result = await callOllama(model, testPrompts.medium);
      
      if (result.success) {
        console.log(`     ✓ Success`);
        console.log(`       Time: ${result.timeMs}ms`);
        console.log(`       Tokens: ${result.tokenCount.prompt} → ${result.tokenCount.completion}`);
        console.log(`       Cost: $0.00 (FREE!)`);
        console.log(`       Response: ${result.result.substring(0, 100)}...`);
        
        // Calculate tokens/second
        const tokensPerSec = (result.tokenCount.completion / (result.timeMs / 1000)).toFixed(1);
        console.log(`       Speed: ${tokensPerSec} tokens/sec`);
      } else {
        console.log(`     ✗ Failed: ${result.result}`);
      }
      
      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Print recommendations
  console.log('\n\n💡 RECOMMENDATIONS FOR OLLAMA\n');
  console.log('Based on typical hardware:');
  console.log('\n  MacBook (8GB RAM):');
  console.log('    Chat: llama3.2:3b');
  console.log('    Reasoning: qwen2.5:7b');
  console.log('    Execution: qwen2.5-coder:7b');
  console.log('\n  Workstation (16GB+ RAM):');
  console.log('    Chat: qwen2.5:7b');
  console.log('    Reasoning: qwen2.5:32b');
  console.log('    Execution: codellama:13b');
  console.log('\n  Server (32GB+ RAM, GPU):');
  console.log('    Chat: llama3.1:70b');
  console.log('    Reasoning: llama3.1:70b');
  console.log('    Execution: qwen2.5-coder:32b');
  
  console.log('\n\n⚙️  CONFIGURE CREWSWARM WITH OLLAMA\n');
  console.log('  export CREW_USE_OLLAMA="true"');
  console.log('  export CREW_OLLAMA_CHAT="llama3.2:3b"');
  console.log('  export CREW_OLLAMA_REASONING="qwen2.5:7b"');
  console.log('  export CREW_OLLAMA_EXECUTION="qwen2.5-coder:7b"');
  console.log('\n  Then run: crew repl');
}

// Export for use in other scripts
export { testOllamaAvailability, callOllama, OLLAMA_MODELS };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  benchmarkOllama().catch(console.error);
}
