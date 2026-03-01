# 3-Tier Test — Quick Start

## ✅ All API Keys Found!

Your keys are stored in `~/.crewswarm/crewswarm.json`:

```
✓ GROQ_API_KEY        (Tier 1 - Router)
✓ GOOGLE_API_KEY      (Tier 2 - Planner) 
✓ DEEPSEEK_API_KEY    (Tier 2 - Planner alternative)
✓ OPENAI_API_KEY      (Tier 3 - Workers)
✓ XAI_API_KEY         (Bonus - X-search)
✓ ANTHROPIC_API_KEY   (Bonus - Claude)
```

---

## 🚀 Run Test Now

### Option 1: Automatic (Recommended)
```bash
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli
./setup-keys.sh --test
```

This will:
1. Export all API keys from JSON
2. Run full 3-tier test suite
3. Report results

---

### Option 2: Manual
```bash
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli

# Export keys
source setup-keys.sh

# Run test
./test-3-tier.sh
```

---

### Option 3: Individual Tests
```bash
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli
source setup-keys.sh

# Test Tier 1 (Router)
node dist/crew.mjs chat "What is TypeScript?"

# Test Tier 2 (Planner)  
node dist/crew.mjs plan "Add unit tests" --dry-run

# Test Tier 3 (Workers)
node dist/crew.mjs plan "Refactor auth" --parallel --dry-run

# Full 3-Tier
node dist/crew.mjs auto "Implement REST API" --parallel --dry-run
```

---

## 📊 Expected Output

```
✓ TEST 1: Tier 1 (Router - Groq Llama 3.3 70B)
  Testing intent classification...
  ✓ Routed to CHAT decision

✓ TEST 2: Tier 2 (Planner - Gemini Flash)
  Generating plan...
  1. Define API endpoints
  2. Create models
  3. Add tests
  4. Write docs
  5. Deploy

✓ TEST 3: Tier 3 (Worker Pool - Parallel)
  Spawning 3 workers...
  Worker 1: crew-coder (deepseek-chat)
  Worker 2: crew-qa (gemini-flash)
  Worker 3: crew-coder (deepseek-chat)

✓ TEST 4: Cost Tracking
  Total cost: $0.004
  Savings: 72% vs single-tier

✅ 3-Tier Architecture Tests Complete!
```

---

## 🔧 Current Configuration

**Tier 1 (Router)**:
- Model: `groq/llama-3.3-70b-versatile`
- Cost: $0.59/$0.79 per 1M tokens
- Key: `GROQ_API_KEY` ✅

**Tier 2 (Planner)**:
- Model: `google/gemini-2.0-flash-exp` (recommended)
- Alt: `deepseek/deepseek-chat`
- Cost: $0.075/$0.30 per 1M (Gemini)
- Key: `GOOGLE_API_KEY` ✅

**Tier 3 (Workers)**:
- Default: `deepseek/deepseek-chat`
- Concurrency: 3 workers
- Key: `OPENAI_API_KEY` ✅ (for crew-lead gateway)

---

## ✅ Pre-Flight Check

Run this to verify everything:
```bash
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli
npm run build && echo "✓ Build OK"
source setup-keys.sh && echo "✓ Keys loaded"
./test-3-tier.sh
```

---

## 📁 Files

- `setup-keys.sh` — Export API keys from JSON
- `test-3-tier.sh` — Run 3-tier test suite
- `3-TIER-TEST-SETUP.md` — Full documentation
- `~/.crewswarm/crewswarm.json` — Source of truth for keys

---

## 🎯 Next Steps

1. Run test: `./setup-keys.sh --test`
2. Check results: `crew cost` and `.crew/routing.log`
3. Benchmark: Compare single-tier vs 3-tier performance
4. Optimize: Tune models for your workload

---

**Ready!** All keys are configured. Just run: `./setup-keys.sh --test`
