# VS Code Extension Branding Guide

## What You Can Customize

VS Code extensions support extensive branding capabilities:

### 1. Extension Icon ✅
**Size**: 128x128 PNG  
**Location**: `icon.png` in root directory  
**Usage**: Shows in Extensions panel, marketplace, and Extension Development Host

```json
// package.json
{
  "icon": "icon.png"
}
```

**Recommendation**: Use CrewSwarm skull logo on dark background.

---

### 2. Extension Colors (Custom Theme) ✅
You can define a complete color theme that applies when the extension is active.

**Location**: Create `themes/crewswarm-dark.json`

```json
{
  "name": "CrewSwarm Dark",
  "type": "dark",
  "colors": {
    "activityBar.background": "#1a1a1a",
    "activityBar.foreground": "#38bdf8",
    "statusBar.background": "#0a0a0a",
    "statusBar.foreground": "#38bdf8",
    "editor.background": "#0d1117",
    "editor.foreground": "#e6edf3",
    "sideBar.background": "#0d1117",
    "panel.background": "#0d1117",
    "terminal.background": "#0d1117"
  },
  "tokenColors": [
    {
      "scope": ["comment"],
      "settings": { "foreground": "#6e7681", "fontStyle": "italic" }
    },
    {
      "scope": ["keyword", "storage"],
      "settings": { "foreground": "#ff7b72" }
    },
    {
      "scope": ["string"],
      "settings": { "foreground": "#a5d6ff" }
    },
    {
      "scope": ["function"],
      "settings": { "foreground": "#d2a8ff" }
    }
  ]
}
```

**Register in `package.json`**:
```json
{
  "contributes": {
    "themes": [
      {
        "label": "CrewSwarm Dark",
        "uiTheme": "vs-dark",
        "path": "./themes/crewswarm-dark.json"
      }
    ]
  }
}
```

---

### 3. Custom Webview Branding ✅
The chat panel can be fully branded with custom HTML/CSS.

**Already exists**: `src/webview/chat.html` and `src/webview/styles.css`

**Customize**:
```css
/* src/webview/styles.css */
:root {
  --crewswarm-primary: #38bdf8;      /* Sky blue */
  --crewswarm-secondary: #8b5cf6;    /* Purple */
  --crewswarm-accent: #f97316;       /* Orange */
  --crewswarm-dark: #0a0a0a;
  --crewswarm-bg: #0d1117;
}

body {
  background: var(--crewswarm-bg);
  color: #e6edf3;
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
}

.chat-message.assistant {
  background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
  border-left: 3px solid var(--crewswarm-primary);
}

.input-container button {
  background: var(--crewswarm-primary);
  color: black;
  font-weight: bold;
}
```

**Add CrewSwarm logo**:
```html
<!-- src/webview/chat.html -->
<div class="header">
  <img src="${logoUri}" alt="CrewSwarm" class="logo" />
  <h1>CrewSwarm Chat</h1>
</div>
```

---

### 4. Status Bar Items ✅
Add a branded status bar button.

**Add to `src/extension.ts`**:
```typescript
const statusBarItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Left,
  100
);
statusBarItem.text = "$(skull) CrewSwarm"; // Skull icon + name
statusBarItem.command = "crewswarm.openChat";
statusBarItem.tooltip = "Open CrewSwarm Chat";
statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
statusBarItem.show();
context.subscriptions.push(statusBarItem);
```

**Result**: Clickable "☠️ CrewSwarm" button in bottom status bar.

---

### 5. Custom Activity Bar Icon ✅
Add a dedicated sidebar panel with your icon.

**Update `package.json`**:
```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "crewswarm",
          "title": "CrewSwarm",
          "icon": "resources/skull.svg"
        }
      ]
    },
    "views": {
      "crewswarm": [
        {
          "id": "crewswarm.agents",
          "name": "Agents"
        },
        {
          "id": "crewswarm.tasks",
          "name": "Active Tasks"
        }
      ]
    }
  }
}
```

**Create `resources/skull.svg`**:
```xml
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" 
        fill="currentColor"/>
  <!-- Add skull path here -->
</svg>
```

**Result**: CrewSwarm icon in the Activity Bar (left sidebar), opens custom panel.

---

### 6. Command Palette Branding ✅
Prefix all commands with your brand.

**Update `package.json`**:
```json
{
  "contributes": {
    "commands": [
      {
        "command": "crewswarm.openChat",
        "title": "CrewSwarm: Open Chat",
        "icon": "$(skull)"
      },
      {
        "command": "crewswarm.dispatchAgent",
        "title": "CrewSwarm: Dispatch Agent",
        "icon": "$(robot)"
      }
    ]
  }
}
```

**Keybindings**:
```json
{
  "contributes": {
    "keybindings": [
      {
        "command": "crewswarm.openChat",
        "key": "ctrl+shift+c",
        "mac": "cmd+shift+c"
      }
    ]
  }
}
```

---

### 7. Marketplace Branding ✅
When published, your extension page is fully branded.

**`package.json` metadata**:
```json
{
  "name": "crewswarm",
  "displayName": "CrewSwarm - AI Agent Swarm",
  "description": "Multi-agent AI coding assistant. Deploy, dispatch, and coordinate 20+ specialist agents.",
  "version": "1.0.0",
  "publisher": "crewswarm",
  "icon": "icon.png",
  "galleryBanner": {
    "color": "#0a0a0a",
    "theme": "dark"
  },
  "categories": ["AI", "Programming Languages", "Other"],
  "keywords": ["ai", "agents", "cursor", "coding", "automation"],
  "repository": {
    "type": "git",
    "url": "https://github.com/crewswarm/CrewSwarm"
  },
  "bugs": {
    "url": "https://github.com/crewswarm/CrewSwarm/issues"
  },
  "homepage": "https://crewswarm.com"
}
```

