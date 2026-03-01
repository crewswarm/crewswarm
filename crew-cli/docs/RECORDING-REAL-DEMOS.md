# How to Record Real CLI Demos

This guide shows you how to capture **actual** crew-cli sessions (not simulations) for video demos.

---

## Quick Start (Recommended)

### 1. Install Tools

```bash
# macOS
brew install asciinema agg ffmpeg

# Linux (Debian/Ubuntu)
sudo apt install asciinema ffmpeg
# Then install agg: https://github.com/asciinema/agg/releases

# Verify installation
asciinema --version
agg --version
```

### 2. Record a Session

```bash
# Start recording
asciinema rec demo.cast

# Now run your REAL commands:
crew --version
crew chat "explain TypeScript"
crew plan "add API endpoint" --parallel

# Stop recording with Ctrl+D
```

### 3. Convert to Video/GIF

```bash
# Convert to animated GIF (web-friendly)
agg demo.cast demo.gif --font-size 16 --speed 1.5

# OR convert to MP4 (smaller file)
asciinema cat demo.cast | \
  svg-term --out demo.svg --window && \
  ffmpeg -i demo.svg demo.mp4
```

---

## Method 1: asciinema + agg (Terminal Recording)

**Best for:** Quick, authentic terminal recordings

### Advantages
- ✅ Records **actual CLI output**
- ✅ Small file sizes (text-based)
- ✅ Perfect playback timing
- ✅ Can edit/trim recordings
- ✅ Professional terminal look

### Example Recording Session

```bash
# 1. Start recording
asciinema rec explore-demo.cast --cols 120 --rows 30

# 2. Run actual crew commands
$ crew --version
0.1.0-alpha

$ crew explore "add user authentication"
[INFO] 🔀 Exploring 3 approaches in parallel...
[SUCCESS] Completed: explore-minimal (12 files)
[SUCCESS] Completed: explore-clean (18 files)
[SUCCESS] Completed: explore-pragmatic (15 files)

$ crew preview explore-clean
--- Sandbox Preview [explore-clean] ---
 M src/auth.js
 A src/middleware/auth.js
... (actual output)

# 3. Stop with Ctrl+D

# 4. Convert to GIF
agg explore-demo.cast explore-demo.gif \
  --font-size 16 \
  --theme monokai \
  --speed 1.5
```

