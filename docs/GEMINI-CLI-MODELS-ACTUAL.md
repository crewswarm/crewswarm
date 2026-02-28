# Gemini CLI - Actual Models Available

## Official Gemini CLI Models (from CLI)

**From the `gemini` model selection menu:**

| # | Model | Description |
|---|-------|-------------|
| 1 | **gemini-3.1-pro-preview** | Latest Pro model (preview) |
| 2 | **gemini-3-flash-preview** ● | Latest Flash model (current default) |
| 3 | **gemini-2.5-pro** | Stable Pro model |
| 4 | **gemini-2.5-flash** | Stable Flash model |
| 5 | **gemini-2.5-flash-lite** | Lightest/fastest model |

**● = Currently selected in CLI**

---

## Model Hierarchy

### Gemini 3 Series (Latest/Preview)
- **gemini-3.1-pro-preview** - Latest Pro (most capable, preview)
- **gemini-3-flash-preview** - Latest Flash (fast, preview) ✅ Default

### Gemini 2.5 Series (Stable)
- **gemini-2.5-pro** - Stable Pro (reliable)
- **gemini-2.5-flash** - Stable Flash (balanced)
- **gemini-2.5-flash-lite** - Lite (fastest/cheapest)

---

## How to Use

### 1. Command Line
```bash
gemini -p "task" -m gemini-3-flash-preview --yolo
gemini -p "task" -m gemini-3.1-pro-preview --yolo
gemini -p "task" -m gemini-2.5-pro --yolo
gemini -p "task" -m gemini-2.5-flash --yolo
gemini -p "task" -m gemini-2.5-flash-lite --yolo
```

### 2. Interactive Mode
```bash
gemini                          # Opens interactive mode
# Then switch models with CLI menu
```

### 3. Dashboard Passthrough
1. Select "🔷 Gemini CLI" from engine dropdown
2. Select model:
   - **gemini-3-flash-preview** (current default)
   - **gemini-3.1-pro-preview** (latest Pro)
   - **gemini-2.5-pro** (stable)
   - **gemini-2.5-flash** (balanced)
   - **gemini-2.5-flash-lite** (fastest)
3. Send message

### 4. Output Format
```bash
gemini -p "task" -m gemini-3-flash-preview --yolo --output-format stream-json
```

---

## Model Comparison

| Model | Speed | Cost | Quality | Best For |
|-------|-------|------|---------|----------|
| **gemini-3.1-pro-preview** | ⚡⚡ | $$$ | ⭐⭐⭐⭐⭐ | Complex reasoning, latest features |
| **gemini-3-flash-preview** | ⚡⚡⚡⚡ | $$ | ⭐⭐⭐⭐ | Fast coding, default choice ✅ |
| **gemini-2.5-pro** | ⚡⚡ | $$$ | ⭐⭐⭐⭐ | Stable/production Pro |
| **gemini-2.5-flash** | ⚡⚡⚡ | $$ | ⭐⭐⭐ | Stable/production Flash |
| **gemini-2.5-flash-lite** | ⚡⚡⚡⚡⚡ | $ | ⭐⭐ | Quick fixes, simple tasks |

---

## Model Recommendations

### For Speed (Quick Iteration)
**gemini-2.5-flash-lite** ⚡
- Fastest
- Cheapest
- Good for simple tasks

### For Balance (Default Choice)
**gemini-3-flash-preview** ✅ RECOMMENDED
- Current CLI default
- Fast and capable
- Latest features

### For Quality (Complex Tasks)
**gemini-3.1-pro-preview** 🎯
- Most capable
- Latest features
- Best reasoning

### For Production (Stable)
**gemini-2.5-pro** 🏭
- Stable/reliable
- Production-ready
- No preview quirks

---

## Version Differences

### Preview vs Stable

**Preview Models (Gemini 3):**
- ✅ Latest features
- ✅ Best performance
- ⚠️ May have quirks
- ⚠️ API may change

**Stable Models (Gemini 2.5):**
- ✅ Production-ready
- ✅ Reliable
- ✅ API stable
- ⚠️ Slightly older features

---

## Dashboard Dropdown Updated

**New Gemini CLI dropdown:**
```javascript
gemini: [
  { value: '', label: '— default (gemini-3-flash-preview) —' },
  { optgroup: 'Recommended (Latest)' },
  { value: 'gemini-3-flash-preview', label: '🟢 Gemini 3 Flash Preview (current)' },
  { value: 'gemini-3.1-pro-preview', label: '🟢 Gemini 3.1 Pro Preview' },
  { optgroup: 'Gemini 2.5 Series' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (fastest)' },
]
```

---

## What Changed

**Before:** Incorrect models
- ❌ gemini-2.5-flash-latest (wrong suffix)
- ❌ gemini-2.5-pro-latest (wrong suffix)
- ❌ gemini-2.0-flash-exp (old)
- ❌ gemini-2.0-flash-thinking-exp (old)
- ❌ gemini-exp-1206 (old)
- ❌ gemini-1.5-pro (legacy)
- ❌ gemini-1.5-flash (legacy)

**After:** Actual models from CLI
- ✅ gemini-3-flash-preview (current)
- ✅ gemini-3.1-pro-preview
- ✅ gemini-2.5-pro
- ✅ gemini-2.5-flash
- ✅ gemini-2.5-flash-lite

---

## CLI Integration

### With YOLO Mode (Auto-approve)
```bash
gemini -p "Create function" -m gemini-3-flash-preview --yolo
```

### With Output Format
```bash
gemini -p "Create function" -m gemini-3-flash-preview --yolo --output-format stream-json
```

### With Approval Mode
```bash
gemini -p "Create function" -m gemini-3-flash-preview --approval-mode yolo
```

---

## Testing Results

### ⏳ To Test:
- gemini-3-flash-preview (current)
- gemini-3.1-pro-preview
- gemini-2.5-pro
- gemini-2.5-flash
- gemini-2.5-flash-lite

All models should work via passthrough with the correct model parameter.

---

## Summary

**Actual Gemini CLI Models:**
1. ✅ gemini-3-flash-preview (current default)
2. ✅ gemini-3.1-pro-preview (latest Pro)
3. ✅ gemini-2.5-pro (stable Pro)
4. ✅ gemini-2.5-flash (stable Flash)
5. ✅ gemini-2.5-flash-lite (fastest)

**Dashboard:** ✅ Updated with correct models
**Frontend:** ✅ Rebuilt
**Status:** Ready to use - just refresh dashboard!

**Recommendation:** Use **gemini-3-flash-preview** for best balance of speed and quality.
