import xxhash from 'xxhash-wasm';

const CCH_SEED = BigInt('0x6E52736AC806831E');
let _h64: ((input: string, seed?: bigint) => bigint) | null = null;

async function getHasher() {
  if (!_h64) {
    const wasm = await xxhash();
    _h64 = wasm.h64;
  }
  return _h64;
}

export async function computeCch(body: string): Promise<string> {
  const h64 = await getHasher();
  const hash = h64(body, CCH_SEED);
  const masked = hash & BigInt(0xfffff);
  return Number(masked).toString(16).padStart(5, '0');
}

export function buildBillingHeader(cch: string, version = '2.1.87'): string {
  return `cc_version=${version}; cc_entrypoint=unknown; cch=${cch};`;
}
