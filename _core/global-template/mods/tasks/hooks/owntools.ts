import type { EngineInterface } from 'claude-code'

// The mod's own list tools, registered only when the session offers no TaskCreate (current models hide
// the built-in task tools unless CLAUDE_CODE_ENABLE_TODO_TOOLS is set). Each one is answered as the
// built-in tool it stands for, from the same list, by its name alone: the `taskmod_` names keep clear
// of a user's own MCP server named `tasks`, so no state says whose call it is and a reload keeps them.

const PREFIX = 'mcp__tasks__'

const STATUS = { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] }
const IDS = { type: 'array', items: { type: 'string' } }

/** Each own tool's short name, the built-in tool it stands for, and its input schema. */
const SPECS = [
  {
    name: 'taskmod_create',
    builtIn: 'TaskCreate',
    description: 'Creates a task on this session\'s task list (the TaskCreate tool, which this session lacks). ' +
      'Use it for any work of three or more steps; it starts as pending.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'A brief title for the task' },
        description: { type: 'string', description: 'What needs to be done' },
        activeForm: { type: 'string', description: 'Present continuous form shown while in progress' },
        metadata: { type: 'object', description: 'Arbitrary metadata to attach to the task' },
      },
      required: ['subject', 'description'],
    },
  },
  {
    name: 'taskmod_update',
    builtIn: 'TaskUpdate',
    description: 'Updates a task on this session\'s task list (the TaskUpdate tool, which this session lacks): ' +
      'its status, subject, description, dependencies or metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to update' },
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' },
        status: STATUS,
        addBlocks: IDS,
        addBlockedBy: IDS,
        owner: { type: 'string' },
        metadata: { type: 'object', description: 'Keys to merge in; a key set to null is deleted' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'taskmod_list',
    builtIn: 'TaskList',
    description: 'Lists this session\'s tasks (the TaskList tool, which this session lacks).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'taskmod_get',
    builtIn: 'TaskGet',
    description: 'Returns one task of this session\'s task list (the TaskGet tool, which this session lacks).',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'The ID of the task to retrieve' } },
      required: ['taskId'],
    },
  },
] as const

const BUILT_IN_OF = new Map<string, string>(SPECS.map(spec => [`${PREFIX}${spec.name}`, spec.builtIn]))

/** The built-in task tool a call stands for: an own tool's built-in name, any other tool as it is. */
export function builtInName(tool: string): string {
  return BUILT_IN_OF.get(tool) ?? tool
}

/** Whether the session offers a tool that changes the list: the built-in TaskCreate or the own tools. */
export async function hasListTool($: EngineInterface): Promise<boolean> {
  const tools = await $.tool.list().catch(() => undefined)
  return Boolean(tools?.some(tool => tool.name === 'TaskCreate' || BUILT_IN_OF.has(tool.name)))
}

/**
 * Registers the own list tools when the session offers no TaskCreate, and says whether it did. A tool
 * list that cannot be read registers nothing, so the model never sees two sets.
 */
export async function registerOwnTools($: EngineInterface, holdHelp: string): Promise<boolean> {
  const tools = await $.tool.list().catch(() => undefined)
  // Already offered (registered earlier in this process) or held by another server: register nothing.
  const isTaken = (name: string) => name === 'TaskCreate' || BUILT_IN_OF.has(name)
  if (!tools || tools.some(tool => isTaken(tool.name))) return false
  for (const spec of SPECS) {
    const description = spec.builtIn === 'TaskUpdate' ? `${spec.description}\n\n${holdHelp}` : spec.description
    await $.tool.register({ name: spec.name, description, inputSchema: spec.inputSchema, isDeferred: false })
  }
  return true
}
