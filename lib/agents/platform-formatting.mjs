/**
 * Platform-specific formatting instructions for agents
 * Teaches agents how to format messages for Telegram, WhatsApp, etc.
 */

export const TELEGRAM_FORMATTING = `
## Telegram Formatting — Use These

**Text Styling:**
- *bold text* for emphasis (restaurant names, key points)
- _italic text_ for descriptions
- \`code text\` for addresses, promo codes
- [Link text](https://url) for clickable links

**Lists:**
- Use • or numbered lists
- Keep entries concise

**Structure:**
🔥 *Restaurant Name*
_Description in italics_
⭐ Rating • 💰 Price range
📍 Address
[View on map](https://maps.google.com/?q=address)

**Emojis:** Use strategically (🦜 🔥 💰 📍 ⭐ 🍽️)
`;

export const WHATSAPP_FORMATTING = `
## WhatsApp Formatting — CRITICAL RULES

**Text Styling:**
- *bold* for restaurant names, key points
- _italic_ for descriptions  
- ~strikethrough~ for alternatives
- \`\`\`code\`\`\` for addresses or promo codes

**Links (CRITICAL):**
❌ WRONG: [Restaurant Name](https://url) ← This breaks in WhatsApp!
✅ CORRECT: Just paste the URL on its own line:
   *Restaurant Name* 🔥
   _Description here_
   https://restaurant-url.com

WhatsApp will auto-preview URLs with images. Keep URLs on their own line.

**Structure Example:**
¡Órale! 🦜

*Dave's Pub & Grill*
_Classic burgers, local favorite_
⭐ 4.5 • 💰 Moderate
📍 70671 Bluewater Hwy, Grand Bend
https://davespub.com

*Taco Shack*
_Authentic Mexican, no gringo BS_
⭐ 4.8 • 💰 Budget-friendly
📍 123 Main St, Grand Bend
https://tacoshack.com

**Keep It Tight:**
- Under 500 chars per message
- 2-3 recommendations max
- One URL per venue
- Use \\n\\n between venues for spacing

**Google Maps Links Format:**
https://maps.google.com/?q=Street+Address+City+Province+PostalCode
(Replace spaces with +)
`;

export const DASHBOARD_FORMATTING = `
## Dashboard Chat Formatting

**Use Markdown:**
- **Bold** for emphasis
- *Italic* for notes
- \`code\` for file paths, commands
- [Links](url) work normally
- Code blocks: \`\`\`language\\ncode\\n\`\`\`

**Structure:** Clear, professional, technical details OK
`;

/**
 * Get platform-specific formatting instructions
 * @param {string} platform - 'telegram', 'whatsapp', 'dashboard', or null
 * @returns {string} Formatting instructions
 */
export function getPlatformFormatting(platform) {
  switch (platform) {
    case 'telegram':
      return TELEGRAM_FORMATTING;
    case 'whatsapp':
      return WHATSAPP_FORMATTING;
    case 'dashboard':
      return DASHBOARD_FORMATTING;
    default:
      return ''; // No special formatting
  }
}
