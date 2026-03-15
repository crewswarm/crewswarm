# CrewSwarm Vibe — Visual Guide

## Vibe Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 🐝 CrewSwarm Vibe                                        my-todo-app         │
├─────────────┬────────────────────────────────┬────────────────────────────────┤
│             │                                │                                │
│  EXPLORER   │     MONACO EDITOR              │     CHAT WITH AGENTS          │
│             │                                │                                │
│  📁 src/    │  function TodoApp() {          │ 🟢 crew-lead                  │
│  ├─ 📄 app.js│    const [todos, setTodos]   │ ⚡ crew-coder                  │
│  ├─ 📄 api.js│      = useState([]);         │ 🔵 crew-qa                     │
│  └─ 📁 comp/│                               │                                │
│  📝 README  │    return (                    │ ────────────────────────       │
│  📦 package │      <div className="app">   │                                │
│             │        <h1>Todo App</h1>      │ You:                           │
│             │        {todos.map(todo =>     │ Add input validation for       │
│             │          <TodoItem            │ the todo form                  │
│             │            key={todo.id}      │                                │
│             │            todo={todo}        │ crew-lead:                     │
│             │          />                   │ I'll have crew-coder add       │
│             │        )}                     │ validation for you.            │
│             │      </div>                   │                                │
│             │    );                         │ [14:32] ⚡ Dispatching to      │
│             │  }                            │ crew-coder...                  │
│             │                                │                                │
│             │  export default TodoApp;      │ crew-coder:                    │
│             │                                │ ✅ Added validation to         │
│             │                                │ src/TodoForm.jsx:              │
│             │                                │ • Required field check         │
│             │                                │ • Max length 100 chars         │
│             │                                │ • No empty strings             │
│             │                                │                                │
│             │                                │ ┌─────────────────────────┐   │
│             │                                │ │ Ask the crew anything...│   │
│             │                                │ │ (⌘+Enter to send)       │   │
│             │                                │ └─────────────────────────┘   │
├─────────────┴────────────────────────────────┴────────────────────────────────┤
│ TERMINAL / AGENT OUTPUT                                                       │
│                                                                                │
│ [14:32:05] 🔗 Connected to RT message bus                                     │
│ [14:32:15] ⚡ crew-coder started working on task                              │
│ [14:32:16] 🔧 crew-coder → write_file src/TodoForm.jsx                        │
│ [14:32:17] 🔧 crew-coder → write_file src/validation.js                       │
│ [14:32:18] ✅ crew-coder completed task                                       │
│ [14:32:19] 💾 Saved src/TodoForm.jsx                                          │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Color Scheme (vs-dark theme)

```css
Background:     #1e1e1e  (main editor)
Sidebar:        #252526  (file tree, chat)
Titlebar:       #323233
Borders:        #181818
Text:           #d4d4d4
Active tab:     #1e1e1e
Inactive tab:   #2d2d30
User message:   #0e639c (blue bubble)
Agent message:  #2d2d30 (gray bubble)
Success:        #81c784 (green)
Error:          #e57373 (red)
Info:           #4fc3f7 (cyan)
Warning:        #ffb74d (orange)
```

---

## Key UI Elements

### 1. Titlebar
```
┌──────────────────────────────────────────────────────┐
│ 🐝 CrewSwarm Vibe            my-todo-app             │
└──────────────────────────────────────────────────────┘
     ↑ Logo              ↑ Project name (right aligned)
```

### 2. File Tree
```
EXPLORER

📁 src/
├─ 📄 app.js       ← Click to open
├─ 📄 api.js
└─ 📁 components/
   ├─ 📄 TodoItem.jsx
   └─ 📄 TodoForm.jsx
📝 README.md
📦 package.json
```

