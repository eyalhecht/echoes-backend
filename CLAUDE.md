# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install
cd functions && npm install

# Start local development (all emulators)
firebase emulators:start --only functions

# Deploy to production
firebase deploy --only functions

# Deploy a specific function
firebase deploy --only functions:apiGateway

# View logs
cd functions && npm run logs
```

Emulators run at:
- Functions: http://localhost:5001
- Firestore: http://localhost:8080
- Auth: http://localhost:9099
- UI: http://localhost:4000

## Architecture

**Echoes** is an AI-powered historical photo sharing platform built on Firebase Cloud Functions (Node.js 22, ES modules).

### Single Entry Point

All client requests go through one callable function `apiGateway` (`functions/index.js`). The function requires Firebase Auth, extracts `{ action, payload }` from the request body, and dispatches to the appropriate handler via a `switch` statement.

### Handler Modules (`functions/handlers/`)

| File | Responsibilities |
|------|-----------------|
| `posts.js` | createPost, deletePost, getPost, likePost, toggleBookmark, getBookmarks, addComment, getComments |
| `feed.js` | getFeed, getTrending, searchPosts, getPostsByLocation |
| `users.js` | createUserProfile, getProfile, getUserPosts, getSuggestedUsers, searchUsers |
| `social.js` | followUser/unfollowUser, getFollowersList/getFollowingList |
| `account.js` | deleteUserAccount |

### Utilities (`functions/utils/`)

- `firebase.js` — initializes `firebase-admin` and exports `db` (Firestore) and `admin`
- `ai.js` — exports `analyzePhoto` (GPT-4o via OpenAI) and `moderateImage` (Google Cloud Vision safe search); `openaiApiKey` is a Firebase Secret
- `errors.js` — thin wrapper `throwHttpsError(code, message, details)` around `functions.https.HttpsError`
- `constants.js` — all magic values: `COLLECTIONS`, `SUBCOLLECTIONS`, `LIMITS`, `DEFAULTS`, `POST_TYPES`, `AI_CONFIG`, `GEO`, `TIME`
- `search.js` — search keyword utilities

### AI Pipeline

When a post of type `photo`, `document`, or `item` is created, the first file URL is sent to `analyzePhoto()`, which calls GPT-4o with a historian/archivist system prompt and returns structured `AiMetadata` (description, date_estimate, location, historical_period, geographic_terms, subject_terms, tags). These tags are merged into `searchKeywords` on the post document for Firestore `array-contains-any` queries.

### Firestore Structure

```
users/{userId}
  followers/{followerId}
  following/{followingId}
  bookmarks/{postId}

posts/{postId}
  likes/{userId}
  comments/{commentId}
```

User display data (name, profile pic) is denormalized into post documents for feed performance. Counts (likesCount, commentsCount, followersCount, etc.) are maintained via Firestore transactions.

### Environment

The `OPENAI_API_KEY` is managed as a Firebase Secret (not a `.env` variable in production). Locally, `functions/.env` is used.

### Error Handling Pattern

Handlers throw `throwHttpsError(code, message)` for expected errors. The `apiGateway` catch block re-throws `HttpsError` instances and wraps all other errors as `internal`.

## Coding Conventions

### Response Shape
- Every handler must return `{ <primaryData>, message: '...' }` — always include a human-readable `message` string.
- Pagination responses add `lastDocId` (string | null) and `hasMore` (boolean).

### Payload Validation
- Validate all inputs at the top of each handler before any Firestore access.
- Use `throwHttpsError('invalid-argument', '...')` for bad inputs; be specific in the message.

### Adding a New Action
1. Implement the function in the appropriate `functions/handlers/<file>.js` and export it.
2. Add a `case` for the new action in the `switch` in `functions/index.js`.

### Constants
All magic values (limits, collection names, defaults) go in `functions/utils/constants.js` — never hardcode strings or numbers in handlers.

### ES Modules
This project uses `"type": "module"`. Always use `import`/`export`, never `require`/`module.exports`.

## Firestore Patterns

### Transactions for Counters
- Any write that touches a count field (`likesCount`, `commentsCount`, `followersCount`, etc.) must use `db.runTransaction()`.
- Use `admin.firestore.FieldValue.increment(n)` for incrementing; use `Math.max(0, count - 1)` inside transactions when decrementing to prevent going negative.

### Cursor Pagination
- Fetch `limit + 1` docs, slice to `limit`, set `hasMore = snapshot.docs.length > limit`. Return the last doc's ID as `lastDocId`.
- If the cursor doc no longer exists, log a warning and restart from the beginning.

### Denormalization
When writing a post or comment, copy `userDisplayName` and `userProfilePicUrl` from the user document at write time — do not join on read.

### Bidirectional Relationships
Follow/unfollow must update both sides (followers subcollection on target, following subcollection on current user) and both user count fields in a single transaction.

## Error Handling

- For non-critical secondary data (e.g., `likedByCurrentUser`, `bookmarkedByCurrentUser`), wrap fetches in try/catch and default to `false` on error — do not fail the whole request.
- Always `console.error` with the operation name and relevant IDs before re-throwing or wrapping.
