declare module '*.css';

declare module '@testing-library/react' {
  export const render: (...args: unknown[]) => unknown;
  export const screen: any;
  export const act: (callback: () => void | Promise<void>) => Promise<void> | void;
}

declare namespace jest {
  interface Mock<T = unknown> {
    (...args: unknown[]): T;
    mockReturnValue(value: T): this;
    mockReturnValueOnce(value: T): this;
  }
}

declare const jest: {
  mock: (...args: unknown[]) => void;
  useFakeTimers: () => void;
  advanceTimersByTime: (ms: number) => void;
  clearAllTimers: () => void;
};

declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void | Promise<void>): void;
declare function test(name: string, fn: () => void | Promise<void>): void;
declare function afterEach(fn: () => void | Promise<void>): void;
declare function expect(value: any): any;
