/**
 * Model-family detection helpers.
 */

export function isGemini3Model(model: string): boolean {
  return String(model || '').toLowerCase().includes('gemini-3');
}
