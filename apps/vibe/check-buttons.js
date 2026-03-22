/**
 * Paste this in console RIGHT NOW (while file is open)
 */

console.log('=== BUTTON STATE DEBUG ===\n');

// Check editor state
console.log('1. Editor state:');
console.log('   window.editor:', window.editor ? 'EXISTS' : 'NULL');
console.log('   activeTab:', window.activeTab || 'NULL');
console.log('   monaco:', typeof window.monaco !== 'undefined' ? 'LOADED' : 'NOT LOADED');

// Check each button
console.log('\n2. Button states:');
const buttons = document.querySelectorAll('.editor-toolbar-btn');
buttons.forEach(btn => {
  console.log(`   ${btn.id}:`);
  console.log(`      - disabled: ${btn.disabled}`);
  console.log(`      - title: "${btn.title}"`);
  console.log(`      - visible: ${btn.offsetWidth > 0}`);
  console.log(`      - computed opacity: ${window.getComputedStyle(btn).opacity}`);
  console.log(`      - computed cursor: ${window.getComputedStyle(btn).cursor}`);
});

// Check if updateEditorToolbarState exists
console.log('\n3. Functions available:');
console.log('   updateEditorToolbarState:', typeof window.updateEditorToolbarState);

// FORCE UPDATE
console.log('\n4. Forcing button state update...');
if (window.editor && window.activeTab) {
  // Manually enable buttons (this is what updateEditorToolbarState should do)
  buttons.forEach(btn => {
    btn.disabled = false;
    btn.title = 'Enabled manually';
  });
  console.log('   ✅ All buttons force-enabled');
  console.log('   🎯 Now try hovering - should see blue glow');
} else {
  console.log('   ❌ Cannot enable - editor or activeTab missing');
}
