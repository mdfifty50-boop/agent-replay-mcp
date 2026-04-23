# agent-replay-mcp

MCP server for agent session recording and replay — debug non-deterministic agent behavior with session comparison and divergence detection.

Record every action an agent takes, replay sessions step by step, diff two runs to find behavioral regressions, and pinpoint exactly where an agent diverged from expected output.

## Install

```bash
npx agent-replay-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agent-replay": {
      "command": "npx",
      "args": ["agent-replay-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/mdfifty50-boop/agent-replay-mcp.git
cd agent-replay-mcp
npm install
node src/index.js
```

## Tools

### record_session

Start recording all actions for an agent session.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_id` | string | required | Unique agent identifier |
| `metadata` | object | `{}` | Optional metadata (task, model, environment) |

Returns a `session_id` for use with other tools.

### stop_recording

Stop recording and return a session summary.

| Param | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session ID from record_session |

Returns: action count, total duration, action type breakdown.

### log_action

Log a single action during a recording session.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `session_id` | string | required | Active session ID |
| `action_type` | string | required | Type (tool_call, llm_response, decision, error) |
| `input` | any | required | Input to the action |
| `output` | any | required | Output from the action |
| `reasoning` | string | `""` | Agent reasoning for this step |
| `duration_ms` | number | `0` | Action duration in milliseconds |

### replay_session

Replay a recorded session step by step with full action detail.

| Param | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session ID to replay |

Returns: complete action sequence with timing, reasoning, inputs, and outputs.

### compare_sessions

Behavioral diff between two sessions. Aligns actions by step index and highlights differences.

| Param | Type | Description |
|-------|------|-------------|
| `session_id_1` | string | First session |
| `session_id_2` | string | Second session |

Returns: similarity ratio, identical/divergent step counts, first divergence step, and per-step diffs.

### find_divergence_point

Find where an agent first deviated from expected output.

| Param | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session to analyze |
| `expected_output` | any | Expected final output, or array of per-step expected outputs |

If `expected_output` is an array, compares step by step. If a single value, finds the last matching output and flags the next step as the divergence point.

### export_session

Export a session for sharing and offline analysis.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `session_id` | string | required | Session to export |
| `format` | string | `"json"` | `"json"` or `"markdown"` |

Markdown format produces a readable transcript with step headers, reasoning, and code blocks.

## Resources

| URI | Description |
|-----|-------------|
| `agent-replay://sessions` | All recorded sessions with status and action counts |

## Usage Pattern

```
1. record_session — start recording at agent launch
2. For each agent action:
   - log_action — capture input, output, reasoning, timing
3. stop_recording — finalize the session
4. Debug:
   - replay_session — review what happened step by step
   - compare_sessions — diff today's run vs yesterday's
   - find_divergence_point — pinpoint where it went wrong
5. Share:
   - export_session — JSON for tooling, markdown for humans
```

## Tests

```bash
npm test
```

## License

MIT
