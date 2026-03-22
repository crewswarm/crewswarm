/**
 * Core type definitions for CrewSwarm Orchestration.
 * Includes data structures representing waves, RT envelopes, and task objects.
 */

/**
 * Represents a single task assignment in a pipeline wave.
 * @typedef {Object} TaskAssignment
 * @property {string} agent - The ID of the agent assigned to the task (e.g., 'crew-coder').
 * @property {string} task - The natural language instruction for the agent.
 */

/**
 * Manifest defining a coordinate dispatched wave of tasks, typically fanned out.
 * @typedef {Object} TaskManifest
 * @property {number} wave - The current wave index/number (1-based).
 * @property {string} projectDir - Absolute path to the current project directory.
 * @property {string} [context] - Up to 3000 chars of shared memory/context text to guide the wave.
 * @property {TaskAssignment[]} tasks - The array of tasks executed concurrently in this wave.
 */

/**
 * Envelope for IPC/WebSocket real-time communication between agents and the daemon.
 * This is the standard wrapper for all real-time events on the RT bus.
 * @typedef {Object} IpcEnvelope
 * @property {string} [id] - Unique message ID, used for ack/response tracking.
 * @property {string} [type] - Parent envelope type (e.g. 'message', 'events').
 * @property {string} [taskId] - Associated task ID for state tracking.
 * @property {string} [from] - Originating agent ID.
 * @property {string} [to] - Target agent ID or 'broadcast'.
 * @property {string} [channel] - Pub/Sub channel (e.g., 'command', 'status').
 * @property {string} [messageType] - Specific action or event type (e.g., 'command.run_task').
 * @property {string} [correlationId] - ID tracking an action across pipeline steps.
 * @property {'low' | 'medium' | 'high'} [priority] - Message priority level.
 * @property {Record<string, any>} [payload] - The body content or structured command arguments.
 */

/**
 * Represents a parsed dispatch instruction from an orchestrating LLM.
 * @typedef {Object} DispatchCommand
 * @property {string} agent - Target agent ID string.
 * @property {string} task - Instructions to be routed.
 * @property {boolean} [verify] - Flag requesting test/verification output.
 * @property {boolean} [done] - Flag indicating pipeline completion or task resolution.
 */

/**
 * The standard pipeline execution meta-object.
 * @typedef {Object} PipelineMeta
 * @property {string} pipelineId - The active pipeline UUID.
 * @property {number} currentWave - The index of the wave being executed.
 * @property {number} totalWaves - The total number of waves in the pipeline.
 * @property {string} [correlationId] - Shared correlation ID tying all pipeline waves together.
 * @property {string} [projectDir] - The root project directory for this pipeline.
 */

export { };
