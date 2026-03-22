#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'website', 'vibe-assets');
mkdirSync(OUT, { recursive: true });

const VIBE_PORT = 3333;
const SITE_PORT = 8000;

async function startVibe() {
    console.log('🐝 Starting Vibe server...');
    const vibe = spawn('npm', ['start'], { cwd: __dirname });
    return new Promise((resolve) => {
        vibe.stdout.on('data', (data) => {
            if (data.toString().includes('running at')) resolve(vibe);
        });
    });
}

async function startSite() {
    console.log('🌐 Starting Marketing Site server...');
    const site = spawn('python3', ['-m', 'http.server', SITE_PORT.toString()], { cwd: join(__dirname, '..', 'website') });
    return new Promise((resolve) => {
        setTimeout(() => resolve(site), 2000); // Give it a moment to start
    });
}

async function capture() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
        // 1. Capture Vibe IDE
        console.log('📸 Capturing Vibe IDE...');
        await page.goto(`http://127.0.0.1:${VIBE_PORT}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000); // Wait for Monaco and File Tree
        
        // Take a full shot
        await page.screenshot({ path: join(OUT, 'vibe-full.png') });
        
        // 2. Capture the new Vibe Marketing page
        console.log('📸 Capturing Vibe Marketing page...');
        await page.goto(`http://127.0.0.1:${SITE_PORT}/vibe.html`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1000);
        await page.screenshot({ path: join(OUT, 'vibe-marketing-hero.png'), fullPage: false });

        console.log('✨ Screenshots saved to website/vibe-assets/');
    } catch (err) {
        console.error('❌ Error during capture:', err);
    } finally {
        await browser.close();
    }
}

async function main() {
    const vibe = await startVibe();
    const site = await startSite();
    
    await capture();
    
    console.log('🛑 Shutting down servers...');
    vibe.kill();
    site.kill();
}

main().catch(console.error);
