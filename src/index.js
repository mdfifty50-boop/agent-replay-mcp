#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'agent-replay-mcp',
  version: '0.1.0',
  description: 'Agent session recording and replay — debug non-deterministic behavior with session comparison and divergence detection',
});

const sessions = new Map();
let counter = 0;
const genId = () => `sess_${Date.now()}_${++counter}`;
const txt = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const err = (msg, extra) => txt({ error: msg, ...extra });
const getSession = (id) => sessions.get(id);
const summarize = (actions) => {
  const types = {}; let dur = 0;
  for (const a of actions) { types[a.action_type] = (types[a.action_type] || 0) + 1; dur += a.duration_ms || 0; }
  return { types, dur };
};

server.tool(
  'record_session',
  'Start recording all actions for an agent session. Returns a session_id to use with log_action.',
  {
    agent_id: z.string().describe('Unique identifier for the agent being recorded'),
    metadata: z.record(z.any()).optional().default({}).describe('Optional metadata (task, model, environment)'),
  },
  async ({ agent_id, metadata }) => {
    const session_id = genId();
    const started_at = new Date().toISOString();
    sessions.set(session_id, { session_id, agent_id, metadata, status: 'recording', started_at, stopped_at: null, actions: [] });
    return txt({ session_id, agent_id, status: 'recording', started_at });
  }
);

server.tool(
  'stop_recording',
  'Stop recording and return session summary with action count, duration, and type breakdown.',
  { session_id: z.string().describe('Session ID returned by record_session') },
  async ({ session_id }) => {
    const s = getSession(session_id);
    if (!s) return err('Session not found', { session_id });
    if (s.status !== 'recording') return err('Session is not recording', { status: s.status });
    s.status = 'stopped';
    s.stopped_at = new Date().toISOString();
    const { types, dur } = summarize(s.actions);
    return txt({ session_id, agent_id: s.agent_id, status: 'stopped', action_count: s.actions.length, total_duration_ms: dur, action_type_breakdown: types, started_at: s.started_at, stopped_at: s.stopped_at });
  }
);

server.tool(
  'log_action',
  'Log a single action during a recording session. Captures input, output, reasoning, and timing.',
  {
    session_id: z.string().describe('Session ID returned by record_session'),
    action_type: z.string().describe('Type of action (tool_call, llm_response, decision, error)'),
    input: z.any().describe('Input to the action'),
    output: z.any().describe('Output from the action'),
    reasoning: z.string().optional().default('').describe('Agent reasoning for this step'),
    duration_ms: z.number().optional().default(0).describe('Duration in milliseconds'),
  },
  async ({ session_id, action_type, input, output, reasoning, duration_ms }) => {
    const s = getSession(session_id);
    if (!s) return err('Session not found', { session_id });
    if (s.status !== 'recording') return err('Session is not recording', { status: s.status });
    const step = s.actions.length + 1;
    const timestamp = new Date().toISOString();
    s.actions.push({ step, action_type, input, output, reasoning, duration_ms, timestamp });
    return txt({ logged: true, session_id, step, action_type, timestamp });
  }
);

server.tool(
  'replay_session',
  'Replay a recorded session step by step with full action detail, timing, and reasoning.',
  { session_id: z.string().describe('Session ID to replay') },
  async ({ session_id }) => {
    const s = getSession(session_id);
    if (!s) return err('Session not found', { session_id });
    const { types, dur } = summarize(s.actions);
    return txt({ session_id, agent_id: s.agent_id, metadata: s.metadata, status: s.status, started_at: s.started_at, stopped_at: s.stopped_at, total_actions: s.actions.length, total_duration_ms: dur, action_type_breakdown: types, actions: s.actions });
  }
);

server.tool(
  'compare_sessions',
  'Behavioral diff between two sessions. Aligns by step, highlights differences in types, inputs, outputs, and timing.',
  {
    session_id_1: z.string().describe('First session ID'),
    session_id_2: z.string().describe('Second session ID'),
  },
  async ({ session_id_1, session_id_2 }) => {
    const s1 = getSession(session_id_1), s2 = getSession(session_id_2);
    if (!s1) return err('Session not found', { session_id: session_id_1 });
    if (!s2) return err('Session not found', { session_id: session_id_2 });
    const max = Math.max(s1.actions.length, s2.actions.length);
    const diffs = []; let identical = 0;
    for (let i = 0; i < max; i++) {
      const a1 = s1.actions[i], a2 = s2.actions[i];
      if (!a1 || !a2) { diffs.push({ step: i + 1, diff_type: !a1 ? 'only_in_session_2' : 'only_in_session_1', action: a1 || a2 }); continue; }
      const td = a1.action_type !== a2.action_type;
      const id = JSON.stringify(a1.input) !== JSON.stringify(a2.input);
      const od = JSON.stringify(a1.output) !== JSON.stringify(a2.output);
      if (td || id || od) {
        diffs.push({ step: i + 1, diff_type: 'diverged', differences: {
          ...(td ? { action_type: { session_1: a1.action_type, session_2: a2.action_type } } : {}),
          ...(id ? { input: { session_1: a1.input, session_2: a2.input } } : {}),
          ...(od ? { output: { session_1: a1.output, session_2: a2.output } } : {}),
        }, timing: { session_1_ms: a1.duration_ms, session_2_ms: a2.duration_ms } });
      } else { identical++; }
    }
    return txt({ session_id_1, session_id_2, session_1_actions: s1.actions.length, session_2_actions: s2.actions.length, identical_steps: identical, divergent_steps: diffs.length, first_divergence_step: diffs.length > 0 ? diffs[0].step : null, similarity_ratio: max > 0 ? +(identical / max).toFixed(3) : 1, diffs });
  }
);

