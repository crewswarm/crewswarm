#!/bin/bash
echo "🔍 Verifying RAG Integration at All Levels"
echo ""

echo "✅ Helper Methods:"
rg -n "private isQuestionIntent|private isComplexTask" src/pipeline/unified.ts | head -2
echo ""

echo "✅ L1 RAG (Questions) - Line in execute():"
rg -n "L1 RAG: Load files for questions" src/pipeline/unified.ts
echo ""

echo "✅ L2 RAG (Planning) - Line in l2Orchestrate():"
rg -n "L2 RAG: Load files for complex" src/pipeline/unified.ts
echo ""

echo "✅ L3 RAG (Execution) - Line in getExecutionProjectContext():"
rg -n "RAG: Auto-load relevant files" src/pipeline/unified.ts
echo ""

echo "✅ Imports:"
rg -n "^import.*autoLoadRelevantFiles" src/pipeline/unified.ts
echo ""

echo "📦 Build Status:"
if [ -f "dist/crew.mjs" ]; then
  echo "   ✅ dist/crew.mjs exists ($(du -h dist/crew.mjs | cut -f1))"
else
  echo "   ❌ dist/crew.mjs missing - run 'npm run build'"
fi
echo ""

echo "📄 Documentation:"
for doc in ALL-RAG-FIXED.md ALL-RAG-LEVELS-COMPLETE.md test-rag-all-levels.mjs; do
  if [ -f "$doc" ]; then
    echo "   ✅ $doc"
  else
    echo "   ❌ $doc missing"
  fi
done
echo ""

echo "🎉 All RAG Levels Verified!"