### Tips
- Use `--speed 1.5` to speed up boring parts
- Use `--idle-time-limit 2` to cap long pauses at 2 seconds
- Edit `.cast` files to remove mistakes (it's JSON!)

---

## Method 2: Screen Recording (QuickTime/OBS)

**Best for:** Showing mouse interactions or GUI elements

### macOS (QuickTime)

```bash
# 1. Open QuickTime Player
# 2. File → New Screen Recording
# 3. Select your terminal window
# 4. Click record, run your CLI commands
# 5. Stop when done
# 6. Export and compress:

ffmpeg -i recording.mov \
  -vcodec libx264 \
  -crf 28 \
  -preset fast \
  -movflags +faststart \
  crew-demo.mp4
```

### Linux/Windows (OBS Studio)

1. Install OBS: https://obsproject.com/
2. Add "Window Capture" source (your terminal)
3. Set output to 1920x1080, 30fps
4. Click "Start Recording"
5. Run your CLI commands
6. Click "Stop Recording"
7. Compress with ffmpeg (see above)

---

## Method 3: terminalizer (Advanced)

**Best for:** Highly customized recordings with themes

```bash
# Install
npm install -g terminalizer

# Record
terminalizer record demo -d "crew-cli demo"

# Run your commands...

# Render to GIF
terminalizer render demo -o demo.gif

# Or render to MP4 (requires ffmpeg)
terminalizer render demo --format mp4 -o demo.mp4
```

---

## Recommended Demo Scripts

### Demo 1: Quick Feature Tour (30 seconds)

```bash
asciinema rec feature-tour.cast

# Commands to run:
crew --version
crew help
crew chat "what's the fastest way to add authentication?"
# (show response)
crew plan "add JWT auth" --dry-run
# (show plan)
```

### Demo 2: Explore Mode (45 seconds)

```bash
asciinema rec explore-demo.cast

# Commands to run:
crew explore "refactor storage to use SQLite"
# (wait for 3 branches to complete)
crew preview explore-clean
# (show diff)
crew apply explore-clean
# (show success)
```

### Demo 3: Parallel Execution (60 seconds)

```bash
asciinema rec parallel-demo.cast

# Commands to run:
crew plan "add 5 REST API endpoints" --parallel --concurrency 3
# (watch worker pool output in real-time)
crew preview
# (show generated code)
crew apply --check "npm test"
# (show tests passing)
```

### Demo 4: REPL Session (60 seconds)

```bash
asciinema rec repl-demo.cast

# Commands to run:
crew repl
# (banner shows)
/help
# (show slash commands)
create a glassmorphism landing page
# (show output)
/model gemini-2.5-flash
# (switch model)
add mobile responsiveness
# (show iterative improvement)
exit
```

---

## Post-Processing Tips

### Trim Recording
```bash
# Edit the .cast file (it's JSON)
# Find the timestamp where you want to cut
# Delete lines before/after that timestamp
```

### Add Title Card
```bash
# Use ffmpeg to add a 2-second title
ffmpeg -f lavfi -i color=c=black:s=1920x1080:d=2 \
  -vf "drawtext=text='crew-cli Demo':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
  title.mp4

ffmpeg -i "concat:title.mp4|demo.mp4" -c copy demo-with-title.mp4
```

### Optimize for Web
```bash
# Compress heavily for web
ffmpeg -i demo.mp4 \
  -vcodec libx264 \
  -crf 28 \
  -preset veryslow \
  -movflags +faststart \
  -vf "scale=1280:720" \
  demo-optimized.mp4
```

---

## Using the Recording Script

I've created a helper script that automates the recording process:

```bash
# Make sure tools are installed
brew install asciinema agg

# Run the script
./scripts/record-real-demos.sh

# Choose which demo to record:
# 1. Explore Mode
# 2. Parallel Execution
# 3. REPL Session
# 4. All of them

# Follow the on-screen prompts
# Run the commands as instructed
# Press Ctrl+D when done
```

The script will:
1. Record your actual CLI session
2. Convert to animated GIF
3. Save to `docs/marketing/`

---

## Comparison: Real vs Fake

### Fake Videos (Current)
- ❌ Simulated terminal UI in browser
- ❌ Hardcoded output
- ❌ Not verifiable
- ❌ Misleading to users

### Real Videos (Recommended)
- ✅ Actual crew-cli running
- ✅ Real output from LLMs
- ✅ Verifiable by anyone
- ✅ Builds trust with users

---

## Best Practices

1. **Prepare your environment**
   - Clean terminal (no clutter)
   - Large font (16pt+)
   - High contrast theme
   - Terminal size: 120x30 or 140x35

2. **Practice the commands first**
   - Know exactly what you'll type
   - Test that features work
   - Time it (aim for 30-60 seconds)

3. **Keep it authentic**
   - Show real output (even if slow)
   - Don't edit out minor delays
   - If something fails, show recovery

4. **Add context**
   - Start with `crew --version`
   - Add comments with `echo "# Step 1: ..."`
   - End with a clear success indicator

---

## Example: Recording Right Now

Let's record a real demo:

```bash
# 1. Navigate to project
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli

# 2. Build the CLI
npm run build

# 3. Start recording
asciinema rec real-demo.cast --cols 120 --rows 30

# 4. Run real commands
node dist/crew.mjs --version
node dist/crew.mjs help
node dist/crew.mjs chat "explain the 3-tier architecture"

# 5. Stop (Ctrl+D)

# 6. Convert to GIF
agg real-demo.cast docs/marketing/real-demo.gif \
  --font-size 16 \
  --speed 1.5 \
  --theme monokai

# 7. Verify it looks good
open docs/marketing/real-demo.gif
```

---

## Next Steps

1. Install `asciinema` and `agg`
2. Practice your demo commands
3. Record 2-3 real sessions
4. Pick the best one
5. Replace the fake videos on the website
6. Launch with **real proof**

**The authenticity will be worth more than any polished fake demo.** 🎥✅
