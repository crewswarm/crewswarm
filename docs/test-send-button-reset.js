/* 
 * Test: Send Button State Reset
 * 
 * This verifies the send button properly resets to "Send" state
 * when switching between engines/models.
 */

// Test in browser console:
// 1. Open dashboard at http://127.0.0.1:4319
// 2. Open console (F12)
// 3. Paste this code and run

console.log('🧪 Testing Send Button State Reset...');

const sendBtn = document.querySelector('[data-action="sendChat"]');
const engineSel = document.getElementById('passthroughEngine');
const modelSel = document.getElementById('passthroughModel');

if (!sendBtn) {
  console.error('❌ Send button not found!');
} else {
  console.log('✅ Send button found:', sendBtn);
  console.log('   Current text:', sendBtn.textContent);
  console.log('   Current class:', sendBtn.className);
}

if (!engineSel) {
  console.error('❌ Engine selector not found!');
} else {
  console.log('✅ Engine selector found');
  console.log('   Current value:', engineSel.value);
  
  // Test: Change engine and check button resets
  console.log('\n🧪 Test: Changing engine...');
  const originalEngine = engineSel.value;
  
  // Simulate the button being stuck in "Stop" state
  sendBtn.textContent = '⏹ Stop';
  sendBtn.className = 'btn-red';
  console.log('   Set button to Stop state');
  
  // Change engine (should trigger reset)
  engineSel.value = originalEngine === '' ? 'codex' : '';
  engineSel.dispatchEvent(new Event('change'));
  
  setTimeout(() => {
    console.log('   After engine change:');
    console.log('   Button text:', sendBtn.textContent);
    console.log('   Button class:', sendBtn.className);
    
    if (sendBtn.textContent === 'Send' && sendBtn.className.includes('btn-green')) {
      console.log('✅ TEST PASSED - Button reset correctly!');
    } else {
      console.log('❌ TEST FAILED - Button did not reset');
      console.log('   Expected: "Send" with btn-green');
      console.log('   Got:', sendBtn.textContent, sendBtn.className);
    }
    
    // Restore original engine
    engineSel.value = originalEngine;
    engineSel.dispatchEvent(new Event('change'));
  }, 100);
}

console.log('\n💡 If test fails, hard refresh (Cmd+Shift+R) to clear cache');
