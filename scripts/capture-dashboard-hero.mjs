#!/usr/bin/env node
/**
 * Capture hero screenshots for README and docs
 * Usage: node scripts/capture-dashboard-hero.mjs
 * 
 * Outputs:
 * - docs/images/dashboard-chat.png — Chat tab with conversation
 * - docs/images/dashboard-agents.png — Agents tab showing crew
 * - docs/images/dashboard-build.png — Build tab
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'docs', 'images');
mkdirSync(OUT, { recursive: true });

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://127.0.0.1:4319';
const VIEWPORT = { width: 1400, height: 900 };

console.log('🚀 Launching browser...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: VIEWPORT });

try {
  console.log(`📡 Connecting to dashboard at ${DASHBOARD_URL}...`);
  await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);

  // 1. Chat tab — most important for README hero
  console.log('📸 Capturing Chat tab...');
  await page.click('#navChat').catch(() => console.log('   Chat already active'));
  await page.waitForTimeout(800);
  await page.screenshot({ 
    path: join(OUT, 'dashboard-chat.png'),
    fullPage: false
  });
  console.log('   ✅ docs/images/dashboard-chat.png');

  // 2. Agents tab — show the crew
  console.log('📸 Capturing Agents tab...');
  await page.click('#navAgents');
  await page.waitForTimeout(800);
  await page.screenshot({ 
    path: join(OUT, 'dashboard-agents.png'),
    fullPage: false
  });
  console.log('   ✅ docs/images/dashboard-agents.png');

  // 3. Build tab — show PM loop in action
  console.log('📸 Capturing Build tab...');
  await page.click('#navBuild');
  await page.waitForTimeout(800);
  await page.screenshot({ 
    path: join(OUT, 'dashboard-build.png'),
    fullPage: false
  });
  console.log('   ✅ docs/images/dashboard-build.png');

  // 4. Services tab — show all services running
  console.log('📸 Capturing Services tab...');
  await page.click('#navServices');
  await page.waitForTimeout(800);
  await page.screenshot({ 
    path: join(OUT, 'dashboard-services.png'),
    fullPage: false
  });
  console.log('   ✅ docs/images/dashboard-services.png');

  console.log('\n✨ Done! Screenshots saved to docs/images/');
  console.log('\n📝 Next: Add to README.md:');
  console.log('   ![Dashboard Chat](docs/images/dashboard-chat.png)');

} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
} finally {
  await browser.close();
}
