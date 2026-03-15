/**
 * Retry Manager — consolidates auto-retry logic for crew-lead
 * Prevents infinite retry loops by tracking retries per task
 */

const MAX_RETRIES_PER_TASK = 2;
const retryCounters = new Map(); // taskId -> { questions: 0, plans: 0, bails: 0 }

/**
 * Reset retry counters for a task
 */
export function resetRetries(taskId) {
  retryCounters.delete(taskId);
}

/**
 * Check if we can retry for a specific reason
 */
function canRetry(taskId, reason) {
  const counters = retryCounters.get(taskId) || { questions: 0, plans: 0, bails: 0 };
  return counters[reason] < MAX_RETRIES_PER_TASK;
}

/**
 * Increment retry counter for a specific reason
 */
function incrementRetry(taskId, reason) {
  const counters = retryCounters.get(taskId) || { questions: 0, plans: 0, bails: 0 };
  counters[reason]++;
  retryCounters.set(taskId, counters);
}

/**
 * Check if agent asked a question instead of doing work
 */
export function shouldRetryQuestion(taskId, content) {
  const askedQuestion = /(?:would you like|shall i|should i|do you want|want me to|may i|can i proceed|would it help|do you need|is that correct|shall we|ready to proceed|would you prefer|let me know|please (?:confirm|clarify|specify|advise))\??/i.test(content);
  const didWork = /@@WRITE_FILE|@@RUN_CMD|wrote|created|updated|fixed|patched|done\.|complete/i.test(content);
  
  if (askedQuestion && !didWork && canRetry(taskId, 'questions')) {
    incrementRetry(taskId, 'questions');
    return { 
      shouldRetry: true, 
      reason: 'question',
      retryPrompt: "\n\nDo NOT ask for permission or confirmation. Proceed immediately with your best judgment. Just do it."
    };
  }
  return { shouldRetry: false };
}

/**
 * Check if coder agent returned a plan instead of code
 */
export function shouldRetryPlan(taskId, from, content) {
  const isCoderAgent = /crew-coder|crew-frontend|crew-fixer|crew-ml|crew-coder-back|crew-coder-front/.test(from);
  const didWork = /@@WRITE_FILE|@@RUN_CMD|wrote|created|updated|fixed|patched|done\.|complete/i.test(content);
  const returnedPlan = !didWork && content.length > 300 && (
    /##\s+(component|feature|file structure|design|breakdown|overview|plan|approach|implementation plan|technical spec)/i.test(content) ||
    /here'?s? (?:the|my|a|what|how)/i.test(content.slice(0, 200))
  );
  
  if (isCoderAgent && returnedPlan && canRetry(taskId, 'plans')) {
    incrementRetry(taskId, 'plans');
    return {
      shouldRetry: true,
      reason: 'plan',
      retryPrompt: `STOP PLANNING. Your last response was a plan/analysis with no code written.\n\nNow WRITE THE CODE. Use @@WRITE_FILE for every file. Do not describe what you will do — do it.`
    };
  }
  return { shouldRetry: false };
}

/**
 * Check if agent bailed out mid-task
 */
export function shouldRetryBail(taskId, content) {
  const bailed = /couldn'?t complete|could not complete|i'?m sorry[,.]? but|i was unable to|i'?m unable to|session (?:limit|ended|expired)|ran out of|context (?:limit|window)|i (?:apologize|regret)|partial(?:ly)? complete|not (?:all|every|fully) (?:changes?|tasks?|items?|fixes?)/i.test(content);
  
  if (bailed && canRetry(taskId, 'bails')) {
    incrementRetry(taskId, 'bails');
    return {
      shouldRetry: true,
      reason: 'bail',
      retryPrompt: `Your previous attempt at this task was incomplete. You said you couldn't finish.\n\nDo not apologize. Do not explain why you couldn't finish. Just complete the remaining work now. Use @@WRITE_FILE for every file you change. If the task is too large, complete the most critical items first.`
    };
  }
  return { shouldRetry: false };
}

/**
 * Check all retry conditions and return the first match
 */
export function checkRetries(taskId, from, content) {
  // Check in priority order: bail > plan > question
  let result = shouldRetryBail(taskId, content);
  if (result.shouldRetry) return result;
  
  result = shouldRetryPlan(taskId, from, content);
  if (result.shouldRetry) return result;
  
  result = shouldRetryQuestion(taskId, content);
  if (result.shouldRetry) return result;
  
  return { shouldRetry: false };
}

/**
 * Get retry statistics for monitoring
 */
export function getRetryStats() {
  const stats = { totalTasks: retryCounters.size, byReason: { questions: 0, plans: 0, bails: 0 } };
  for (const counters of retryCounters.values()) {
    stats.byReason.questions += counters.questions;
    stats.byReason.plans += counters.plans;
    stats.byReason.bails += counters.bails;
  }
  return stats;
}
