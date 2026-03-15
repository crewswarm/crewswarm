#!/bin/bash
# Record real crew-cli sessions with asciinema

# Install dependencies (one-time)
# brew install asciinema agg

# Function to record a demo session
record_demo() {
    local name=$1
    local cast_file="tmp/${name}.cast"
    local gif_file="docs/marketing/${name}.gif"
    
    echo "🎥 Recording ${name} demo..."
    echo "Press Ctrl+D when done"
    
    # Start recording
    asciinema rec "$cast_file" \
        --cols 120 \
        --rows 30 \
        --title "crew-cli ${name} demo"
    
    # Convert to GIF (animated)
    echo "🎞️ Converting to GIF..."
    agg "$cast_file" "$gif_file" \
        --font-size 16 \
        --theme monokai \
        --speed 1.5
    
    echo "✅ Saved to ${gif_file}"
}

# Record explore demo
record_explore() {
    echo "=== EXPLORE DEMO SCRIPT ==="
    echo "Run these commands:"
    echo ""
    echo "1. crew --version"
    echo "2. crew explore \"add user authentication\""
    echo "3. crew preview explore-clean"
    echo "4. crew apply explore-clean"
    echo ""
    read -p "Press Enter to start recording..."
    record_demo "explore-demo"
}

# Record parallel demo
record_parallel() {
    echo "=== PARALLEL DEMO SCRIPT ==="
    echo "Run these commands:"
    echo ""
    echo "1. crew plan \"add 3 API endpoints\" --parallel --concurrency 2"
    echo "2. (wait for completion)"
    echo "3. crew preview"
    echo ""
    read -p "Press Enter to start recording..."
    record_demo "parallel-demo"
}

# Record REPL demo
record_repl() {
    echo "=== REPL DEMO SCRIPT ==="
    echo "Run these commands:"
    echo ""
    echo "1. crew repl"
    echo "2. /help"
    echo "3. create a simple API server"
    echo "4. /model gemini"
    echo "5. add error handling"
    echo "6. exit"
    echo ""
    read -p "Press Enter to start recording..."
    record_demo "repl-demo"
}

# Menu
echo "Which demo would you like to record?"
echo "1. Explore Mode"
echo "2. Parallel Execution"
echo "3. REPL Session"
echo "4. All of them"
read -p "Choice (1-4): " choice

case $choice in
    1) record_explore ;;
    2) record_parallel ;;
    3) record_repl ;;
    4) 
        record_explore
        record_parallel
        record_repl
        ;;
    *) echo "Invalid choice" ;;
esac
