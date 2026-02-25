const { backtest } = require('../../../src/backtest');
const PriceHistory = require('../../../src/models/PriceHistory');

describe('Live Data Backtest Integration', () => {
  beforeEach(async () => {
    // Setup test data
  });

  test('should execute backtest with real Polymarket price data', async () => {
    console.time('data-load');
const historicalData = await Promise.race([
  PriceHistory.find({ limit: 720 }),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Polymarket fetch timeout')), 5000))
]);
console.timeEnd('data-load');
    console.time('backtest-run');
const result = await backtest(historicalData);
console.timeEnd('backtest-run');

    expect(result).toHaveProperty('profit');
    expect(result.profit).toBeGreaterThan(0);
  });
});