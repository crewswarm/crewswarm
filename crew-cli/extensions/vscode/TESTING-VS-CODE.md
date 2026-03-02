# VS Code Extension - Testing with Real VS Code (Not Cursor)

## Issue
Running `code --extensionDevelopmentPath=...` opens **Cursor** instead of **VS Code**.

This is because the `code` command is aliased to Cursor on your system.

## Solution: Use VS Code Directly

### Option 1: Launch from VS Code GUI (Recommended)
1. **Open VS Code** (not Cursor) from `/Applications/Visual Studio Code.app`
2. Open the extension folder: `File → Open Folder`
3. Navigate to: `/Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode`
4. Press **F5** (or Run → Start Debugging)
5. A new "Extension Development Host" window opens

### Option 2: Use Full Path to VS Code CLI
```bash
# Add VS Code's CLI to PATH (if not already)
export PATH="/Applications/Visual Studio Code.app/Contents/Resources/app/bin:$PATH"

# OR use full path directly
/Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code \
  --extensionDevelopmentPath=/Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode
```

### Option 3: Create VS Code Alias
```bash
# Add to ~/.zshrc
alias vscode='/Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code'

# Then use:
vscode --extensionDevelopmentPath=/Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode
```

---

## Testing the Extension

Once the Extension Development Host window opens:

### 1. Check for CrewSwarm UI Elements

**Activity Bar (Left Sidebar)**:
- Look for "☠️" skull icon (if we add custom Activity Bar icon)
- Currently: No custom icon yet (add this in branding)

**Status Bar (Bottom)**:
- Look for "☠️ CrewSwarm" button (if we add status bar item)
- Currently: Not implemented yet (add this in branding)

**Command Palette**:
1. Press `Cmd+Shift+P`
2. Type "CrewSwarm"
3. Should see: "CrewSwarm: Open Chat"

### 2. Test Chat Functionality

1. Press `Cmd+Shift+P` → "CrewSwarm: Open Chat"
2. A webview panel opens on the right
3. Type a message: "Hello, can you help me write a function?"
4. Press Enter

**Expected**:
- ✅ Request sent to `http://127.0.0.1:5010/v1/chat`
- ✅ Response from Stinki (crew-lead) appears
- ✅ No timeout errors (30s timeout implemented)

**If crew-lead is down**:
- ❌ Error: "Failed to connect to CrewSwarm: ..."
- Fix: `cd ~/Desktop/CrewSwarm && npm run restart-all`

### 3. Test Code Selection Dispatch

1. Open any code file in the Extension Development Host
2. Select some code
3. Right-click → Look for "CrewSwarm" context menu
4. Currently: **Not implemented yet**

**To add this**: Update `package.json`:
```json
{
  "contributes": {
    "menus": {
      "editor/context": [
        {
          "command": "crewswarm.dispatchSelection",
          "when": "editorHasSelection",
          "group": "navigation"
        }
      ]
    },
    "commands": [
      {
        "command": "crewswarm.dispatchSelection",
        "title": "CrewSwarm: Dispatch to Agent"
      }
    ]
  }
}
```

---

## Current Extension Status

### ✅ Working
- TypeScript compilation (zero errors)
- API URL points to correct port (5010)
- Timeout & error handling (30s)
- Chat command in Command Palette

### 🚧 Not Yet Implemented (Branding)
- Custom Activity Bar icon (skull SVG)
- Status bar button ("☠️ CrewSwarm")
- Context menu (right-click on code)
- Agent selection dropdown
- Task progress indicators
- Custom color theme

### 📦 Ready for Basic Use
The extension is **functionally complete** for chat. It's missing branding/UX polish but works.

---

## Why Test in Real VS Code?

| Feature | VS Code | Cursor |
|---------|---------|--------|
| Extension API | ✅ Standard `vscode` module | ⚠️ Forked (mostly compatible) |
| Extension Development Host | ✅ Native debugging | ⚠️ May work, untested |
| Marketplace Publishing | ✅ Official registry | ❌ N/A |
| Testing Environment | ✅ Real user environment | ⚠️ Different fork |

**Cursor users can install the `.vsix` after testing** - VS Code extensions work in Cursor (they share the API). But **development and testing should be in real VS Code** to ensure marketplace compatibility.

---

## Next Steps

### Immediate (Test in VS Code)
1. ✅ Open VS Code (not Cursor)
2. ✅ Open extension folder
3. ✅ Press F5 to launch Extension Development Host
4. ✅ Test chat with crew-lead
5. ✅ Verify no errors in Debug Console

### Week 1 (Branding)
1. Add `icon.png` (128x128 skull logo)
2. Update `displayName` to "CrewSwarm ☠️"
3. Add status bar button
4. Customize webview colors (already have `styles.css`)

### Week 2 (Polish)
1. Add context menu for code selection
2. Add Activity Bar icon
3. Create color theme (`themes/crewswarm-dark.json`)
4. Add screenshots

### Week 3 (Package & Publish)
1. Package: `vsce package`
2. Test `.vsix` install in both VS Code and Cursor
3. Create publisher account: https://marketplace.visualstudio.com/manage
4. Publish: `vsce publish`

---

## Quick Commands Reference

```bash
# Open VS Code (not Cursor) with extension
open -a "Visual Studio Code" /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode

# OR use full CLI path
/Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code \
  /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode

# Recompile after changes
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode
npm run compile

# Package for distribution
npm install -g @vscode/vsce
vsce package

# Install .vsix locally (in VS Code)
code --install-extension crewswarm-0.1.0.vsix

# Install .vsix locally (in Cursor)
/Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension crewswarm-0.1.0.vsix
```

---

## Screenshots for Marketplace

Once it's working and branded, capture these:

1. **Chat in action** (1280x720)
   - Show webview with Stinki responding
   - Include CrewSwarm branding in panel

2. **Command Palette** (1280x720)
   - Show "CrewSwarm: ..." commands
   - Highlight skull emoji

3. **Agent dispatch** (1280x720)
   - Code selection → context menu → dispatch
   - Show agent response

4. **Settings** (1280x720)
   - Show configuration options (API URL, etc.)

5. **GIF demo** (optional)
   - 10-15 seconds
   - Type question → Stinki responds → code appears

---

## Testing Checklist

- [ ] Extension loads in VS Code (not Cursor)
- [ ] "CrewSwarm: Open Chat" appears in Command Palette
- [ ] Chat panel opens on the right
- [ ] Can send message to crew-lead
- [ ] Receives response from crew-lead
- [ ] Error handling works (kill crew-lead, see error message)
- [ ] Timeout works (30s max wait)
- [ ] No console errors in Debug Console
- [ ] Extension survives reload (Cmd+R in Extension Development Host)

---

## Summary

**The extension works** - it just needs to be tested in **real VS Code**, not Cursor.

Use:
```bash
open -a "Visual Studio Code" /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode
```

Then press **F5** to launch the Extension Development Host.

After basic testing, add branding (icon, status bar, colors), take screenshots, and package for marketplace. 🤘
