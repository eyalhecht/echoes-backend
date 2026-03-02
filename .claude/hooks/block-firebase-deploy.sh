#!/bin/bash
# PreToolUse hook — blocks autonomous Firebase deploys and production-targeted commands.
# Exit code 2 = blocked (Claude sees the stderr message and stops).

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | node -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(chunks.join(''));
    process.stdout.write(d.tool_input?.command || '');
  } catch(e) {}
});
")

# Block any firebase deploy
if echo "$COMMAND" | grep -qE 'firebase deploy'; then
    echo "Blocked: 'firebase deploy' must not run autonomously. Ask the user for explicit confirmation before deploying." >&2
    exit 2
fi

# Block --project production / --project prod in any firebase command
if echo "$COMMAND" | grep -qE 'firebase.*--project[= ]*(production|prod)\b'; then
    echo "Blocked: '--project production' flag detected. Production operations require explicit user confirmation." >&2
    exit 2
fi

exit 0
