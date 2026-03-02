export interface CapabilityMap {
  canRead: boolean;
  canWrite: boolean;
  canPty: boolean;
  canLsp: boolean;
  canDispatch: boolean;
  canGit: boolean;
  mode: 'standalone' | 'connected';
}

export function resolveCapabilityMap(mode: 'standalone' | 'connected'): CapabilityMap {
  const pty = process.env.CREW_DISABLE_PTY === 'true' ? false : true;
  const lsp = process.env.CREW_DISABLE_LSP === 'true' ? false : true;
  return {
    canRead: true,
    canWrite: true,
    canPty: pty,
    canLsp: lsp,
    canDispatch: mode === 'connected',
    canGit: true,
    mode
  };
}

export function missingForRequiredCapabilities(required: string[], caps: CapabilityMap): string[] {
  const req = new Set((required || []).map(v => String(v).toLowerCase().trim()).filter(Boolean));
  const missing: string[] = [];
  if (req.has('dispatch') && !caps.canDispatch) missing.push('dispatch');
  if ((req.has('write') || req.has('write-file') || req.has('code-generation')) && !caps.canWrite) missing.push('write');
  if (req.has('pty') && !caps.canPty) missing.push('pty');
  if ((req.has('lsp') || req.has('type-check')) && !caps.canLsp) missing.push('lsp');
  if ((req.has('git') || req.has('github')) && !caps.canGit) missing.push('git');
  return missing;
}

