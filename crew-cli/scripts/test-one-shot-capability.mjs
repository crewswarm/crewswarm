#!/usr/bin/env node
/**
 * Test if L3 Executor can handle a HIGH complexity unit in one shot
 * 
 * Testing Unit 6: Webview JavaScript with message bridge
 */

const UNIT_6_TASK = `Implement webview JavaScript for message bridge and UI interactions (chat.js)

Requirements:
- Message bridge between extension and webview (postMessage/onMessage)
- Event handling for chat input, send button, action buttons
- Display chat messages in transcript
- Handle streaming responses
- Show action cards (patches, files, commands)
- Preview and Apply button handlers
- Connection status indicator

Dependencies: Requires chat.html structure and styles.css

Output: Complete production-ready chat.js file with:
- Error handling
- TypeScript JSDoc types in comments
- Clean event listener setup
- Proper DOM manipulation
- Message queueing if needed`;

async function testHighComplexityUnit() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   TEST: Can L3 Execute HIGH Complexity Unit in One Shot?    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Testing Unit 6 (HIGH complexity):');
  console.log('  - Webview message bridge');
  console.log('  - Multiple event handlers');
  console.log('  - Chat UI interactions');
  console.log('  - Action card rendering\n');

  const startTime = Date.now();

  try {
    const key = process.env.XAI_API_KEY;
    if (!key) throw new Error('XAI_API_KEY not set');

    console.log('📤 Sending to Grok (grok-4-1-fast-reasoning)...\n');

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'grok-4-1-fast-reasoning',
        messages: [{
          role: 'system',
          content: 'You are a frontend specialist. Generate complete, production-ready code files.'
        }, {
          role: 'user',
          content: UNIT_6_TASK
        }],
        temperature: 0.7,
        max_tokens: 4000
      })
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.text();
      console.log(`❌ FAILED (${elapsed}ms): ${error.substring(0, 200)}`);
      return;
    }

    const data = await response.json();
    const code = data.choices[0].message.content;

    console.log(`✅ SUCCESS (${(elapsed/1000).toFixed(1)}s)\n`);
    console.log(`Tokens: ${data.usage.prompt_tokens}→${data.usage.completion_tokens}`);
    
    const cost = (data.usage.prompt_tokens / 1000000) * 0.20 + (data.usage.completion_tokens / 1000000) * 0.50;
    console.log(`Cost: $${cost.toFixed(6)}\n`);

    // Analyze the generated code
    console.log('═'.repeat(70));
    console.log('CODE QUALITY ANALYSIS');
    console.log('═'.repeat(70));
    console.log('');

    const lines = code.split('\n').length;
    console.log(`Lines of code: ${lines}`);

    // Check for required features
    const checks = {
      'Has postMessage': /postMessage|window\.parent\.postMessage/i.test(code),
      'Has message listener': /addEventListener.*message|onmessage/i.test(code),
      'Has event handlers': /addEventListener|onclick|onsubmit/i.test(code),
      'Has error handling': /try|catch|throw|Error/i.test(code),
      'Has DOM manipulation': /document\.|getElementById|querySelector/i.test(code),
      'Has comments/docs': /\/\/|\/\*/i.test(code),
      'Has action buttons': /apply|preview|action/i.test(code),
      'Shows chat messages': /message|chat|append|display/i.test(code)
    };

    let score = 0;
    Object.entries(checks).forEach(([name, passed]) => {
      console.log(`  ${passed ? '✅' : '❌'} ${name}`);
      if (passed) score += 12.5;
    });

    console.log(`\nQuality Score: ${score}/100\n`);

    // Show code sample
    console.log('═'.repeat(70));
    console.log('CODE SAMPLE (first 1000 chars)');
    console.log('═'.repeat(70));
    console.log('');
    console.log(code.substring(0, 1000));
    if (code.length > 1000) console.log('...\n');

    // Verdict
    console.log('═'.repeat(70));
    console.log('VERDICT');
    console.log('═'.repeat(70));
    console.log('');

    if (score >= 75) {
      console.log('✅ ONE-SHOT CAPABLE');
      console.log('   Grok handled the HIGH complexity unit in one shot!');
      console.log(`   ${lines} lines of code with all required features.`);
      console.log(`   Time: ${(elapsed/1000).toFixed(1)}s | Cost: $${cost.toFixed(6)}`);
    } else if (score >= 50) {
      console.log('⚠️  PARTIAL SUCCESS');
      console.log('   Grok generated code but missing some features.');
      console.log('   May need refinement or breakdown into smaller units.');
    } else {
      console.log('❌ NEEDS BREAKDOWN');
      console.log('   Code quality too low for one-shot execution.');
      console.log('   Should split into smaller work units.');
    }

    console.log('\n✅ TEST COMPLETE\n');

  } catch (err) {
    console.error('❌ ERROR:', err.message);
  }
}

testHighComplexityUnit().catch(console.error);
