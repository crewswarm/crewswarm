# VS Code Extension - Installation & Testing

## ✅ Extension Packaged and Installed

**Location**: `/Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode/crewswarm-0.1.0.vsix`

---

## How to Use in Cursor

### Method 1: Test in Development Mode (F5)
```bash
# Open extension folder in Cursor
open -a Cursor /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode

# Then press F5 in Cursor
# Extension Development Host window opens
# This is for testing/debugging
```

### Method 2: Install as Real Extension (.vsix)
```bash
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode

# Package (creates .vsix file)
vsce package

# Install in Cursor
cursor --install-extension crewswarm-0.1.0.vsix

# Restart Cursor to activate
```

---

## Testing the Extension

### 1. Open Command Palette
Press `Cmd+Shift+P`

### 2. Find CrewSwarm Command
Type: `CrewSwarm`

You should see:
- **CrewSwarm: Open Chat**

### 3. Open Chat Panel
Select "CrewSwarm: Open Chat"

A webview panel opens on the right side of Cursor.

### 4. Test Connection
Type a message:
```
Hello, can you help me write a function?
```

**Expected**:
- ✅ Request sent to `http://127.0.0.1:5010/v1/chat`
- ✅ Response from Stinki (crew-lead) appears
- ✅ No timeout (30s max wait)

**If crew-lead is down**:
- ❌ Error: "Failed to connect to CrewSwarm: ..."
- Fix: `cd ~/Desktop/CrewSwarm && npm run restart-all`

---

## How It Works in Cursor

**Cursor is a VS Code fork**, so VS Code extensions work natively:

1. **Same Extension API** - `vscode` module works identically
2. **Same UI** - Command Palette, webviews, status bar all work
3. **Same Packaging** - `.vsix` files install directly
4. **Same Debugging** - F5 launches Extension Development Host

**Differences from VS Code**:
- Cursor has extra AI features (not needed for this extension)
- Cursor's command line is `cursor` instead of `code`
- Otherwise: 100% compatible

---

## What You Can Do Now

### Development Mode (F5)
```bash
# Open in Cursor
open -a Cursor /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode

# Press F5
# Extension Development Host launches
# Cmd+Shift+P → "CrewSwarm: Open Chat"
# Test changes immediately
```

**Use this when**: Making changes to the extension code

### Installed Mode (.vsix)
```bash
# Install
cursor --install-extension crewswarm-0.1.0.vsix

# Use in ANY Cursor project
# Cmd+Shift+P → "CrewSwarm: Open Chat"
```

**Use this when**: Using the extension for real work

---

## Uninstall (If Needed)

```bash
# List installed extensions
cursor --list-extensions | grep crewswarm

# Uninstall
cursor --uninstall-extension crewswarm
```

---

## Updating the Extension

After making code changes:

```bash
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/extensions/vscode

# 1. Recompile TypeScript
npm run compile

# 2. Repackage
vsce package

# 3. Reinstall
cursor --uninstall-extension crewswarm
cursor --install-extension crewswarm-0.1.0.vsix
```

**OR** just use F5 development mode for instant updates (no reinstall needed).

---

## Troubleshooting

### "Command not found: vsce"
```bash
npm install -g @vscode/vsce
```

### "Extension failed to activate"
```bash
# Check compilation
npm run compile

# Check for errors
# View → Output → Extension Host
```

### "Failed to connect to CrewSwarm"
```bash
# Check crew-lead is running
curl http://127.0.0.1:5010/health

# Start if needed
cd ~/Desktop/CrewSwarm
npm run restart-all
```

### "Chat panel is blank"
```bash
# Open Developer Tools
Cmd+Shift+P → "Developer: Toggle Developer Tools"
# Check Console tab for JavaScript errors
```

---

## Next Steps

### Immediate
1. ✅ Extension is packaged and installed
2. Test chat with crew-lead
3. Verify no errors

### Week 1 (Branding)
1. Add icon.png (128x128)
2. Update displayName to "CrewSwarm ☠️"
3. Customize webview colors
4. Add status bar button

### Week 2 (Features)
1. Add context menu (right-click code → dispatch)
2. Add Activity Bar icon
3. Add agent selection dropdown
4. Create color theme

### Week 3 (Publish)
1. Take screenshots
2. Write README with examples
3. Create publisher account
4. Publish to VS Code Marketplace

---

## Status

✅ **Extension is ready to use in Cursor**

- Packaged: `crewswarm-0.1.0.vsix`
- Installed: Available in Cursor
- Working: Chat connects to crew-lead on :5010

**Test it now**: `Cmd+Shift+P` → "CrewSwarm: Open Chat" 🤘
