import { Logger } from '../utils/logger.js';
import { AgentRouter } from '../agent/router.js';

export interface PlanStep {
  id: number;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface Plan {
  title: string;
  steps: PlanStep[];
}

export class Planner {
  private logger = new Logger();

  constructor(private router: AgentRouter) {}

  /**
   * Asks an agent to generate a plan for a given task.
   */
  async generatePlan(task: string): Promise<Plan> {
    const prompt = `Develop a 5-10 step technical plan for the following task: "${task}".
    Return the plan as a numbered list of discrete, actionable steps.`;

    const result = await this.router.dispatch('crew-pm', prompt);
    const steps = this.parsePlanOutput(result.result);

    return {
      title: `Plan for: ${task.slice(0, 50)}...`,
      steps
    };
  }

  async planFeature(description: string): Promise<Plan> {
    return this.generatePlan(description);
  }

  private parsePlanOutput(output: string): PlanStep[] {
    const steps: PlanStep[] = [];
    const lines = output.split('\n');
    let id = 1;

    for (const line of lines) {
      const match = line.match(/^\d+[\.\)]\s+(.*)/);
      if (match) {
        steps.push({
          id: id++,
          task: match[1].trim(),
          status: 'pending'
        });
      }
    }

    // Fallback if no numbered list found
    if (steps.length === 0) {
      const parts = output.split('\n').filter(l => l.trim().length > 10);
      parts.slice(0, 8).forEach((part, i) => {
        steps.push({
          id: i + 1,
          task: part.trim(),
          status: 'pending'
        });
      });
    }

    return steps;
  }
}
