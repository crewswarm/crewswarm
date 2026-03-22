/**
 * Approval policy manager — three-tier governance for agent actions
 * 
 * Approval levels:
 * - "auto": Execute immediately, no approval needed
 * - "user": Requires user confirmation (60s timeout)
 * - "admin": Requires admin approval (5min timeout)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APPROVAL_POLICIES_FILE = path.join(os.homedir(), '.crewswarm', 'approval-policies.json');

let _policies = null;

/**
 * Load approval policies from config
 */
export function loadApprovalPolicies() {
  if (_policies) return _policies;
  
  try {
    if (fs.existsSync(APPROVAL_POLICIES_FILE)) {
      _policies = JSON.parse(fs.readFileSync(APPROVAL_POLICIES_FILE, 'utf8'));
      return _policies;
    }
  } catch (e) {
    console.error('[approval] Failed to load policies:', e.message);
  }
  
  // Default policies
  _policies = {
    approvalPolicies: {
      '@@RUN_CMD': {
        git: 'auto',
        ls: 'auto',
        pwd: 'auto',
        cat: 'auto',
        grep: 'auto',
        'rm -rf': 'admin',
        docker: 'admin',
        kubectl: 'admin',
        default: 'user'
      },
      '@@SKILL': {
        'twitter.post': 'user',
        'polymarket.trade': 'user',
        'fly.deploy': 'admin',
        default: 'user'
      },
      '@@DISPATCH': {
        'crew-coder': 'auto',
        'crew-coder-front': 'auto',
        'crew-coder-back': 'auto',
        'crew-fixer': 'auto',
        'crew-qa': 'auto',
        'crew-github': 'user',
        default: 'auto'
      },
      '@@WRITE_FILE': { default: 'auto' },
      '@@READ_FILE': { default: 'auto' }
    },
    adminUsers: [],
    approvalTimeouts: {
      user: 60000,    // 1 minute
      admin: 300000   // 5 minutes
    }
  };
  
  return _policies;
}

/**
 * Reload policies from disk (useful after config changes)
 */
export function reloadApprovalPolicies() {
  _policies = null;
  return loadApprovalPolicies();
}

/**
 * Get approval level for a tool action
 * 
 * @param {string} toolType - Tool type (e.g. "@@RUN_CMD", "@@SKILL")
 * @param {string} toolValue - Specific value (e.g. "git status", "twitter.post")
 * @param {string} agentId - Agent requesting the action
 * @param {string} userId - User ID (for admin check)
 * @returns {"auto"|"user"|"admin"}
 */
export function getApprovalLevel(toolType, toolValue, agentId, userId = 'default') {
  const policies = loadApprovalPolicies();
  const policy = policies.approvalPolicies[toolType] || {};
  
  // Check if user is admin (admins can execute anything)
  if (isAdmin(userId)) {
    return 'auto';
  }
  
  // Check specific value (e.g. "git", "twitter.post")
  if (policy[toolValue]) {
    return policy[toolValue];
  }
  
  // Check command prefix for RUN_CMD (e.g. "rm -rf" matches "rm -rf /tmp/foo")
  if (toolType === '@@RUN_CMD') {
    const command = toolValue.toLowerCase().trim();
    for (const [pattern, level] of Object.entries(policy)) {
      if (pattern !== 'default' && command.startsWith(pattern.toLowerCase())) {
        return level;
      }
    }
  }
  
  // Check agent-specific override
  const agentOverride = policy[`agent:${agentId}`];
  if (agentOverride) {
    return agentOverride;
  }
  
  // Check role-based override
  const agentRole = getAgentRole(agentId);
  if (agentRole) {
    const roleOverride = policy[`role:${agentRole}`];
    if (roleOverride) return roleOverride;
  }
  
  // Fall back to default
  return policy.default || 'user';
}

/**
 * Check if a user is an admin
 */
export function isAdmin(userId) {
  const policies = loadApprovalPolicies();
  return policies.adminUsers.includes(userId);
}

/**
 * Get agent role from config
 */
function getAgentRole(agentId) {
  try {
    const cfgPath = path.join(os.homedir(), '.crewswarm', 'crewswarm.json');
    if (!fs.existsSync(cfgPath)) return null;
    
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const agents = Array.isArray(cfg.agents) ? cfg.agents : (cfg.agents?.list || []);
    const agent = agents.find(a => a.id === agentId);
    
    return agent?._role || null;
  } catch {
    return null;
  }
}

/**
 * Get timeout for approval level
 */
export function getApprovalTimeout(approvalLevel) {
  const policies = loadApprovalPolicies();
  return policies.approvalTimeouts[approvalLevel] || 60000;
}

/**
 * Add admin user
 */
export function addAdminUser(userId) {
  const policies = loadApprovalPolicies();
  if (!policies.adminUsers.includes(userId)) {
    policies.adminUsers.push(userId);
    saveApprovalPolicies(policies);
  }
}

/**
 * Remove admin user
 */
export function removeAdminUser(userId) {
  const policies = loadApprovalPolicies();
  policies.adminUsers = policies.adminUsers.filter(u => u !== userId);
  saveApprovalPolicies(policies);
}

/**
 * Save policies to disk
 */
function saveApprovalPolicies(policies) {
  fs.writeFileSync(APPROVAL_POLICIES_FILE, JSON.stringify(policies, null, 2), 'utf8');
  _policies = policies;
}

/**
 * Update a policy rule
 */
export function updatePolicyRule(toolType, toolValue, approvalLevel) {
  const policies = loadApprovalPolicies();
  
  if (!policies.approvalPolicies[toolType]) {
    policies.approvalPolicies[toolType] = {};
  }
  
  policies.approvalPolicies[toolType][toolValue] = approvalLevel;
  saveApprovalPolicies(policies);
}

/**
 * Export current policies (for backup/sharing)
 */
export function exportPolicies() {
  return JSON.parse(JSON.stringify(loadApprovalPolicies()));
}

/**
 * Import policies (for restore/sharing)
 */
export function importPolicies(policies) {
  saveApprovalPolicies(policies);
}
