/**
 * Preference Extraction — Automatic User Trait Detection
 * 
 * Analyzes conversation history and extracts structured preferences
 * using LLM reasoning. Domain-agnostic templates for different use cases.
 */

/**
 * Preference extraction templates by domain
 */
const TEMPLATES = {
  // GrabLoco / Food recommendations
  food: {
    prompt: `
Analyze this conversation and extract food/dining preferences.

Conversation:
{HISTORY}

Return ONLY valid JSON (no markdown, no explanation):
{
  "diet": "omnivore|vegetarian|vegan|pescatarian|none",
  "allergies": ["peanut", "shellfish", "gluten", "dairy"],
  "favCuisines": ["Thai", "Mexican", "Italian", "Japanese"],
  "spiceLevel": "mild|medium|hot|none",
  "budget": "budget|moderate|upscale|any",
  "diningStyle": "quick|casual|fine-dining|takeout|any",
  "atmosphere": "quiet|lively|romantic|family-friendly|any",
  "dietary_restrictions": ["halal", "kosher", "organic", "low-carb"]
}

RULES:
- Only include fields with EXPLICIT evidence in conversation
- If unsure or no mention, omit the field entirely
- allergies: ONLY if explicitly stated (safety critical!)
- Return {} if no preferences mentioned
`,
    requiredFields: ['diet', 'allergies', 'favCuisines']
  },
  
  // Location + Profile extraction (GrabLoco)
  profile: {
    prompt: `
Analyze this conversation and extract user profile data.

Conversation:
{HISTORY}

Return ONLY valid JSON (no markdown, no explanation):
{
  "city": "Grand Bend",
  "state": "Ontario",
  "country": "Canada",
  "phone": "+15551234567",
  "notes": "Prefers waterfront dining, travels often"
}

RULES:
- Only include fields with EXPLICIT evidence
- city/state/country: Extract if user mentions where they live or are currently located
- phone: Extract ONLY if user explicitly shares their number (format: +[country][number])
- notes: Extract any useful context (travel plans, preferences, complaints, etc.)
- NEVER include sensitive data (passwords, credit cards, SSN)
- NEVER make assumptions — only extract explicitly stated facts
- Return {} if nothing mentioned
`,
    requiredFields: []
  },
  
  // crewswarm / Work collaboration
  work: {
    prompt: `
Analyze this conversation and extract work/collaboration preferences.

Conversation:
{HISTORY}

Return ONLY valid JSON (no markdown, no explanation):
{
  "preferredLanguages": ["TypeScript", "Python", "Go"],
  "frameworks": ["React", "Next.js", "Express"],
  "responseStyle": "detailed|concise|code-first",
  "communicationStyle": "async|real-time|scheduled",
  "workHours": "morning|afternoon|evening|flexible",
  "timezone": "America/Los_Angeles",
  "expertise": ["frontend", "backend", "devops", "ml"],
  "interests": ["architecture", "testing", "performance"]
}

RULES:
- Only include fields with EXPLICIT evidence
- If unsure, omit the field
- Return {} if no preferences mentioned
`,
    requiredFields: ['preferredLanguages', 'responseStyle']
  },
  
  // Generic template (for any domain)
  generic: {
    prompt: `
Analyze this conversation and extract user preferences or traits.

Conversation:
{HISTORY}

Return ONLY valid JSON with any relevant preference fields you detect.
Examples: tone, interests, goals, constraints, dislikes, favorites.

Return {} if no clear preferences mentioned.
`,
    requiredFields: []
  }
};

/**
 * Extract preferences from conversation history
 * 
 * @param {Array} history - Array of {role, content} messages
 * @param {Function} llmCaller - Async function that calls LLM: (messages) => Promise<string>
 * @param {String} domain - "food", "work", or "generic"
 * @returns {Promise<Object>} Extracted preferences as JSON
 */
export async function extractPreferences(history, llmCaller, domain = 'generic') {
  if (!history || history.length === 0) {
    return {};
  }
  
  const template = TEMPLATES[domain] || TEMPLATES.generic;
  
  // Format conversation history
  const conversationText = history
    .slice(-50) // Last 50 messages for context
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  
  const prompt = template.prompt.replace('{HISTORY}', conversationText);
  
  try {
    // Call LLM with extraction prompt
    const response = await llmCaller([
      { 
        role: 'system', 
        content: 'You extract structured data from conversations. Return only valid JSON with no markdown formatting.' 
      },
      { role: 'user', content: prompt }
    ]);
    
    // Clean response (remove markdown code fences if present)
    const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
    
    // Parse JSON
    const preferences = JSON.parse(cleaned);
    
    // Validate required fields exist (if domain specifies them)
    if (template.requiredFields.length > 0) {
      const hasAnyRequired = template.requiredFields.some(field => 
        preferences[field] !== undefined && preferences[field] !== null
      );
      
      if (!hasAnyRequired) {
        console.warn(`[preference-extractor] No required fields found for domain "${domain}"`);
        return {};
      }
    }
    
    return preferences;
  } catch (error) {
    console.error(`[preference-extractor] Failed to extract preferences: ${error.message}`);
    return {};
  }
}

/**
 * Auto-extract preferences from contact history
 * 
 * Convenience wrapper that:
 * 1. Loads contact's message history
 * 2. Extracts preferences
 * 3. Updates contact preferences in DB
 * 
 * @param {String} contactId - Contact ID
 * @param {Function} llmCaller - LLM caller function
 * @param {String} domain - Preference domain
 * @param {Object} deps - { getContactHistory, updatePreferences }
 * @returns {Promise<Object>} Extracted preferences
 */
