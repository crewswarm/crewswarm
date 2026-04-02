import { createHash } from 'node:crypto';
import xxhash from 'xxhash-wasm';

const CCH_SEED = BigInt('0x6E52736AC806831E');
const VERSION = '2.1.87';
const SALT = '59cf53e54c78';

let _h64: ((input: string, seed?: bigint) => bigint) | null = null;

async function getHasher() {
  if (!_h64) {
    const wasm = await xxhash();
    _h64 = wasm.h64;
  }
  return _h64;
}

/** Compute 3-char version suffix from the first user message content */
export function computeVersionSuffix(firstUserMessage: string): string {
  const msg = firstUserMessage || '';
  const chars = [4, 7, 20].map(i => (i < msg.length ? msg[i] : '0')).join('');
  return createHash('sha256')
    .update(`${SALT}${chars}${VERSION}`)
    .digest('hex')
    .slice(0, 3);
}

/** Compute cch hash over the full body string (which must contain cch=00000 placeholder) */
export async function computeCch(bodyWithPlaceholder: string): Promise<string> {
  const h64 = await getHasher();
  const hash = h64(bodyWithPlaceholder, CCH_SEED);
  return Number(hash & BigInt(0xfffff)).toString(16).padStart(5, '0');
}

/**
 * Build the billing system block that goes as the FIRST element of the system array.
 * cch=00000 is the placeholder — must be replaced after hashing the full body.
 */
export function buildBillingBlock(suffix: string): { type: 'text'; text: string } {
  return {
    type: 'text',
    text: `x-anthropic-billing-header: cc_version=${VERSION}.${suffix}; cc_entrypoint=cli; cch=00000;`,
  };
}

/**
 * Given a body object (with cch=00000 placeholder in system[0]),
 * serialize it with system before messages, compute CCH, replace placeholder.
 * Returns the final body string ready to send.
 */
export async function signBody(bodyObj: Record<string, unknown>): Promise<string> {
  // Ensure system is serialized before messages (key order matters for hash)
  const { system, messages, ...rest } = bodyObj as any;
  const ordered = { ...rest, ...(system !== undefined ? { system } : {}), ...(messages !== undefined ? { messages } : {}) };
  const bodyStr = JSON.stringify(ordered, null, 0);
  const cch = await computeCch(bodyStr);
  return bodyStr.replace('cch=00000', `cch=${cch}`);
}
