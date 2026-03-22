import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { spawn } from 'child_process';

const configDir = path.join(os.homedir(), '.crewswarm');
const configPath = path.join(configDir, 'crewswarm.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

async function main() {
  console.log('🚀 Welcome to the CrewSwarm Wow Factor Demo!\n');
  
  // 1. Check API Keys
  let config = { providers: {} };
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error('Failed to parse crewswarm.json');
    }
  }

  if (!config.providers) config.providers = {};
  
  const hasGroq = !!config.providers.groq;
  const hasAnyKey = Object.keys(config.providers).length > 0;

  if (!hasAnyKey && !hasGroq) {
    console.log('No API keys found. For the fastest experience, let\'s use Groq (it provides a generous free tier).');
    console.log('Get a free key here: https://console.groq.com/keys');
    const key = await askQuestion('\nPaste your Groq API key: ');
    if (key.trim()) {
      config.providers.groq = key.trim();
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('✅ Key saved to ~/.crewswarm/crewswarm.json\n');
    } else {
      console.log('No key provided. Exiting.');
      process.exit(1);
    }
  } else {
    console.log('✅ API keys found. Ready to proceed.\n');
  }

  rl.close();

  // 2. Dispatch the Wow task
  console.log('✨ Dispatching the swarm to build an animated glassmorphism website...');
  console.log('Please stand by while the agents plan, write code, and verify it (this normally takes ~2 minutes)...\n');

  const prompt = `Build a stunning, modern single-page portfolio website. Include glassmorphism CSS effects, a beautiful gradient background, a dark mode toggle, and smooth JavaScript scroll animations. Save the index.html, styles.css, and script.js files to a new folder called 'wow-demo'.`;

  // Provide exactly the right path to crew-cli.mjs
  const cliPath = path.join(process.cwd(), 'crew-cli.mjs');
  
  const crewProcess = spawn('node', [cliPath, prompt], {
    stdio: 'inherit',
    cwd: process.cwd()
  });

  crewProcess.on('close', (code) => {
    if (code === 0) {
      console.log('\n🎉 Build Complete! Opening the result in your browser...');
      const targetFilePath = path.join(process.cwd(), 'wow-demo', 'index.html');
      try {
        if (process.platform === 'darwin') {
          spawn('open', [targetFilePath], { detached: true });
        } else if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', targetFilePath], { detached: true });
        } else {
          spawn('xdg-open', [targetFilePath], { detached: true });
        }
      } catch (e) {
        console.log(`Could not auto-open the browser. Please open ${targetFilePath} manually.`);
      }
    } else {
      console.log(`\n❌ Task failed with exit code ${code}`);
    }
  });
}

main().catch(console.error);
