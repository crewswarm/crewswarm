import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

console.log('Beginning config path consolidation...');

// 1. Files containing config.json
const filesRaw = execSync('git grep -l "config.json" || true').toString().split('\n').filter(Boolean);
let updatedCount = 0;

for (const file of filesRaw) {
  // skip package.json, lock files, and this very script
  if (file.includes('package') || file.includes('refactor-configs.mjs') || file.includes('CHANGELOG.md')) continue;
  
  const fullPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) continue;

  let content = fs.readFileSync(fullPath, 'utf8');
  const og = content;
  
  // Replace direct string paths
  content = content.replace(/\.crewswarm[\/\\]config\.json/g, '.crewswarm/crewswarm.json');
  
  // Replace path.join(..., "config.json") -> path.join(..., "crewswarm.json")
  // We only replace "config.json" exactly.
  content = content.replace(/"config\.json"/g, '"crewswarm.json"');
  content = content.replace(/'config\.json'/g, "'crewswarm.json'");
  
  // Also handle `config.json` in markdown text
  content = content.replace(/`~\/\.crewswarm\/config\.json`/g, '`~/.crewswarm/crewswarm.json`');
  
  if (content !== og) {
    fs.writeFileSync(fullPath, content);
    console.log(`Updated ${file}`);
    updatedCount++;
  }
}

console.log(`Successfully updated ${updatedCount} files to use crewswarm.json contextually.`);
