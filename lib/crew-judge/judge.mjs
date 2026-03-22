/**
 * Crew Judge — Autonomous cycle decision maker
 * 
 * After each PM loop iteration or wave completion, judge evaluates:
 * - Roadmap status (items completed, remaining)
 * - Quality of recent work (file diffs, test results)
 * - Progress velocity (items/hour, cost/item)
 * 
 * Returns: CONTINUE, SHIP, or RESET with reasoning
 * 
 * Based on Cursor's research: "At the end of each cycle, a judge agent determined 
 * whether to continue, then the next iteration would start fresh."
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Judge evaluation after PM loop iteration
 * @param {Object} context
 * @param {string} context.roadmapPath - Path to ROADMAP.md
 * @param {Array} context.completedItems - List of items completed this cycle
 * @param {Array} context.failedItems - List of items that failed
 * @param {number} context.itemsRemaining - Number of unchecked items left
 * @param {number} context.cycleNumber - Which iteration this is
 * @param {number} context.costThisCycle - $ spent this cycle
 * @param {string} context.projectDir - Output directory (for diffs)
 * @returns {Promise<{decision: 'CONTINUE'|'SHIP'|'RESET', reasoning: string, confidence: number}>}
 */
export async function judgeNextCycle(context) {
  const {
    roadmapPath,
    completedItems = [],
    failedItems = [],
    itemsRemaining = 0,
    cycleNumber = 1,
    costThisCycle = 0,
    projectDir = null
  } = context;

  // Read roadmap for analysis
  let roadmapContent = '';
  if (existsSync(roadmapPath)) {
    roadmapContent = await readFile(roadmapPath, 'utf-8');
  }

  // Analyze recent work
  const totalItems = completedItems.length + failedItems.length;
  const successRate = totalItems > 0 ? completedItems.length / totalItems : 0;
  const hasFailures = failedItems.length > 0;
  
  // Build judge prompt
  const prompt = buildJudgePrompt({
    roadmapContent,
    completedItems,
    failedItems,
    itemsRemaining,
    cycleNumber,
    costThisCycle,
    successRate,
    hasFailures,
    projectDir
  });

  // Call judge model (cheap, fast)
  const judgeModel = getJudgeModel();
  const decision = await callJudgeModel(judgeModel, prompt);
  
  return decision;
}

function buildJudgePrompt(data) {
  const {
    roadmapContent,
    completedItems,
    failedItems,
    itemsRemaining,
    cycleNumber,
    costThisCycle,
    successRate,
    hasFailures
  } = data;

  return `You are crew-judge. Evaluate the PM loop cycle and decide: CONTINUE, SHIP, or RESET.

# Context

**Cycle:** ${cycleNumber}
**Items completed this cycle:** ${completedItems.length}
**Items failed this cycle:** ${failedItems.length}
**Success rate:** ${(successRate * 100).toFixed(0)}%
**Items remaining:** ${itemsRemaining}
**Cost this cycle:** $${costThisCycle.toFixed(4)}

${completedItems.length > 0 ? `## Completed\n${completedItems.map((item, i) => `${i + 1}. ${item}`).join('\n')}` : ''}

${failedItems.length > 0 ? `## Failed\n${failedItems.map((item, i) => `${i + 1}. ${item}`).join('\n')}` : ''}

${itemsRemaining > 0 ? `## Remaining items\n${itemsRemaining} unchecked items in roadmap` : '## Roadmap complete — all items checked'}

# Roadmap excerpt

\`\`\`
${roadmapContent.substring(0, 2000)}${roadmapContent.length > 2000 ? '\n...(truncated)' : ''}
\`\`\`

# Decision criteria

**CONTINUE** if:
- Clear progress being made (>50% success rate)
- More work remains and it's productive
- No signs of drift (tunnel vision on minor polish)
- Cost per item is reasonable

**SHIP** if:
- Core functionality complete (most items checked)
- Remaining items are polish/nice-to-have
- Success rate good (>70%) and no blocking failures
- Diminishing returns (polishing vs building)

**RESET** if:
- High failure rate (>50% failed this cycle)
- Agent drift detected (too many iterations on same area)
- Wasting budget (cost increasing but quality flat)
- Need fresh context (tunnel vision symptoms)

# Output format

Respond with ONLY:
\`\`\`json
{
  "decision": "CONTINUE" | "SHIP" | "RESET",
  "reasoning": "<2-3 sentence explanation>",
  "confidence": 0.0-1.0
}
\`\`\`

Be decisive. Default to SHIP if work is good enough — perfect is the enemy of shipped.`;
}

