/**
 * Vibe Button Fix Script
 * 
 * Run this in the browser console (F12) when Vibe is open:
 * 1. Copy this entire file
 * 2. Paste into console
 * 3. Press Enter
 * 
 * This will diagnose and fix common issues.
 */

console.log('🔧 Vibe Diagnostic & Fix Script Starting...\n');

// Check 1: Files in Explorer
const fileTree = document.getElementById('file-tree');
if (!fileTree) {
  console.error('❌ file-tree element not found!');
} else {
  const files = fileTree.querySelectorAll('li');
  console.log(`✅ File tree found: ${files.length} files visible`);
  
  if (files.length === 0) {
    console.warn('⚠️ No files in Explorer - trying to refresh...');
    if (typeof window.loadFileTree === 'function') {
      window.loadFileTree();
    }
  }
}

// Check 2: Editor instance
if (typeof window.editor === 'undefined') {
  console.log('ℹ️ Editor not yet initialized (normal until you open a file)');
} else if (window.editor === null) {
  console.log('ℹ️ Editor is null (will initialize when you open a file)');
} else {
  console.log('✅ Editor is initialized!');
}

// Check 3: Monaco loaded
if (typeof window.monaco === 'undefined') {
  console.error('❌ Monaco not loaded - this is the problem!');
  console.log('   Try refreshing the page (Cmd+R)');
} else {
  console.log('✅ Monaco loaded successfully');
}

// Check 4: Button states
const buttons = document.querySelectorAll('.editor-toolbar-btn');
if (buttons.length === 0) {
  console.error('❌ No toolbar buttons found');
} else {
  console.log(`✅ Found ${buttons.length} toolbar buttons`);
  const disabledCount = Array.from(buttons).filter(b => b.disabled).length;
  console.log(`   ${disabledCount} disabled, ${buttons.length - disabledCount} enabled`);
  
  if (disabledCount === buttons.length) {
    console.log('   ℹ️ All buttons disabled (normal - no file is open yet)');
  }
}

// Check 5: Activity Trace
const terminal = document.getElementById('terminal-content');
if (!terminal) {
  console.error('❌ terminal-content element not found');
} else {
  const lines = terminal.children.length;
  console.log(`✅ Activity Trace found: ${lines} entries`);
  if (lines === 0) {
    console.log('   ℹ️ Terminal empty (will populate when activity happens)');
  } else {
    console.log(`   Last entry: ${terminal.lastElementChild?.textContent?.slice(0, 60)}...`);
  }
}

// FIX: Auto-open first file to enable buttons
console.log('\n🔧 Attempting auto-fix: opening first file...');
const firstFile = fileTree?.querySelector('li[data-path]');
if (firstFile) {
  const filePath = firstFile.dataset.path;
  console.log(`   Opening: ${filePath}`);
  
  // Click the file to trigger opening
  firstFile.click();
  
  setTimeout(() => {
    const enabledCount = Array.from(buttons).filter(b => !b.disabled).length;
    if (enabledCount > 0) {
      console.log(`✅ FIX SUCCESSFUL: ${enabledCount} buttons now enabled!`);
      console.log('   Try hovering over the Find or Replace buttons now.');
    } else {
      console.warn('⚠️ Buttons still disabled - check console for errors');
    }
  }, 1000);
} else {
  console.warn('⚠️ No files found to open');
  console.log('   Try clicking a file in the Explorer manually');
}

console.log('\n📋 Summary:');
console.log('   1. If buttons are still disabled → click any file in Explorer');
console.log('   2. If Explorer is empty → check that files are loading');
console.log('   3. If Monaco failed → refresh the page');
console.log('   4. Hover over enabled buttons to see the blue glow');
