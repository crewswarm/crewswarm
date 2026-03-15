/**
 * Test file for helpers.js utility module
 */

const { deepClone, debounce, randomString, isEmpty, formatBytes } = require('./helpers');

describe('Helpers Module', () => {
  describe('deepClone', () => {
    test('should clone primitive values', () => {
      expect(deepClone(42)).toBe(42);
      expect(deepClone('hello')).toBe('hello');
      expect(deepClone(true)).toBe(true);
      expect(deepClone(null)).toBe(null);
      expect(deepClone(undefined)).toBe(undefined);
    });

    test('should clone objects', () => {
      const obj = { a: 1, b: { c: 2 } };
      const cloned = deepClone(obj);
      expect(cloned).toEqual(obj);
      expect(cloned).not.toBe(obj);
      expect(cloned.b).not.toBe(obj.b);
    });

    test('should clone arrays', () => {
      const arr = [1, [2, 3], { a: 4 }];
      const cloned = deepClone(arr);
      expect(cloned).toEqual(arr);
      expect(cloned).not.toBe(arr);
      expect(cloned[1]).not.toBe(arr[1]);
    });

    test('should clone dates', () => {
      const date = new Date('2023-01-01');
      const cloned = deepClone(date);
      expect(cloned).toEqual(date);
      expect(cloned).not.toBe(date);
    });

    test('should handle nested objects', () => {
      const obj = {
        level1: {
          level2: {
            level3: {
              value: 'deep'
            }
          }
        }
      };
      const cloned = deepClone(obj);
      expect(cloned).toEqual(obj);
      expect(cloned.level1.level2.level3).not.toBe(obj.level1.level2.level3);
    });
  });

  describe('debounce', () => {
    test('should delay function execution', (done) => {
      let callCount = 0;
      const debouncedFn = debounce(() => {
        callCount++;
      }, 100);

      debouncedFn();
      expect(callCount).toBe(0);

      setTimeout(() => {
        expect(callCount).toBe(1);
        done();
      }, 150);
    });

    test('should reset timer on multiple calls', (done) => {
      let callCount = 0;
      const debouncedFn = debounce(() => {
        callCount++;
      }, 100);

      debouncedFn();
      setTimeout(() => debouncedFn(), 50);
      setTimeout(() => debouncedFn(), 90);

      setTimeout(() => {
        expect(callCount).toBe(1);
        done();
      }, 200);
    });

    test('should pass arguments correctly', (done) => {
      let receivedArgs;
      const debouncedFn = debounce((...args) => {
        receivedArgs = args;
      }, 50);

      debouncedFn('arg1', 'arg2', 123);

      setTimeout(() => {
        expect(receivedArgs).toEqual(['arg1', 'arg2', 123]);
        done();
      }, 100);
    });
  });

  describe('randomString', () => {
    test('should generate string of default length', () => {
      const str = randomString();
      expect(str).toHaveLength(8);
      expect(typeof str).toBe('string');
    });

    test('should generate string of specified length', () => {
      const str = randomString(16);
      expect(str).toHaveLength(16);
    });

    test('should use custom characters', () => {
      const str = randomString(10, 'ABC');
      expect(str).toMatch(/^[ABC]{10}$/);
    });

    test('should generate different strings', () => {
      const str1 = randomString(8);
      const str2 = randomString(8);
      expect(str1).not.toBe(str2);
    });

    test('should handle edge cases', () => {
      expect(randomString(0)).toBe('');
      expect(() => randomString(-1)).not.toThrow();
    });
  });

  describe('isEmpty', () => {
    test('should return true for null and undefined', () => {
      expect(isEmpty(null)).toBe(true);
      expect(isEmpty(undefined)).toBe(true);
    });

    test('should return true for empty strings', () => {
      expect(isEmpty('')).toBe(true);
      expect(isEmpty('   ')).toBe(false); // whitespace is not empty
    });

    test('should return true for empty arrays', () => {
      expect(isEmpty([])).toBe(true);
      expect(isEmpty([1, 2, 3])).toBe(false);
    });

    test('should return true for empty objects', () => {
      expect(isEmpty({})).toBe(true);
      expect(isEmpty({ a: 1 })).toBe(false);
    });

    test('should return false for non-empty values', () => {
      expect(isEmpty(0)).toBe(false);
      expect(isEmpty(false)).toBe(false);
      expect(isEmpty('hello')).toBe(false);
      expect(isEmpty([1])).toBe(false);
      expect(isEmpty({ a: 1 })).toBe(false);
    });
  });

  describe('formatBytes', () => {
    test('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1048576)).toBe('1 MB');
      expect(formatBytes(1073741824)).toBe('1 GB');
    });

    test('should handle decimal places', () => {
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(1536, 0)).toBe('2 KB');
      expect(formatBytes(1536, 3)).toBe('1.500 KB');
    });

    test('should handle edge cases', () => {
      expect(formatBytes(1)).toBe('1 Bytes');
      expect(formatBytes(1023)).toBe('1023 Bytes');
      expect(formatBytes(1025)).toBe('1 KB');
    });

    test('should handle large numbers', () => {
      expect(formatBytes(1099511627776)).toBe('1 TB');
      expect(formatBytes(1125899906842624)).toBe('1 PB');
    });
  });
});