function getJudgeModel() {
  // Read from config or env var
  const judgeModel = process.env.CREW_JUDGE_MODEL 
    || process.env.PM_JUDGE_MODEL
    || 'groq/llama-3.3-70b-versatile'; // Default: free, fast, decisive
  
  return judgeModel;
}

async function callJudgeModel(model, prompt) {
  // Import LLM caller from crew-lead
  const { callLLMForText } = await import('../crew-lead/llm-caller.mjs');
  
  try {
    const response = await callLLMForText({
      provider: model.split('/')[0],
      model: model.split('/').slice(1).join('/'),
      messages: [
        {
          role: 'system',
          content: 'You are crew-judge. Return ONLY valid JSON: {"decision": "CONTINUE"|"SHIP"|"RESET", "reasoning": "...", "confidence": 0.0-1.0}'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3, // Lower temperature for more consistent decisions
      maxTokens: 500
    });

    // Parse JSON response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[crew-judge] No JSON in response, defaulting to CONTINUE');
      return {
        decision: 'CONTINUE',
        reasoning: 'Judge response parsing failed',
        confidence: 0.5
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate
    if (!['CONTINUE', 'SHIP', 'RESET'].includes(parsed.decision)) {
      console.warn('[crew-judge] Invalid decision, defaulting to CONTINUE');
      return {
        decision: 'CONTINUE',
        reasoning: parsed.reasoning || 'Invalid decision format',
        confidence: 0.5
      };
    }

    return {
      decision: parsed.decision,
      reasoning: parsed.reasoning || 'No reasoning provided',
      confidence: Math.max(0, Math.min(1, parsed.confidence || 0.7))
    };

  } catch (error) {
    console.error('[crew-judge] Error calling model:', error.message);
    // Fail open — continue by default
    return {
      decision: 'CONTINUE',
      reasoning: `Judge error: ${error.message}`,
      confidence: 0.3
    };
  }
}

/**
 * Simple heuristic judge (fallback if LLM call fails)
 */
export function heuristicJudge(context) {
  const {
    completedItems = [],
    failedItems = [],
    itemsRemaining = 0,
    cycleNumber = 1
  } = context;

  const totalItems = completedItems.length + failedItems.length;
  const successRate = totalItems > 0 ? completedItems.length / totalItems : 1;
  
  // Reset if high failure rate
  if (successRate < 0.5 && failedItems.length >= 3) {
    return {
      decision: 'RESET',
      reasoning: 'High failure rate detected — fresh context needed',
      confidence: 0.8
    };
  }

  // Ship if roadmap mostly complete and recent success
  if (itemsRemaining <= 2 && successRate > 0.7) {
    return {
      decision: 'SHIP',
      reasoning: 'Core work complete, high success rate',
      confidence: 0.9
    };
  }

  // Ship if many cycles with good progress (avoid infinite polish)
  if (cycleNumber >= 5 && successRate > 0.6 && itemsRemaining < 5) {
    return {
      decision: 'SHIP',
      reasoning: 'Diminishing returns — ship what we have',
      confidence: 0.7
    };
  }

  // Continue by default
  return {
    decision: 'CONTINUE',
    reasoning: 'Work in progress, making good progress',
    confidence: 0.6
  };
}
