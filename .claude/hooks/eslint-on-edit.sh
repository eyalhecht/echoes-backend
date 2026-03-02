#!/bin/bash
# PostToolUse hook — runs ESLint on any .js file Claude edits inside functions/.
# Exit code 2 = lint errors found; Claude sees the output and must fix before continuing.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | node -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(chunks.join(''));
    process.stdout.write(d.tool_input?.file_path || '');
  } catch(e) {}
});
")

# Only .js files
[[ "$FILE_PATH" != *.js ]] && exit 0

# Normalize Windows backslash path to forward slashes for Git Bash
UNIX_PATH=$(cygpath -u "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH" | sed 's|\\|/|g')

# Only files inside the functions directory
[[ "$UNIX_PATH" != */functions/* ]] && exit 0

FUNCTIONS_DIR="$CLAUDE_PROJECT_DIR/functions"
cd "$FUNCTIONS_DIR" || exit 0

LINT_OUTPUT=$(npx eslint "$UNIX_PATH" --no-warn-ignored 2>&1)
LINT_EXIT=$?

if [[ $LINT_EXIT -ne 0 ]]; then
    echo "ESLint errors — fix these before continuing:" >&2
    echo "$LINT_OUTPUT" >&2
    exit 2
fi

exit 0