**Add screenshots**:
- `images/screenshot-chat.png` (1280x720)
- `images/screenshot-agents.png`
- `images/screenshot-tasks.png`

**Reference in `README.md`**:
```markdown
![CrewSwarm Chat](images/screenshot-chat.png)
```

---

## Quick Branding Checklist

### Minimal (Ship Now):
- [ ] Add `icon.png` (128x128 skull logo)
- [ ] Update `displayName` and `description` in `package.json`
- [ ] Customize CSS colors in `src/webview/styles.css`
- [ ] Add status bar item with skull icon

### Production:
- [ ] Create custom color theme (`themes/crewswarm-dark.json`)
- [ ] Add Activity Bar icon (`resources/skull.svg`)
- [ ] Add 3+ screenshots to `images/`
- [ ] Write branded README with logo, screenshots, and GIFs
- [ ] Add custom views (Agents panel, Tasks panel)
- [ ] Set up publisher account with CrewSwarm branding
- [ ] Add `galleryBanner` color and theme

---

## Example: Full Branded `package.json`

```json
{
  "name": "crewswarm",
  "displayName": "CrewSwarm ☠️",
  "description": "Multi-agent AI swarm. Dispatch 20+ specialist coding agents from your editor.",
  "version": "1.0.0",
  "publisher": "crewswarm",
  "icon": "icon.png",
  "engines": {
    "vscode": "^1.96.0"
  },
  "categories": ["AI", "Programming Languages", "Other"],
  "keywords": ["ai", "agents", "cursor", "coding", "multi-agent", "automation"],
  "activationEvents": [],
  "main": "./out/extension.js",
  "galleryBanner": {
    "color": "#0a0a0a",
    "theme": "dark"
  },
  "contributes": {
    "commands": [
      {
        "command": "crewswarm.openChat",
        "title": "CrewSwarm: Open Chat",
        "icon": "$(skull)"
      },
      {
        "command": "crewswarm.dispatchAgent",
        "title": "CrewSwarm: Dispatch Agent to Current File",
        "icon": "$(robot)"
      },
      {
        "command": "crewswarm.showAgents",
        "title": "CrewSwarm: Show All Agents",
        "icon": "$(organization)"
      }
    ],
    "keybindings": [
      {
        "command": "crewswarm.openChat",
        "key": "ctrl+shift+c",
        "mac": "cmd+shift+c"
      }
    ],
    "configuration": {
      "title": "CrewSwarm",
      "properties": {
        "crewswarm.apiUrl": {
          "type": "string",
          "default": "http://127.0.0.1:5010/v1",
          "description": "CrewSwarm API base URL"
        },
        "crewswarm.theme": {
          "type": "string",
          "default": "dark",
          "enum": ["dark", "light"],
          "description": "CrewSwarm chat theme"
        }
      }
    },
    "themes": [
      {
        "label": "CrewSwarm Dark",
        "uiTheme": "vs-dark",
        "path": "./themes/crewswarm-dark.json"
      }
    ]
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/crewswarm/CrewSwarm"
  },
  "bugs": {
    "url": "https://github.com/crewswarm/CrewSwarm/issues"
  },
  "homepage": "https://crewswarm.com"
}
```

---

## Resources Needed

1. **icon.png** (128x128)
   - CrewSwarm skull logo
   - Dark background or transparent
   - High contrast for visibility

2. **resources/skull.svg**
   - Monochrome SVG icon
   - For Activity Bar
   - 24x24 viewBox

3. **themes/crewswarm-dark.json**
   - Full color theme
   - Use CrewSwarm brand colors (#38bdf8, #8b5cf6, #f97316)

4. **images/** (screenshots)
   - `screenshot-chat.png` (1280x720)
   - `screenshot-agents.png`
   - `screenshot-dispatch.png`

5. **README.md**
   - Logo at top
   - Animated GIF demo
   - Installation instructions
   - Configuration guide
   - Screenshots gallery

---

## Integration with CrewSwarm

### Auto-detection
Extension can auto-detect if CrewSwarm is running:

```typescript
async function detectCrewSwarm(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:5010/health');
    return response.ok;
  } catch {
    return false;
  }
}

// Show install instructions if not detected
if (!await detectCrewSwarm()) {
  vscode.window.showWarningMessage(
    'CrewSwarm not detected. Install: npm install -g crewswarm',
    'Install Now'
  ).then(selection => {
    if (selection === 'Install Now') {
      vscode.env.openExternal(vscode.Uri.parse('https://crewswarm.com/install'));
    }
  });
}
```

### Deep Integration
- Show agent status in sidebar
- Display active tasks in panel
- Real-time updates via WebSocket
- One-click dispatch from context menu
- Inline code suggestions from agents

---

## Next Steps

1. **Immediate**: Add `icon.png` and update `displayName`
2. **Week 1**: Customize webview CSS, add status bar item
3. **Week 2**: Create custom theme, add Activity Bar icon
4. **Week 3**: Add screenshots, polish README, publish to marketplace

**Target**: Fully branded, production-ready VS Code extension integrated with CrewSwarm.