export async function autoExtractAndSave(contactId, llmCaller, domain, deps) {
  const { getContactHistory, updatePreferences } = deps;
  
  // Load history
  const history = getContactHistory(contactId, 100);
  
  if (history.length < 5) {
    // Not enough conversation to extract meaningful preferences
    return {};
  }
  
  // Extract
  const preferences = await extractPreferences(history, llmCaller, domain);
  
  // Save if we found anything
  if (Object.keys(preferences).length > 0) {
    updatePreferences(contactId, preferences);
    console.log(`[preference-extractor] Updated preferences for ${contactId}:`, preferences);
  }
  
  return preferences;
}

/**
 * Extract profile data and update contact
 * 
 * @param {Array} history - Conversation history
 * @param {Function} llmCaller - LLM caller function
 * @param {String} contactId - Contact ID
 * @param {Function} updateContact - Update function from contacts module
 * @returns {Promise<Object>} Extracted profile data
 */
export async function extractAndSaveProfile(history, llmCaller, contactId, updateContact) {
  if (!history || history.length === 0) {
    return {};
  }
  
  const profile = await extractPreferences(history, llmCaller, 'profile');
  
  if (Object.keys(profile).length === 0) {
    return {};
  }
  
  // Sanitize and validate before saving
  const updates = {};
  
  // Location: Build location string from city/state/country
  if (profile.city || profile.state || profile.country) {
    const parts = [];
    if (profile.city) parts.push(profile.city);
    if (profile.state) parts.push(profile.state);
    if (profile.country) parts.push(profile.country);
    if (parts.length > 0) {
      updates.last_location = parts.join(', ');
    }
  }
  
  // Phone: Validate E.164 format
  if (profile.phone) {
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (phoneRegex.test(profile.phone)) {
      updates.phone_number = profile.phone;
    }
  }
  
  // Notes: Sanitize (prevent injection, max length)
  if (profile.notes) {
    const sanitized = String(profile.notes)
      .replace(/[<>]/g, '')  // Remove HTML tags
      .slice(0, 1000);        // Max 1000 chars
    if (sanitized.length > 0) {
      updates.notes = sanitized;
    }
  }
  
  // Save updates
  if (Object.keys(updates).length > 0) {
    updateContact(contactId, updates);
    console.log(`[preference-extractor] Updated profile for ${contactId}:`, updates);
  }
  
  return profile;
}

/**
 * Check if it's time to extract preferences
 * (e.g., every 10 messages, or if specific keywords detected)
 * 
 * @param {Number} messageCount - Total messages from this contact
 * @param {String} latestMessage - Most recent message content
 * @returns {Boolean} True if extraction should run
 */
export function shouldExtract(messageCount, latestMessage = '') {
  // Extract every 10 messages
  if (messageCount > 0 && messageCount % 10 === 0) {
    return true;
  }
  
  // Extract if user explicitly mentions preferences
  const preferenceKeywords = [
    /i('m| am) (allergic|vegan|vegetarian)/i,
    /i (love|hate|prefer|like|dislike)/i,
    /my favorite/i,
    /i can't (eat|have)/i,
    /i don't (eat|like)/i
  ];
  
  return preferenceKeywords.some(pattern => pattern.test(latestMessage));
}

/**
 * Build system prompt with user preferences
 * Injects preferences into LLM context for personalized responses
 * 
 * @param {String} basePrompt - Original system prompt
 * @param {Object} preferences - User preferences object
 * @param {String} displayName - User's display name
 * @param {Object} contact - Full contact object (for location, timezone, etc.)
 * @returns {String} Enhanced system prompt
 */
export function buildPreferencePrompt(basePrompt, preferences, displayName = 'User', contact = null) {
  const prefLines = [
    `[🔒 PRIVATE — Current User Profile Only]`,
    `Talking to: ${displayName}`,
    `⚠️  NEVER mention data about other users — this profile is for ${displayName} only`
  ];
  
  // Add location context if available (FIRST, most important for recommendations)
  if (contact?.last_location) {
    prefLines.push(`📍 Location: ${contact.last_location}`);
  }
  if (contact?.timezone) {
    prefLines.push(`🕐 Timezone: ${contact.timezone}`);
  }
  
  // Food preferences
  if (preferences.diet) prefLines.push(`Diet: ${preferences.diet}`);
  if (preferences.allergies?.length) {
    prefLines.push(`⚠️  ALLERGIES: ${preferences.allergies.join(', ')} — NEVER recommend venues with these!`);
  }
  if (preferences.favCuisines?.length) prefLines.push(`Favorite cuisines: ${preferences.favCuisines.join(', ')}`);
  if (preferences.spiceLevel) prefLines.push(`Spice preference: ${preferences.spiceLevel}`);
  if (preferences.budget) prefLines.push(`Budget: ${preferences.budget}`);
  if (preferences.diningStyle) prefLines.push(`Dining style: ${preferences.diningStyle}`);
  
  // Work preferences
  if (preferences.preferredLanguages?.length) prefLines.push(`Languages: ${preferences.preferredLanguages.join(', ')}`);
  if (preferences.responseStyle) prefLines.push(`Response style: ${preferences.responseStyle}`);
  if (preferences.timezone && !contact?.timezone) prefLines.push(`Timezone: ${preferences.timezone}`);
  
  // Generic preferences
  if (preferences.interests?.length) prefLines.push(`Interests: ${preferences.interests.join(', ')}`);
  if (preferences.tone) prefLines.push(`Preferred tone: ${preferences.tone}`);
  
  if (prefLines.length === 3) {
    // Only header, no actual data
    return basePrompt;
  }
  
  return `${basePrompt}\n\n${prefLines.join('\n')}`;
}
