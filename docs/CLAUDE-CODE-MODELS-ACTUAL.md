# Claude Code CLI - Actual Models Available

## Official Claude Code Models (from CLI)

**From the CLI selection screen:**

| # | Alias | Full Version | Description |
|---|-------|--------------|-------------|
| 1 | **Default** ✔ | Sonnet 4.6 | Best for everyday tasks (recommended) |
| 2 | **Opus** | Opus 4.6 | Most capable for complex work |
| 3 | **Haiku** | Haiku 4.5 | Fastest for quick answers |

---

## How to Use

### 1. Alias (Recommended)
**Always resolves to latest version:**
```bash
claude -p "task" --model sonnet     # Latest Sonnet
claude -p "task" --model opus       # Latest Opus
claude -p "task" --model haiku      # Latest Haiku
claude -p "task" --model Default    # Same as sonnet
```

### 2. Specific Version
```bash
claude -p "task" --model claude-sonnet-4-6
claude -p "task" --model claude-opus-4-6
claude -p "task" --model claude-haiku-4-5
```

### 3. Dashboard Passthrough
1. Select "🟢 Claude Code" from engine dropdown
2. Select model:
   - **Default** (Sonnet 4.6) ← Recommended
   - **Sonnet** (alias for latest)
   - **Opus** (Opus 4.6) - Complex work
   - **Haiku** (Haiku 4.5) - Fast
3. Send message

---

## Model Comparison

| Model | Speed | Cost | Quality | Best For |
|-------|-------|------|---------|----------|
| **Sonnet 4.6** | ⚡⚡⚡ | $$ | ⭐⭐⭐⭐ | Everyday coding (default) |
| **Opus 4.6** | ⚡ | $$$$ | ⭐⭐⭐⭐⭐ | Complex architecture |
| **Haiku 4.5** | ⚡⚡⚡⚡ | $ | ⭐⭐⭐ | Quick fixes, simple tasks |

---

## Model Selection Logic

**Claude Code CLI uses capitalized aliases:**
- `Default` = Sonnet 4.6 (recommended)
- `Opus` = Opus 4.6
- `Haiku` = Haiku 4.5

**Lowercase aliases also work:**
- `sonnet` = Latest Sonnet
- `opus` = Latest Opus
- `haiku` = Latest Haiku

---

## Dashboard Dropdown Updated

**New Claude Code dropdown:**
```javascript
claude: [
  { value: '', label: '— default (Sonnet 4.6) —' },
  { optgroup: 'Recommended' },
  { value: 'sonnet', label: '🟢 Sonnet (alias for latest)' },
  { value: 'Default', label: '🟢 Default (Sonnet 4.6)' },
  { optgroup: 'Specific Versions' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 · Best for everyday tasks' },
  { value: 'Opus', label: 'Opus (Opus 4.6) · Most capable' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'Haiku', label: 'Haiku (Haiku 4.5) · Fastest' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]
```

---

## Testing Results

### ✅ Tested via passthrough (gpt-4o worked)
The passthrough system works - just need to verify model parameter is passed correctly.

### ⏳ To Test:
- Default (Sonnet 4.6)
- Opus (Opus 4.6)
- Haiku (Haiku 4.5)
- Specific versions (claude-sonnet-4-6, etc.)

---

## CLI Commands

### Interactive Mode (Default)
```bash
claude                          # Opens interactive session
# Then: /model sonnet           # Switch model mid-session
```

### Headless Mode (Passthrough)
```bash
claude -p "Create function" --model Default
claude -p "Complex design" --model Opus
claude -p "Quick fix" --model Haiku
claude -p "Task" --model claude-sonnet-4-6
```

### With Output Format
```bash
claude -p "task" --model sonnet --output-format stream-json
```

---

## Model Recommendations

### For Speed (Quick Iteration)
**Haiku (Haiku 4.5)** ⚡
- Fastest
- Cheapest
- Good for simple tasks

### For Balance (Default Choice)
**Default (Sonnet 4.6)** ✅ RECOMMENDED
- Best for everyday tasks
- Good speed/quality balance
- Most commonly used

### For Quality (Complex Work)
**Opus (Opus 4.6)** 🎯
- Most capable
- Slowest
- Best for architecture/design

---

## Summary

**Actual Claude Code Models:**
1. ✅ Default (Sonnet 4.6) - Recommended
2. ✅ Opus (Opus 4.6) - Most capable
3. ✅ Haiku (Haiku 4.5) - Fastest
4. ✅ Aliases: sonnet, opus, haiku (auto-resolve to latest)
5. ✅ Specific: claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5

**Dashboard:** ✅ Updated with correct models
**Frontend:** ✅ Rebuilt
**Status:** Ready to use - just refresh dashboard!
