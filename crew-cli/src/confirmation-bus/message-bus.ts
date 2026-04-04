/** Stub — MessageBus for tool confirmation flow. */
export interface MessageBus {
  ask(question: string): Promise<unknown>;
  notify(message: string): void;
}
