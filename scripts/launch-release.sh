#!/bin/bash
# Launch script for CrewSwarm v0.8.0-beta
# Run this from repo root: bash scripts/launch-release.sh

set -e  # Exit on error

VERSION="0.8.0-beta"
REPO="CrewSwarm/CrewSwarm"
DRAFT=${1:-"--draft"}  # Default to draft unless you pass "publish"

echo "🚀 CrewSwarm v${VERSION} Release Script"
if [ "$DRAFT" = "--draft" ]; then
  echo "📝 Mode: DRAFT (not public yet)"
else
  echo "🌍 Mode: PUBLIC"
fi
echo ""

# 1. Version bump
echo "📝 Updating version in package.json..."
sed -i '' "s/\"version\": \"0.5.0\"/\"version\": \"${VERSION}\"/" package.json
grep version package.json

# 2. Verify CHANGELOG exists
if [ ! -f CHANGELOG.md ]; then
  echo "❌ CHANGELOG.md not found! Create it first."
  exit 1
fi
echo "✅ CHANGELOG.md exists"

# 3. Stage files
echo "📦 Staging files for commit..."
git add package.json CHANGELOG.md README.md docs/images/ scripts/

# 4. Commit
echo "💾 Committing release..."
git commit -m "chore: release v${VERSION}"

# 5. Push to main
echo "⬆️  Pushing to main..."
git push origin main

# 6. Create and push tag
echo "🏷️  Creating git tag v${VERSION}..."
git tag "v${VERSION}"
git push origin "v${VERSION}"

# 7. Create npm tarball
echo "📦 Creating npm tarball..."
npm pack

TARBALL="crewswarm-${VERSION}.tgz"

# 8. Create GitHub release (requires gh CLI)
if command -v gh &> /dev/null; then
  if [ "$DRAFT" = "--draft" ]; then
    echo "📝 Creating DRAFT GitHub release (not public yet)..."
    gh release create "v${VERSION}" \
      --title "CrewSwarm v${VERSION} — Public Beta" \
      --notes-file CHANGELOG.md \
      --draft \
      --prerelease
    echo "✅ Draft created! Review at: https://github.com/${REPO}/releases"
    echo "   When ready to publish: gh release edit v${VERSION} --draft=false"
  else
    echo "🎉 Creating PUBLIC GitHub release..."
    gh release create "v${VERSION}" \
      --title "CrewSwarm v${VERSION} — Public Beta" \
      --notes-file CHANGELOG.md \
      --prerelease
  fi
  
  echo "📎 Uploading tarball..."
  gh release upload "v${VERSION}" "${TARBALL}"
  
  echo "⚙️  Setting repo metadata..."
  gh repo edit "${REPO}" \
    --description "PM-led multi-agent orchestration for software development" \
    --homepage "https://crewswarm.ai"
  
  gh repo edit "${REPO}" \
    --add-topic ai \
    --add-topic multi-agent \
    --add-topic llm \
    --add-topic orchestration \
    --add-topic autonomous-agents \
    --add-topic developer-tools \
    --add-topic nodejs \
    --add-topic typescript
  
  echo ""
  if [ "$DRAFT" = "--draft" ]; then
    echo "✅ Draft release created (not public yet)"
    echo "🔗 View at: https://github.com/${REPO}/releases"
    echo ""
    echo "📋 Next steps when ready to go public:"
    echo "   1. Review the draft release"
    echo "   2. Run: gh release edit v${VERSION} --draft=false"
    echo "   3. Announce on HN, Twitter, LinkedIn"
  else
    echo "✅ Release complete and PUBLIC!"
    echo "🔗 View at: https://github.com/${REPO}/releases/tag/v${VERSION}"
    echo ""
    echo "📢 Next: Announce on HN, Twitter, LinkedIn"
  fi
else
  echo "⚠️  gh CLI not found. Install with: brew install gh"
  echo "   Then run: gh auth login"
  echo ""
  echo "Manual steps:"
  echo "1. Go to: https://github.com/${REPO}/releases/new?tag=v${VERSION}"
  echo "2. Paste CHANGELOG.md as description"
  echo "3. Upload ${TARBALL}"
  echo "4. Check 'This is a pre-release'"
  echo "5. Publish release"
fi

echo ""
echo "📢 Next: Announce on HN, Twitter, LinkedIn"
echo "    See LAUNCH-POLISH-CHECKLIST.md for templates"