**States:**
- Regular: `📄 app.js`
- Active: `📄 app.js` (highlighted bg: #37373d)
- Hover: `📄 app.js` (subtle highlight)

### 3. Editor Tabs
```
┌───────────┬───────────┬───────────┐
│ app.js ×  │ api.js ×  │ README ×  │
└───────────┴───────────┴───────────┘
    ↑ active    ↑ inactive   ↑ inactive
```

**Active tab:**
- Background: #1e1e1e
- Text: #fff

**Inactive tab:**
- Background: transparent
- Text: #969696

### 4. Chat Panel
```
┌─────────────────────────────────┐
│ Chat with Agents                │ ← Header
├─────────────────────────────────┤
│ 🟢 crew-lead                    │ ← Status indicators
│ ⚡ crew-coder                    │
│ 🔵 crew-qa                       │
├─────────────────────────────────┤
│                                 │
│ [Chat messages scroll here]    │
│                                 │
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ Ask the crew anything...    │ │ ← Input (⌘+Enter)
│ │                             │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

**Status indicators:**
- 🟢 Green = online/available
- ⚡ Yellow = working on task
- 🔵 Blue = ready
- 🔴 Red = error/offline

### 5. Terminal
```
┌────────────────────────────────────────────────┐
│ Agent Output                           [Clear] │ ← Header
├────────────────────────────────────────────────┤
│ [14:32:15] ⚡ crew-coder started working       │ ← Info (cyan)
│ [14:32:18] ✅ crew-coder completed task        │ ← Success (green)
│ [14:32:19] 💾 Saved src/TodoForm.jsx           │ ← Success (green)
│ [14:32:20] ❌ Failed to save config.json       │ ← Error (red)
└────────────────────────────────────────────────┘
```

**Log colors:**
- Info: #4fc3f7
- Success: #81c784
- Error: #e57373
- Warning: #ffb74d

---

## Responsive Behavior

### Desktop (1920×1080)
```
File Tree: 250px
Editor: flex (grows)
Chat: 350px
Terminal: 200px
```

### Laptop (1440×900)
```
File Tree: 200px
Editor: flex (grows)
Chat: 300px
Terminal: 180px
```

### Tablet (1024×768)
```
File Tree: Collapsible (hidden by default)
Editor: Full width
Chat: Overlay (slides in from right)
Terminal: 150px
```

---

## Interactions

### File Tree
- **Click file** → Opens in editor
- **Hover file** → Slight highlight
- **Active file** → Bold + highlight

### Editor
- **Type** → Auto-saves after 1s
- **⌘+S** → Immediate save
- **Tab close (×)** → Removes tab, switches to previous

### Chat
- **Type** → Input grows (max 3 lines)
- **⌘+Enter** → Sends message
- **Messages** → Auto-scroll to bottom
- **Agent bubbles** → Different colors per role

### Terminal
- **New event** → Auto-scrolls to bottom
- **Scroll up** → Pauses auto-scroll
- **Scroll to bottom** → Re-enables auto-scroll

---

## Monaco Editor Features

**Built-in:**
- ✅ Syntax highlighting (50+ languages)
- ✅ Auto-completion (basic)
- ✅ Find/replace
- ✅ Minimap
- ✅ Line numbers
- ✅ Code folding
- ✅ Multi-cursor (⌥+Click)
- ✅ Bracket matching

**Coming soon:**
- 🔄 IntelliSense (full)
- 🔄 Git diff indicators (green/red bars)
- 🔄 Error squiggles (from linter)
- 🔄 Inline agent suggestions

---

## Agent Status Icons

```
🟢 Online       Agent ready to receive tasks
⚡ Working      Agent actively processing
✅ Complete     Agent finished task
🔵 Idle         Agent available but not active
🔴 Error        Agent encountered error
⏸️ Paused       Agent temporarily disabled
🔄 Restarting   Agent reloading
```

---

## Example Workflows

### Workflow 1: Open File + Edit
```
1. Click "src/app.js" in file tree
   → File opens in editor
   → Tab appears at top

2. Type changes in editor
   → Auto-saves after 1s
   → Terminal shows: "💾 Saved src/app.js"

3. Click "×" on tab to close
   → File closes
   → Switches to previous tab
```

### Workflow 2: Ask Agent to Edit
```
1. Type in chat: "Add error handling to api.js"
   → Press ⌘+Enter

2. crew-lead responds:
   "I'll have crew-coder add that for you."

3. Terminal shows:
   [14:45:00] ⚡ crew-coder started working
   [14:45:05] 🔧 crew-coder → write_file src/api.js
   [14:45:06] ✅ crew-coder completed task

4. File tree: "api.js" changes appear
   → Click to open and review
```

### Workflow 3: Multi-Agent Pipeline
```
1. Type: "Build a login page with tests"

2. crew-lead coordinates:
   ⚡ Dispatching to crew-coder-front...
   ⚡ Dispatching to crew-qa...

3. Terminal shows both agents working:
   [15:00:00] ⚡ crew-coder-front started
   [15:00:15] ✅ crew-coder-front completed
   [15:00:16] ⚡ crew-qa started
   [15:00:30] ✅ crew-qa completed

4. Result:
   ✅ Created src/LoginPage.jsx
   ✅ Created tests/login.test.js
```

---

## Keyboard Shortcuts (Future)

| Shortcut | Action |
|---|---|
| ⌘+S | Save current file |
| ⌘+P | Quick file picker |
| ⌘+K | Focus chat input |
| ⌘+J | Toggle terminal |
| ⌘+B | Toggle file tree |
| ⌘+Enter | Send chat message |
| ⌘+W | Close current tab |
| ⌘+Shift+P | Command palette |
| ⌘+/ | Toggle comment |
| ⌘+F | Find in file |

---

## Comparison to Cursor

| Feature | Cursor | Vibe |
|---|---|---|
| File editing | ✅ Full IDE | ✅ Monaco |
| Agent chat | ✅ Inline + panel | ✅ Side panel |
| File tree | ✅ Full features | ✅ Basic (Phase 1) |
| Terminal | ✅ Full shell | ✅ Agent logs only |
| Git | ✅ Built-in | 🔄 Future |
| Extensions | ✅ VSCode ecosystem | ❌ Not yet |
| Themes | ✅ Full customization | ✅ vs-dark (default) |
| Multi-agent | ❌ Single agent | ✅ 20 agents |
| Real-time updates | ⚠️ Polling | ✅ WebSocket |

**Vibe's differentiator:** Real-time multi-agent coordination with visible progress. Cursor is better as a full IDE, Vibe is better for swarm workflows.

---

## Screenshots (Conceptual)

**Main view:**
```
┌────────────────────────────────────────────────┐
│ FILE TREE     │   EDITOR     │   CHAT         │
│               │              │                │
│ Click files   │ Code here    │ Talk to agents│
└────────────────────────────────────────────────┘
                   │ TERMINAL (agent activity)  │
                   └────────────────────────────┘
```

**Chat conversation:**
```
You: Add validation

crew-lead: Sure! Dispatching to crew-coder...

crew-coder: ✅ Added validation.js
            • Required field check
            • Email format validation
            • Password strength check
```

**Terminal activity:**
```
[14:32:15] 🔗 Connected to RT bus
[14:32:20] ⚡ crew-coder started task
[14:32:25] 🔧 crew-coder → write_file
[14:32:26] ✅ crew-coder completed task
```

---

**Next:** See `STUDIO-SETUP-COMPLETE.md` for the current local setup, verification, and usage guide.
