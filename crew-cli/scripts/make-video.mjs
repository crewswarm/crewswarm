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
    const port = 9223;
    const framesDir = join(projectRoot, 'tmp', 'frames');
    const outputVideo = join(projectRoot, 'docs', 'marketing', 'demo.mp4');
    const templateUrl = `file://${join(projectRoot, 'scripts', 'terminal-template.html')}`;

    console.log('🚀 Starting core demo video generation...');
    await rm(framesDir, { recursive: true, force: true });
    await mkdir(framesDir, { recursive: true });
    await mkdir(dirname(outputVideo), { recursive: true });

    const proc = await launchChromeDebug(templateUrl, port);
    await new Promise(r => setTimeout(r, 2000));
    let ws;
    let frameCount = 0;

    try {
        const wsUrl = await getPageWsUrl(port);
        ws = new WebSocket(wsUrl);
        await new Promise((resolve) => ws.once('open', resolve));
        const client = new CdpClient(ws);

        await client.send('Runtime.enable');
        await client.send('Page.enable');
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

        // --- DEMO SCRIPT ---

        // 1. Initial Banner
        await appendOutput(`
<div class="info"> ╔═══════════════════════════════════════════════════════════════════════════╗
 ║                                                                           ║
 ║     ██████╗ ██████╗ ███████╗██╗    ██╗      ██████╗██╗     ██╗           ║
 ║    ██╔════╝ ██╔══██╗██╔════╝██║    ██║     ██╔════╝██║     ██║           ║
 ║    ██║      ██████╔╝█████╗  ██║ █╗ ██║     ██║     ██║     ██║           ║
 ║    ██║      ██╔══██╗██╔══╝  ██║███╗██║     ██║     ██║     ██║           ║
 ║    ╚██████╗ ██║  ██║███████╗╚███╔███╔╝     ╚██████╗███████╗██║           ║
 ║     ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚══╝╚══╝       ╚═════╝╚══════╝╚═╝           ║
 ║                                                                           ║
 ║              🎪  Multi-Agent Orchestrator  •  v0.1.0-alpha                ║
 ║                                                                           ║
 ╚═══════════════════════════════════════════════════════════════════════════╝</div>`, 45);

        // 2. Explore Mode
        await typeCommand('crew explore "refactor database to sqlite3"');
        await appendOutput('<div class="info">[INFO] 🔀 Exploring 3 approaches in parallel sandbox branches...</div>', 45);
        await appendOutput('<div class="success">[SUCCESS] Completed: explore-minimal (12 files)</div>', 15);
        await appendOutput('<div class="success">[SUCCESS] Completed: explore-clean (18 files)</div>', 15);
        await appendOutput('<div class="success">[SUCCESS] Completed: explore-pragmatic (15 files)</div>', 60);

        // 3. Preview
        await typeCommand('crew preview explore-clean');
        await appendOutput(`
<div class="gray">--- Sandbox Preview [explore-clean] ---
 M src/db.js
 A src/models/User.js
 A src/models/Product.js

 <span class="success">+ import sqlite3 from 'sqlite3';</span>
 <span class="success">+ const db = new sqlite3.Database(':memory:');</span>
 <span class="error">- // old local storage logic</span>
... (18 files changed)</div>`, 90);

        // 4. LSP Check
        await typeCommand('crew lsp check src/db.js');
        await appendOutput('<div class="success">[SUCCESS] No type errors found in the staged sandbox version.</div>', 60);

        // 5. Parallel Workers
        await clear();
        await typeCommand('crew plan "add CRUD for products and orders" --parallel --concurrency 2');
        await appendOutput('<div class="info">[INFO] Generating plan for: add CRUD for products and orders</div>', 30);
        await appendOutput('<div class="info">[WorkerPool] Starting task: step-1 (products-api)</div>', 10);
        await appendOutput('<div class="info">[WorkerPool] Starting task: step-2 (orders-api)</div>', 40);
        await appendOutput('<div class="success">[WorkerPool] Task completed: step-1</div>', 10);
        await appendOutput('<div class="success">[WorkerPool] Task completed: step-2</div>', 15);
        await appendOutput('<div class="success">Parallel execution complete: 2 succeeded, 0 failed.</div>', 60);

        // 6. Blast Radius
        await typeCommand('crew blast-radius');
        await appendOutput(`
<div class="warn">--- Blast Radius Analysis ---
Risk Score: <span class="error">HIGH</span>
Impacted Files: 7
Direct Dependencies: src/server.js, src/api/routes.js
Recursive Impact: 12 modules potentially affected.</div>`, 90);

        // 7. Apply & Auto-Fix
        await typeCommand('crew apply --check "npm test"');
        await appendOutput('<div class="info">[INFO] Running check: npm test</div>', 30);
        await appendOutput('<div class="error">[ERROR] Check failed: ReferenceError: sqlite is not defined</div>', 30);
        await appendOutput('<div class="info">[INFO] Attempting auto-fix by dispatching to crew-fixer...</div>', 45);
        await appendOutput('<div class="success">✓ Auto-fix applied. Re-running check...</div>', 30);
        await appendOutput('<div class="success">[SUCCESS] Check passed! Changes written to disk.</div>', 90);

        console.log(`✅ Generated ${frameCount} frames.`);

        // --- STITCH VIDEO ---
        console.log('🎞️ Stitching video with ffmpeg...');
        execSync(`ffmpeg -y -framerate 30 -i ${join(framesDir, 'frame_%05d.png')} -c:v libx264 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" ${outputVideo}`);

        console.log(`🎉 Video saved to ${outputVideo}`);

        // --- OPTIMIZE VIDEO ---
        console.log('✨ Optimizing core demo video...');
        execSync(`ffmpeg -y -i ${outputVideo} -vcodec libx264 -crf 28 -preset slower -movflags +faststart ${outputVideo.replace('.mp4', '_opt.mp4')}`);
        execSync(`mv ${outputVideo.replace('.mp4', '_opt.mp4')} ${outputVideo}`);
        console.log('✅ Core demo video optimized.');

    } catch (err) {
        console.error('❌ Error during video generation:', err);
    } finally {
        if (ws) ws.close();
        proc.kill('SIGTERM');
    }
}

main();
