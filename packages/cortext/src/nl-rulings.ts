/**
 * How people talk about cortext, for substrate's NL parser and judge. Curated
 * operator rulings, kept here so the eval and production read one copy, owned
 * by the namespace. Declared via `defineNamespace` annotations; substrate's NL
 * layer validates them and the runtime can override per key.
 */
export const CORTEXT_NL_RULINGS = {
  unscopedTypes: ['AgentIdentity', 'AgentMessage', 'Skill'],
  liveStatus: { Todo: 'open' },
  timeField: { SessionLog: 'startedAt' },
  typeAliases: {
    inbox: 'AgentMessage',
    mail: 'AgentMessage',
    agents: 'AgentIdentity',
    agent: 'AgentIdentity',
    session: 'SessionLog',
    sessions: 'SessionLog',
    anchor: 'AnchorIntent',
    rule: 'AgentRule',
    rules: 'AgentRule',
    task: 'Todo',
    tasks: 'Todo',
    decide: 'Decision',
    decided: 'Decision'
  },
  fieldAliases: { repo: 'project', repository: 'project' },
  valueAliases: {
    'in force': [{ type: 'Decision', field: 'status', eq: 'active' }],
    'signal-gated': [{ type: 'Todo', field: 'title', startsWith: '[SG]' }],
    ship: [{ type: 'Todo', field: 'resolution', eq: 'completed' }],
    shipped: [{ type: 'Todo', field: 'resolution', eq: 'completed' }],
    drop: [{ type: 'Todo', field: 'resolution', in: ['wont_do', 'obsolete'] }],
    dropped: [{ type: 'Todo', field: 'resolution', in: ['wont_do', 'obsolete'] }]
  },
  typeNotes: {
    SessionLog: 'a record of one working session: what was done, when, on which branch',
    Decision: 'a choice that was made, with its rationale',
    Todo: 'a tracked piece of work',
    Memory: 'a durable fact an agent recorded to remember',
    AgentMessage: 'mail between agents; the sender is createdById',
    AgentIdentity: 'a registered agent: kid (name@host), display name, project',
    Concept: 'an operational concept, with a kind',
    AgentRule: 'a standing rule agents follow'
  }
};
