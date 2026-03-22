import { launchChromeDebug, getPageWsUrl, CdpClient } from '../src/browser/index.ts';
import WebSocket from 'ws';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

async function main() {
    const port = 9224;
    const framesDir = join(projectRoot, 'tmp', 'frames_autonomous');
    const outputVideo = join(projectRoot, 'docs/marketing/autonomous-agent.mp4');
    const templateUrl = `file://${join(projectRoot, 'scripts', 'terminal-template.html')}`;

    console.log('🚀 Starting autonomous agent video generation...');
    await rm(framesDir, { recursive: true, force: true });
    await mkdir(framesDir, { recursive: true });
    await mkdir(dirname(outputVideo), { recursive: true });

    const proc = await launchChromeDebug(templateUrl, port);
    let ws;
    let frameCount = 0;

    try {
        const wsUrl = await getPageWsUrl(port);
        ws = new WebSocket(wsUrl);
        await new Promise((resolve) => ws.once('open', resolve));
        const client = new CdpClient(ws);

        await client.send('Runtime.enable');
        await client.send('Page.enable');
        // Set viewport size for 1080p
        await client.send('Emulation.setDeviceMetricsOverride', {
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
            mobile: false
        });

        const takeFrame = async (repeat = 1) => {
            const res = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
            const data = res.result?.data || res.data;
            const buffer = Buffer.from(data, 'base64');
            for (let i = 0; i < repeat; i++) {
                frameCount++;
                const filename = `frame_${String(frameCount).padStart(5, '0')}.png`;
                await writeFile(join(framesDir, filename), buffer);
            }
        };

        const evalJs = (code) => client.send('Runtime.evaluate', { expression: code, awaitPromise: true });

        const typeCommand = async (cmd) => {
            await evalJs(`
                (function() {
                    let terminal = document.getElementById('terminal');
                    let line = document.createElement('div');
                    line.innerHTML = '<span class="prompt">$ </span><span class="cmd"></span><span class="cursor"></span>';
                    terminal.appendChild(line);
                })()
            `);
            const chars = cmd.split('');
            let current = '';
            for (const char of chars) {
                current += char;
                await evalJs(`document.querySelector('div:last-child .cmd').textContent = ${JSON.stringify(current)}`);
                await takeFrame(2);
            }
            await evalJs(`if(document.querySelector('.cursor')) document.querySelector('.cursor').remove()`);
            await takeFrame(10);
        };

        const appendOutput = async (html, holdFrames = 30) => {
            await evalJs(`window.appendLine(${JSON.stringify(html)})`);
            await takeFrame(holdFrames);
        };

        const clear = async () => {
            await evalJs(`window.clearTerminal()`);
            await takeFrame(5);
        };

        // --- AUTONOMOUS SCRIPT ---

        // 1. Initial Prompt
        await typeCommand('crew plan "implement natural language shell translation"');
        await appendOutput('<div class="info">[INFO] 🧠 Routing to crew-pm...</div>', 20);
        await appendOutput(`
<div class="gray">--- Proposed Execution Plan ---
1. Create src/shell/index.ts module.
2. Define ShellCopilot options and interfaces.
3. Implement NL-to-Bash translation logic.
4. Add interactive inquirer prompt for user confirmation.
5. Integrate "crew shell" command into CLI entry point.
6. Add unit tests for command parsing.</div>`, 60);

        // 2. Start Execution
        await appendOutput('<div class="info">[INFO] Executing Step 1: Create src/shell/index.ts</div>', 15);
        await appendOutput('<div class="success">[SUCCESS] File created: src/shell/index.ts</div>', 10);
        
        await appendOutput('<div class="info">[INFO] Executing Step 2 & 3: Implementation</div>', 15);
        await appendOutput(`
<div class="gray">FILE: src/shell/index.ts
<span class="success">+ export async function runShellCopilot(...) {</span>
<span class="success">+   const systemContext = \`You are a shell assistant...\`;</span>
<span class="success">+   const result = await router.dispatch(\'crew-main\', ...);</span>
<span class="success">+   // ... (logic)</span>
<span class="success">+ }</span></div>`, 45);

        // 3. LLM detects an issue (The "Self-Healing" part)
        await appendOutput('<div class="info">[INFO] Validating implementation with LSP...</div>', 20);
        await appendOutput('<div class="error">[ERROR] LSP: [L67:32] Unterminated string literal in src/shell/index.ts</div>', 40);
        
        await appendOutput('<div class="info">[INFO] 🔧 Agent fixing its own error...</div>', 30);
        await appendOutput(`
<div class="gray">&lt;&lt;&lt;&lt;&lt;&lt; SEARCH
      const lines = text.split(\'
======
      const lines = text.split(\'\\n\');
&gt;&gt;&gt;&gt;&gt;&gt; REPLACE</div>`, 40);
        await appendOutput('<div class="success">[SUCCESS] Self-correction applied.</div>', 20);

        // 4. Verification
        await appendOutput('<div class="info">[INFO] Re-running LSP check...</div>', 15);
        await appendOutput('<div class="success">[SUCCESS] No type errors found.</div>', 30);

        // 5. Final Step
        await appendOutput('<div class="info">[INFO] Executing Step 5: CLI Integration</div>', 15);
        await appendOutput('<div class="success">[SUCCESS] Integrated "crew shell" into src/cli/index.ts</div>', 30);

        // 6. Test it!
        await clear();
        await appendOutput('<div class="info">--- Testing the new feature ---</div>', 20);
        await typeCommand('crew shell "list all large files in src"');
        await appendOutput('<div class="info">[INFO] Translating request...</div>', 15);
        await appendOutput(`
<div class="blue">--- Proposed Command ---</div>
<div class="success"><b>> find src -type f -size +100k -exec ls -lh {} +</b></div>
<div class="gray">This command finds files in \'src\' larger than 100KB and lists them with sizes.</div>`, 60);

        await appendOutput('<div class="success"><b>🎉 Goal Reached: Feature implemented, verified, and functional.</b></div>', 90);

        console.log(`✅ Generated ${frameCount} frames.`);

        // --- STITCH VIDEO ---
        console.log('🎞️ Stitching video with ffmpeg...');
        execSync(`ffmpeg -y -framerate 30 -i ${join(framesDir, 'frame_%05d.png')} -c:v libx264 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" ${outputVideo}`);

        console.log(`🎉 Autonomous demo saved to ${outputVideo}`);

    } catch (err) {
        console.error('❌ Error during autonomous video generation:', err);
    } finally {
        if (ws) ws.close();
        proc.kill('SIGTERM');
    }
}

main();
