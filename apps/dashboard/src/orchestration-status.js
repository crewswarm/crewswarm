/**
 * Orchestration Status Panel
 * Live dashboard for crewswarm swarm coordination
 */

let orchestrationInterval = null;

export async function updateOrchestrationStatus() {
  try {
    // Get health check
    const healthRes = await fetch('/api/health');
    const health = healthRes.ok ? await healthRes.json() : { ok: false };
    
    // Get agents status
    const agentsRes = await fetch('/api/agents');
    const agents = agentsRes.ok ? await agentsRes.json() : { count: 0 };
    
    // Get project queue status
    const queueRes = await fetch('/api/projects');
    const projects = queueRes.ok ? await queueRes.json() : { projects: [] };
    const allProjects = projects.projects || [];
    const totalPending = allProjects.reduce((sum, p) => sum + (p.roadmap?.pending || 0), 0);
    const totalRunning = allProjects.filter(p => p.running).length;
    
    // Get configured models
    const providersRes = await fetch('/api/providers');
    const providers = providersRes.ok ? await providersRes.json() : { providers: [] };
    const configuredProviders = (providers.providers || []).filter(p => p.configured);
    const modelNames = configuredProviders.map(p => {
      if (p.id === 'openai') return 'GPT';
      if (p.id === 'anthropic') return 'Claude';
      if (p.id === 'google') return 'Gemini';
      if (p.id === 'groq') return 'Groq';
      if (p.id === 'xai') return 'Grok';
      if (p.id === 'ollama') return 'Local';
      return p.label?.split(' ')[0];
    });
    
    // Update UI
    const systemStatus = document.getElementById('orchSystemStatus');
    const modelStack = document.getElementById('orchModelStack');
    const swarmFill = document.getElementById('orchSwarmFill');
    const swarmPercent = document.getElementById('orchSwarmPercent');
    const activeAgents = document.getElementById('orchActiveAgents');
    const taskQueue = document.getElementById('orchTaskQueue');
    
    if (systemStatus) {
      if (health.ok) {
        systemStatus.textContent = '● ONLINE';
        systemStatus.style.color = '#10b981'; // green
      } else {
        systemStatus.textContent = '● OFFLINE';
        systemStatus.style.color = '#ef4444'; // red
      }
    }
    
    if (modelStack) {
      modelStack.textContent = modelNames.length > 0 
        ? modelNames.slice(0, 3).join(' / ')
        : 'Not configured';
    }
    
    const agentCount = agents.count || 0;
    const maxAgents = 30;
    const percent = Math.min(100, Math.floor((agentCount / maxAgents) * 100));
    
    if (swarmFill) {
      swarmFill.style.width = `${percent}%`;
    }
    if (swarmPercent) {
      swarmPercent.textContent = `${percent}%`;
    }
    if (activeAgents) {
      activeAgents.textContent = agentCount.toString();
    }
    if (taskQueue) {
      const parts = [];
      if (totalPending > 0) parts.push(`${totalPending} pending`);
      if (totalRunning > 0) parts.push(`${totalRunning} running`);
      taskQueue.textContent = parts.length > 0 ? parts.join(', ') : '0 pending';
    }
    
  } catch (err) {
    console.error('[OrchestrationStatus] Update failed:', err);
    
    // Show error state
    const systemStatus = document.getElementById('orchSystemStatus');
    if (systemStatus) {
      systemStatus.textContent = '● ERROR';
      systemStatus.style.color = '#ef4444';
    }
  }
}

export function startOrchestrationStatusUpdates() {
  // Initial update
  updateOrchestrationStatus();
  
  // Update every 5 seconds
  if (orchestrationInterval) {
    clearInterval(orchestrationInterval);
  }
  orchestrationInterval = setInterval(updateOrchestrationStatus, 5000);
}

export function stopOrchestrationStatusUpdates() {
  if (orchestrationInterval) {
    clearInterval(orchestrationInterval);
    orchestrationInterval = null;
  }
}

// Auto-start when chat view is active
document.addEventListener('DOMContentLoaded', () => {
  const chatView = document.getElementById('chatView');
  if (chatView && chatView.classList.contains('active')) {
    startOrchestrationStatusUpdates();
  }
});

// Restart when switching to chat view
const navChat = document.getElementById('navChat');
if (navChat) {
  navChat.addEventListener('click', () => {
    setTimeout(startOrchestrationStatusUpdates, 100);
  });
}
