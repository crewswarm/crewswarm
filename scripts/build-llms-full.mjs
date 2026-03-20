import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const websiteDir = path.join(rootDir, 'website');
const docsDir = path.join(rootDir, 'docs', 'CANONICAL');

function readFileContent(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  return '';
}

async function main() {
  console.log('📚 Compiling massive llms-full.txt for comprehensive AI ingestion...');
  
  let content = [];
  
  content.push('# crewswarm Complete Documentation File (For AI Crawlers)');
  content.push('This file contains the complete repository state, architecture, and documentation for crewswarm to be fully ingested by LLMs.\n');
  
  content.push('\n## 1. README / Mission\n');
  content.push(readFileContent(path.join(rootDir, 'README.md')));

  content.push('\n## 2. LLM Summary / Site map\n');
  content.push(readFileContent(path.join(websiteDir, 'llms.txt')));

  content.push('\n## 3. AGENTS Architecture\n');
  content.push(readFileContent(path.join(rootDir, 'AGENTS.md')));

  content.push('\n## 4. ATAT Protocol\n');
  content.push(readFileContent(path.join(docsDir, 'ATAT-PROTOCOL.md'))); // Just an example, maybe there are other docs
  
  content.push('\n## 5. Security & Isolation\n');
  content.push(readFileContent(path.join(rootDir, 'SECURITY.md')));

  content.push('\n## 6. Website Text (Unformatted)\n');
  // Grab index.html and strip basic tags just for bare text context
  let indexHtml = readFileContent(path.join(websiteDir, 'index.html'));
  if (indexHtml) {
    const stripped = indexHtml.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ');
    content.push(stripped);
  }

  const resultStr = content.join('\n\n====================================================\n\n');
  
  fs.writeFileSync(path.join(websiteDir, 'llms-full.txt'), resultStr);
  console.log('✅ Wrote ' + path.join(websiteDir, 'llms-full.txt'));
}

main();
