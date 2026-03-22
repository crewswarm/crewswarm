/**
 * Runtime profiles - replaces confusing mode system
 */

export type RuntimeProfile = 'chat' | 'builder' | 'orchestrator';

export interface ProfileConfig {
  name: RuntimeProfile;
  description: string;
  useLocalExecutor: boolean;
  useGateway: boolean;
  autoApply: boolean;
  showExecutionPath: boolean;
}

export const RUNTIME_PROFILES: Record<RuntimeProfile, ProfileConfig> = {
  chat: {
    name: 'chat',
    description: 'Conversational mode - local LLM only, no code execution',
    useLocalExecutor: true,
    useGateway: false,
    autoApply: false,
    showExecutionPath: false
  },
  builder: {
    name: 'builder',
    description: 'Build mode - local execution with manual approval',
    useLocalExecutor: true,
    useGateway: false,
    autoApply: false,
    showExecutionPath: true
  },
  orchestrator: {
    name: 'orchestrator',
    description: 'Team mode - coordinates specialists via gateway',
    useLocalExecutor: false,
    useGateway: true,
    autoApply: false,
    showExecutionPath: true
  }
};

export function getProfileConfig(profile: RuntimeProfile): ProfileConfig {
  return RUNTIME_PROFILES[profile];
}

export function formatExecutionPath(parts: string[]): string {
  return parts.join(' → ');
}
