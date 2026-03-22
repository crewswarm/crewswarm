const THREAD_BINDINGS = new Map();

function bindingKey(projectId, threadId) {
  const project = String(projectId || "").trim();
  const thread = String(threadId || "").trim();
  if (!project || !thread) return null;
  return `${project}::${thread}`;
}

export function getThreadBinding(projectId, threadId) {
  const key = bindingKey(projectId, threadId);
  if (!key) return null;
  return THREAD_BINDINGS.get(key) || null;
}

export function setThreadBinding(projectId, threadId, binding) {
  const key = bindingKey(projectId, threadId);
  if (!key || !binding?.participantId || !binding?.kind) return null;
  const next = {
    participantId: binding.participantId,
    kind: binding.kind,
    runtime: binding.runtime || null,
    displayName: binding.displayName || binding.participantId,
    boundAt: Date.now(),
  };
  THREAD_BINDINGS.set(key, next);
  return next;
}

export function clearThreadBinding(projectId, threadId) {
  const key = bindingKey(projectId, threadId);
  if (!key) return;
  THREAD_BINDINGS.delete(key);
}