server.tool(
  'find_divergence_point',
  'Find where an agent first deviated from expected output. Accepts per-step array or single expected value.',
  {
    session_id: z.string().describe('Session ID to analyze'),
    expected_output: z.any().describe('Expected final output or per-step array of expected outputs'),
  },
  async ({ session_id, expected_output }) => {
    const s = getSession(session_id);
    if (!s) return err('Session not found', { session_id });
    // Array mode: compare step by step
    if (Array.isArray(expected_output)) {
      for (let i = 0; i < s.actions.length && i < expected_output.length; i++) {
        if (JSON.stringify(s.actions[i].output) !== JSON.stringify(expected_output[i])) {
          return txt({ divergence_found: true, step: i + 1, action_type: s.actions[i].action_type, expected: expected_output[i], actual: s.actions[i].output, reasoning_at_divergence: s.actions[i].reasoning, remaining_steps: s.actions.length - i - 1 });
        }
      }
      return txt({ divergence_found: false, message: 'All compared steps match expected outputs', steps_compared: Math.min(s.actions.length, expected_output.length) });
    }
    // Single value mode
    const expStr = JSON.stringify(expected_output);
    const last = s.actions[s.actions.length - 1];
    if (last && JSON.stringify(last.output) === expStr) return txt({ divergence_found: false, message: 'Final output matches expected value' });
    for (let i = s.actions.length - 1; i >= 0; i--) {
      if (JSON.stringify(s.actions[i].output) === expStr) {
        return txt({ divergence_found: true, last_matching_step: i + 1, divergence_step: i + 2, divergence_action: s.actions[i + 1], final_output: last?.output, expected_output });
      }
    }
    return txt({ divergence_found: true, divergence_step: 1, message: 'No action output matches expected — agent diverged from the start', first_action: s.actions[0] || null, expected_output });
  }
);

server.tool(
  'export_session',
  'Export session as JSON or markdown transcript for sharing and offline analysis.',
  {
    session_id: z.string().describe('Session ID to export'),
    format: z.enum(['json', 'markdown']).default('json').describe('Export format: json or markdown'),
  },
  async ({ session_id, format }) => {
    const s = getSession(session_id);
    if (!s) return err('Session not found', { session_id });
    if (format === 'json') return txt({ export_format: 'json', session: s });
    let md = `# Session Replay: ${s.session_id}\n\n- **Agent:** ${s.agent_id}\n- **Status:** ${s.status}\n- **Started:** ${s.started_at}\n`;
    if (s.stopped_at) md += `- **Stopped:** ${s.stopped_at}\n`;
    if (Object.keys(s.metadata).length > 0) md += `- **Metadata:** ${JSON.stringify(s.metadata)}\n`;
    md += `- **Total Actions:** ${s.actions.length}\n\n---\n\n`;
    for (const a of s.actions) {
      md += `## Step ${a.step} — ${a.action_type}\n\n**Time:** ${a.timestamp} | **Duration:** ${a.duration_ms}ms\n\n`;
      if (a.reasoning) md += `**Reasoning:** ${a.reasoning}\n\n`;
      md += `**Input:**\n\`\`\`json\n${JSON.stringify(a.input, null, 2)}\n\`\`\`\n\n**Output:**\n\`\`\`json\n${JSON.stringify(a.output, null, 2)}\n\`\`\`\n\n---\n\n`;
    }
    return { content: [{ type: 'text', text: md }] };
  }
);

server.resource('sessions', 'agent-replay://sessions', async () => {
  const list = [];
  for (const [id, s] of sessions) list.push({ session_id: id, agent_id: s.agent_id, status: s.status, action_count: s.actions.length, started_at: s.started_at, stopped_at: s.stopped_at });
  return { contents: [{ uri: 'agent-replay://sessions', mimeType: 'application/json', text: JSON.stringify({ total_sessions: list.length, recording: list.filter(s => s.status === 'recording').length, stopped: list.filter(s => s.status === 'stopped').length, sessions: list }, null, 2) }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Agent Replay MCP Server running on stdio');
}
main().catch(console.error);
