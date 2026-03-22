export function factorial(n: number): number {
  if (!Number.isInteger(n)) {
    throw new Error('factorial only supports integers');
  }
  if (n < 0) {
    throw new Error('factorial is undefined for negative numbers');
  }
  let result = 1;
  for (let i = 2; i <= n; i += 1) {
    result *= i;
  }
  return result;
}
