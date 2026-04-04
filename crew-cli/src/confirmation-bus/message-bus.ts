/** Stub — MessageBus for tool confirmation flow. */
export interface MessageBus {
  ask(question: any): Promise<any>;
  notify(message: string): void;
}
