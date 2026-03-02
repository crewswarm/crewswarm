# Three-Tier Approval Workflow

## Overview

CrewSwarm now supports three approval levels for agent actions:

- **auto**: Execute immediately, no approval needed
- **user**: Requires user confirmation (60s timeout, dashboard or Telegram)
- **admin**: Requires admin approval (5min timeout, admin users only)

## Configuration

Create `~/.crewswarm/approval-policies.json`:

```json
{
  "approvalPolicies": {
    "@@RUN_CMD": {
      "git": "auto",
      "ls": "auto",
      "pwd": "auto",
      "rm -rf": "admin",
      "docker": "admin",
      "kubectl": "admin",
      "default": "user"
    },
    "@@SKILL": {
      "twitter.post": "user",
      "polymarket.trade": "user",
      "fly.deploy": "admin",
      "default": "user"
    },
    "@@DISPATCH": {
      "crew-coder": "auto",
      "crew-github": "user",
      "default": "auto"
    }
  },
  "adminUsers": [
    "telegram:123456789",
    "dashboard:admin@example.com"
  ],
  "approvalTimeouts": {
    "user": 60000,
    "admin": 300000
  }
}
```

## Usage

### Command Approval Levels

```javascript
// Auto-approved (runs immediately)
@@RUN_CMD git status
@@RUN_CMD ls -la

// User approval required (60s timeout)
@@RUN_CMD npm install

// Admin approval required (5min timeout)
@@RUN_CMD rm -rf /tmp/data
@@RUN_CMD docker ps
```

### Skill Approval Levels

```javascript
// User approval
@@SKILL twitter.post {"text": "Hello world"}

// Admin approval
@@SKILL fly.deploy {"app": "production"}
```

### Agent-Specific Overrides

Add agent or role overrides to the policy:

```json
{
  "approvalPolicies": {
    "@@RUN_CMD": {
      "agent:crew-fixer": "auto",
      "role:ops": "auto",
      "default": "user"
    }
  }
}
```

## API

### Policy Manager

```javascript
import { 
  getApprovalLevel,
  isAdmin,
  addAdminUser,
  removeAdminUser,
  updatePolicyRule
} from './lib/approval/policy-manager.mjs';

// Check approval level
const level = getApprovalLevel('@@RUN_CMD', 'rm -rf /tmp', 'crew-coder', 'user123');
// Returns: "admin"

// Check if user is admin
if (isAdmin('dashboard:admin@example.com')) {
  // Execute without approval
}

// Add admin user
addAdminUser('telegram:987654321');

// Update a rule
updatePolicyRule('@@SKILL', 'twitter.post', 'admin');
```

### Dashboard Integration

New dashboard API endpoints:

```javascript
// GET /api/approval/policies
// Returns current policies

// POST /api/approval/policies
// Update policies (admin only)

// POST /api/approval/admin-users
// Add/remove admin users (admin only)

// POST /api/approval/{approvalId}/approve
// Approve a pending action (user or admin)

// POST /api/approval/{approvalId}/reject
// Reject a pending action
```

## Migration from Old System

Old system had binary approval (auto-approve agents vs approval-required). New system is policy-driven:

**Before:**
```javascript
const needsApproval = !isAutoApproveAgent(agentId) && !isCommandAllowlisted(cmd);
```

**After:**
```javascript
const approvalLevel = getApprovalLevel('@@RUN_CMD', cmd, agentId, userId);
if (approvalLevel === 'auto') {
  // Execute immediately
} else if (approvalLevel === 'user') {
  // Wait for user approval
} else if (approvalLevel === 'admin') {
  // Wait for admin approval
}
```

## Security

1. **Admin users** - Stored in config, can execute any action
2. **Timeout enforcement** - Actions are rejected if not approved within timeout
3. **Audit trail** - All approvals logged to `~/.crewswarm/logs/approvals.jsonl`
4. **Command prefix matching** - `rm -rf` blocks `rm -rf /tmp/foo` and `rm -rf /`

## Examples

### Production Deployment Workflow

```json
{
  "approvalPolicies": {
    "@@SKILL": {
      "fly.deploy": "admin",
      "vercel.deploy": "admin"
    },
    "@@RUN_CMD": {
      "kubectl apply": "admin",
      "helm upgrade": "admin",
      "git push origin main": "user",
      "default": "user"
    }
  },
  "adminUsers": ["devops@company.com"],
  "approvalTimeouts": {
    "user": 120000,
    "admin": 600000
  }
}
```

### Development Workflow

```json
{
  "approvalPolicies": {
    "@@RUN_CMD": {
      "git": "auto",
      "npm": "auto",
      "docker": "user",
      "default": "user"
    },
    "@@DISPATCH": {
      "default": "auto"
    }
  },
  "adminUsers": [],
  "approvalTimeouts": {
    "user": 60000
  }
}
```

## Testing

```bash
# Test approval levels
node -e "import('./lib/approval/policy-manager.mjs').then(m => {
  console.log('rm -rf:', m.getApprovalLevel('@@RUN_CMD', 'rm -rf /tmp', 'crew-coder', 'user1'));
  console.log('git:', m.getApprovalLevel('@@RUN_CMD', 'git status', 'crew-coder', 'user1'));
  console.log('deploy:', m.getApprovalLevel('@@SKILL', 'fly.deploy', 'crew-coder', 'user1'));
})"
```

## Future Enhancements

- [ ] Web UI for managing policies (Settings → Approval)
- [ ] Approval history dashboard
- [ ] Slack/Teams integration for approvals
- [ ] Two-person approval for critical actions
- [ ] Time-based approval windows (e.g., deployments only during business hours)
