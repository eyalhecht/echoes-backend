---
name: new-action
description: Add a new API action to the Echoes backend, following all project conventions
---

Implement the following new API action for the Echoes backend: $ARGUMENTS

Follow every rule below exactly — no shortcuts.

## 1. Choose the right handler file

Put the function in the most appropriate existing file under `functions/handlers/`:
- `posts.js` — post CRUD, likes, bookmarks, comments
- `feed.js` — feed, trending, search, location
- `users.js` — profiles, user posts, suggested users, search users
- `social.js` — follow/unfollow, followers/following lists
- `account.js` — account-level operations (e.g. delete account)

## 2. Implement the handler function

```js
export async function handleXxx(payload, userId) {
    // --- Validation (BEFORE any Firestore access) ---
    // Validate every input field. Use throwHttpsError('invalid-argument', '...') with specific messages.
    // Reference LIMITS.* from constants.js for max values — never hardcode numbers.

    // --- Main logic ---
    // Use db.runTransaction() for ANY write that touches a count field
    //   (likesCount, commentsCount, followersCount, postsCount, bookmarksCount, etc.)
    // Use admin.firestore.FieldValue.increment(n) for incrementing counts.
    // Use Math.max(0, count - 1) inside transactions when decrementing.

    // --- Denormalization ---
    // When writing a post or comment, copy userDisplayName and userProfilePicUrl
    // from the user document at write time — never join on read.

    // --- Non-critical secondary data ---
    // Wrap optional checks (likedByCurrentUser, bookmarkedByCurrentUser) in try/catch
    // and default to false on error — do not fail the whole request.

    // --- Logging ---
    // console.log a success message before returning.
    // console.error with the handler name and relevant IDs before re-throwing.

    // --- Return shape ---
    // Always return { <primaryData>, message: 'Human-readable success message.' }
    // Paginated responses also include: lastDocId (string | null), hasMore (boolean)

    // --- Error handling (end of every handler) ---
    try {
        // ... your logic here
    } catch (error) {
        console.error(`Error in handleXxx for ... ${userId}:`, error);
        if (error instanceof functions.https.HttpsError) throw error;
        throwHttpsError('internal', 'Failed to ...', error.message);
    }
}
```

## 3. Pagination (if this is a list/query action)

- Accept `limit` and `lastDocId` (or equivalent cursor) from payload.
- Validate: `typeof limit !== 'number' || limit < 1 || limit > LIMITS.XXX_MAX`
- Fetch `limit + 1` docs, slice to `limit`, set `hasMore = snapshot.docs.length > limit`.
- If the cursor doc no longer exists, log a warning and restart from beginning.
- Return `lastDocId: lastDoc ? lastDoc.id : null`.

## 4. Constants

- Any new magic string or number goes in `functions/utils/constants.js` — never hardcode in handlers.
- Add to the appropriate export: `COLLECTIONS`, `SUBCOLLECTIONS`, `LIMITS`, `DEFAULTS`, etc.

## 5. Export from the handler file

Add the function to the named exports at the top of the handler file (it uses ES modules — `import`/`export` only, no `require`).

## 6. Register in `functions/index.js`

**Import:** Add to the import line for the relevant handler file.

**Register in the handlers object:**
```js
myNewAction: (p, u) => handleMyNewAction(p, u),
```

The action name (key) becomes the string the client sends as `action`.

## 7. Checklist before finishing

- [ ] Inputs validated before any Firestore call
- [ ] `throwHttpsError('invalid-argument', ...)` used for bad inputs (specific message)
- [ ] `db.runTransaction()` used if any count field is touched
- [ ] `admin.firestore.FieldValue.increment(n)` used for incrementing
- [ ] `Math.max(0, count - 1)` used for decrementing inside transaction
- [ ] Denormalized user display data copied at write time (not joined at read)
- [ ] Non-critical secondary checks wrapped in try/catch, defaulting gracefully
- [ ] Return shape includes `message` string
- [ ] Paginated responses include `lastDocId` and `hasMore`
- [ ] New constants added to `constants.js`
- [ ] Handler exported from its file
- [ ] Handler imported and registered in `functions/index.js`
- [ ] ES modules used throughout (`import`/`export`, not `require`)
