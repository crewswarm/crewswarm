#!/bin/bash
# Direct test of PM prompt with Groq API

SYSTEM_PROMPT='You output dispatch plans as JSON. Nothing else.

Input: Create /tmp/test.txt with '\''hello'\''
Output:
{"op_id":"op-001","summary":"Create test file","dispatch":[{"agent":"crew-coder","task":"Create /tmp/test.txt with content '\''hello'\''. Use write tool.","acceptance":"File exists with correct content"}]}

Input: Fix login bug and add tests
Output:
{"op_id":"op-002","summary":"Fix login + tests","dispatch":[{"agent":"crew-fixer","task":"Debug src/auth/login.ts. Fix password validation.","acceptance":"Login works"},{"agent":"crew-qa","task":"Test login with valid and invalid credentials.","acceptance":"All tests pass"}]}

Agents: crew-coder, crew-qa, crew-fixer, security

Rules:
1. Output valid JSON starting with { and ending with }
2. At least 1 task in dispatch array
3. No other text

Now output your dispatch JSON:'

USER_MSG="Create /tmp/test-$(date +%s).txt with 'hello world'"

echo "🧪 Testing PM Prompt Directly with Groq Llama 3.3 70B"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 System Prompt:"
echo "$SYSTEM_PROMPT" | head -n 5
echo "..."
echo ""
echo "💬 User Message:"
echo "$USER_MSG"
echo ""
echo "⏳ Calling Groq API..."
echo ""

RESPONSE=$(curl -s https://api.groq.com/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -d "{
    \"model\": \"llama-3.3-70b-versatile\",
    \"messages\": [
      {\"role\": \"system\", \"content\": $(echo "$SYSTEM_PROMPT" | jq -Rs .)},
      {\"role\": \"user\", \"content\": $(echo "$USER_MSG" | jq -Rs .)}
    ],
    \"temperature\": 0.1,
    \"max_tokens\": 500
  }")

echo "✅ Raw API Response:"
echo "$RESPONSE" | jq .
echo ""

CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty')

if [ -z "$CONTENT" ]; then
  echo "❌ FAIL: No content in response"
  exit 1
fi

echo "📋 Model Output:"
echo "$CONTENT"
echo ""

echo "📊 Validating JSON..."
if echo "$CONTENT" | jq . >/dev/null 2>&1; then
  echo "✅ SUCCESS: Valid JSON!"
  echo "$CONTENT" | jq .
else
  echo "❌ FAIL: Not valid JSON"
  exit 1
fi

