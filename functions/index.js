// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');

// --- Initialize Firebase Admin SDK ---
// This initializes the SDK with your Firebase project's credentials automatically
// when deployed to Cloud Functions.
admin.initializeApp();

// Get a Firestore database instance
const db = admin.firestore();

// --- Constants / Configuration ---
const POSTS_COLLECTION = 'posts';
const USERS_COLLECTION = 'users';
const COMMENTS_SUBCOLLECTION = 'comments';
const LIKES_SUBCOLLECTION = 'likes';
const FOLLOWERS_SUBCOLLECTION = 'followers';
const FOLLOWING_SUBCOLLECTION = 'following';

// --- Helper for standardized error messages ---
// This ensures your errors are caught nicely by the client-side Firebase SDK
const throwHttpsError = (code, message, details) => {
    throw new functions.https.HttpsError(code, message, details);
};

// --- Your Main API Gateway Callable Function ---
// This function handles all client-side API calls and dispatches to appropriate logic.
exports.apiGateway = functions.https.onCall(async (request, response) => {
    // 1. **Authentication Check (Automatic with onCall)**
    //    context.auth is automatically populated if the user is signed in with Firebase Auth.
    if (!request.auth) {
        // If not authenticated, throw an error. The client SDK will receive 'unauthenticated' error code.
        throwHttpsError('unauthenticated', 'Authentication required for tzx88888888888chis action.');
    }

    const userId = request.auth.uid; // The unique ID of the authenticated user
    const userEmail = request.auth.token.email; // The email from the ID token
    console.log(`API call by user: ${userId} (${userEmail})`);

    // 2. **Input Validation (Action Dispatch)**
    const data = request.data
    const { action, payload } = data; // Expecting { action: 'likePost', payload: { postId: 'abc' } }
    console.log(`action:`,action);
    console.log(`payload:`,payload);

    // if (!action || typeof action !== 'string') {
    //     throwHttpsError('invalid-argument', 'Action is required and must be a string.');
    // }

    // Use a switch statement or object mapping to dispatch to specific handlers
    try {
        switch (action) {
        //     case 'createPost':
        //         return await handleCreatePost(payload, userId);
            case 'getFeed':
                return await handleGetFeed(payload, userId);
            case 'createPost':
                return await handleCreatePost(payload, userId);
            case 'createUserProfile':
                return await handleCreateUserProfile(payload, userId);
        //     case 'likePost':
        //         return await handleLikePost(payload, userId);
        //     case 'addComment':
        //         return await handleAddComment(payload, userId);
        //     case 'followUser':
        //         return await handleFollowUser(payload, userId);
        //     case 'getProfile':
        //         return await handleGetProfile(payload, userId);
        //     case 'updateProfile':
        //         return await handleUpdateProfile(payload, userId);
        //     // Add more actions as your app grows
            default:
                throwHttpsError('not-found', `Action "${action}" not found.`);
        }

    } catch (error) {
        // Re-throw HttpsErrors, convert other errors to a generic internal error
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        console.error(`Error processing action "${action}" for user ${userId}:`, error);
        throwHttpsError('internal', 'An unexpected error occurred.', error.message);
    }
});

// --- Action Handlers (Modularized Logic) ---
// Each handler is a separate async function to keep code organized
//
// async function handleCreatePost(payload, userId) {
//     const { content, imageUrl, videoUrl, tags = [] } = payload;
//
//     if (!content && !imageUrl && !videoUrl) {
//         throwHttpsError('invalid-argument', 'Post must have content, an image, or a video.');
//     }
//     if (typeof content !== 'string' && content !== undefined) {
//         throwHttpsError('invalid-argument', 'Content must be a string or undefined.');
//     }
//     // Add more robust validation for imageUrl, videoUrl, tags etc.
//
//     try {
//         // Get user display name from their profile to store with the post
//         const userDoc = await db.collection(USERS_COLLECTION).doc(userId).get();
//         if (!userDoc.exists) {
//             throwHttpsError('not-found', 'User profile not found.');
//         }
//         const userData = userDoc.data();
//         const userDisplayName = userData.displayName || userDoc.id; // Fallback to UID
//
//         const newPostRef = db.collection(POSTS_COLLECTION).doc(); // Auto-generate ID
//         await newPostRef.set({
//             userId: userId,
//             userDisplayName: userDisplayName, // Store display name for easier fetching
//             content: content || null,
//             imageUrl: imageUrl || null,
//             videoUrl: videoUrl || null,
//             tags: Array.isArray(tags) ? tags : [],
//             likeCount: 0,
//             commentCount: 0,
//             createdAt: admin.firestore.FieldValue.serverTimestamp(),
//             updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         });
//
//         console.log(`Post ${newPostRef.id} created by ${userId}`);
//         return { postId: newPostRef.id, message: 'Post created successfully!' };
//     } catch (error) {
//         console.error('Error in handleCreatePost:', error);
//         throwHttpsError('internal', 'Failed to create post.', error.message);
//     }
// }
//
// Existing imports and setup in your BE file (e.g., Firebase Admin SDK)
// import * as admin from 'firebase-admin';
// admin.initializeApp();
// const db = admin.firestore();

// Assuming POSTS_COLLECTION is defined elsewhere, e.g.,
// const POSTS_COLLECTION = 'posts';

async function handleGetFeed(payload, userId) {
    // `payload` might contain parameters like `lastPostId`, `limit`, `filterByTag`
    const { limit = 10, lastPostId = null } = payload; // Changed default limit to 10 to match frontend
    const POST_LIMIT = limit; // Use the provided limit from payload

    // Basic validation
    if (typeof limit !== 'number' || limit < 1 || limit > 100) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 100.');
    }
    if (lastPostId !== null && typeof lastPostId !== 'string') {
        throwHttpsError('invalid-argument', 'lastPostId must be a string or null.');
    }

    try {
        let postsQuery = db.collection(POSTS_COLLECTION)
            .orderBy('createdAt', 'desc');

        let hasMore = true; // Assume there might be more posts by default

        if (lastPostId) {
            const lastPostSnapshot = await db.collection(POSTS_COLLECTION).doc(lastPostId).get();
            if (lastPostSnapshot.exists) {
                postsQuery = postsQuery.startAfter(lastPostSnapshot);
            } else {
                // If lastPostId is invalid or not found, treat it as an initial load
                console.warn(`lastPostId ${lastPostId} not found, fetching from start.`);
                // We don't need to re-query here, the original postsQuery is already set up for initial load
            }
        }

        const postsSnapshot = await postsQuery.limit(POST_LIMIT + 1).get(); // Fetch one extra document to check for 'hasMore'

        const fetchedPosts = [];
        postsSnapshot.forEach((doc) => {
            fetchedPosts.push({
                id: doc.id,
                ...doc.data(),
            });
        });

        if (fetchedPosts.length <= POST_LIMIT) {
            hasMore = false; // No more posts if we didn't get more than the limit
        }

        const postsToReturn = fetchedPosts.slice(0, POST_LIMIT);
        const lastVisibleDoc = postsSnapshot.docs[postsToReturn.length - 1]; // Get the last document from the returned slice

        console.log(`Fetched ${postsToReturn.length} posts for user ${userId}`);

        return {
            posts: postsToReturn,
            lastDocId: lastVisibleDoc ? lastVisibleDoc.id : null, // Pass back the ID of the last document for next pagination
            hasMore: hasMore, // Indicate if there are more posts to fetch
            message: 'Feed fetched successfully.',
        };
    } catch (error) {
        console.error('Error in handleGetFeed:', error);
        // Ensure you have a throwHttpsError function defined for Callable Cloud Functions
        // or handle errors as appropriate for your BE environment.
        throwHttpsError('internal', 'Failed to fetch feed.', error.message);
    }
}

async function handleCreatePost(payload, userId) {
    const { description, type, fileUrls = [], location = '', year = [] } = payload;

    // --- 1. Basic Input Validation ---
    if (typeof description !== 'string' || description.trim().length === 0) {
        throwHttpsError('invalid-argument', 'Description is required and must be a non-empty string.');
    }
    if (!['photo', 'video', 'document', 'item', 'youtube'].includes(type)) {
        throwHttpsError('invalid-argument', 'Invalid post type provided.');
    }

    // Validate fileUrls based on type
    if (type !== 'youtube') {
        if (!Array.isArray(fileUrls) || fileUrls.some(url => typeof url !== 'string' || url.trim().length === 0)) {
            throwHttpsError('invalid-argument', 'File URLs must be an array of non-empty strings for non-YouTube posts.');
        }
        if (fileUrls.length === 0) {
            throwHttpsError('invalid-argument', 'At least one file URL is required for this post type.');
        }
    } else { // For YouTube type, fileUrls will contain a single YouTube URL
        if (!Array.isArray(fileUrls) || fileUrls.length !== 1 || typeof fileUrls[0] !== 'string' || !fileUrls[0].includes('youtube.com')) {
            throwHttpsError('invalid-argument', 'A single valid YouTube URL is required for YouTube posts.');
        }
    }

    if (typeof location !== 'string') {
        throwHttpsError('invalid-argument', 'Location must be a string.');
    }
    if (!Array.isArray(year) || year.some(y => typeof y !== 'number' || y < 1000 || y > 3000)) { // Basic year range validation
        throwHttpsError('invalid-argument', 'Years must be an array of valid numbers.');
    }

    try {
        // --- 2. Fetch User Data (for displayName, profilePicUrl etc.) ---
        const userDoc = await db.collection(USERS_COLLECTION).doc(userId).get();
        if (!userDoc.exists) {
            throwHttpsError('not-found', 'User profile not found. Cannot create post.');
        }
        const userData = userDoc.data();
        const userDisplayName = userData.displayName || userDoc.id; // Fallback to UID
        const userProfilePicUrl = userData.profilePictureUrl || null; // Get user's profile picture

        // --- 3. Create New Post Document in Firestore ---
        const newPostRef = db.collection(POSTS_COLLECTION).doc(); // Auto-generate ID

        const postData = {
            userId: userId,
            userDisplayName: userDisplayName,
            userProfilePicUrl: userProfilePicUrl, // Store user's profile pic with the post for easier display
            description: description.trim(),
            type: type,
            files: fileUrls, // Array of file URLs (or YouTube URL)
            location: location.trim(),
            year: year.sort((a, b) => a - b), // Ensure years are sorted
            likesCount: 0,
            commentsCount: 0,
            bookmarksCount: 0,
            createdAt: new Date(), // Server timestamp is best practice
            updatedAt: new Date(),
        };

        await newPostRef.set(postData);

        console.log(`Post ${newPostRef.id} (${type}) created by ${userId}`);
        return { postId: newPostRef.id, message: 'Post created successfully!' };

    } catch (error) {
        console.error('Error in handleCreatePost:', error);
        if (error instanceof functions.https.HttpsError) {
            throw error; // Re-throw already handled HttpsErrors
        }
        throwHttpsError('internal', 'Failed to create post.', error.message);
    }
}

async function handleCreateUserProfile(payload, userId) {
    const { displayName, photoURL } = payload || {};
    const userEmail = null; // You'd need to get this from auth token if needed

    try {
        // Check if profile already exists
        const existingProfile = await db.collection(USERS_COLLECTION).doc(userId).get();
        if (existingProfile.exists) {
            return { message: 'Profile already exists', profile: existingProfile.data() };
        }
        const now = new Date();

        const profileData = {
            displayName: displayName || `User_${userId.substring(0, 8)}`,
            profilePictureUrl: photoURL || null,
            createdAt: now,
            followersCount: 0,
            followingCount: 0,
            bio: '',
            postsCount: 0,
            updatedAt: now,
        };

        await db.collection(USERS_COLLECTION).doc(userId).set(profileData);
        console.log(`Profile created successfully for ${userId}`);

        return { message: 'Profile created successfully', profile: profileData };
    } catch (error) {
        console.error(`Error creating profile for user ${userId}:`, error);
        throwHttpsError('internal', 'Failed to create profile', error.message);
    }
}
// async function handleLikePost(payload, userId) {
//     const { postId } = payload;
//
//     if (!postId || typeof postId !== 'string') {
//         throwHttpsError('invalid-argument', 'A valid postId is required.');
//     }
//
//     const postRef = db.collection(POSTS_COLLECTION).doc(postId);
//     const likeRef = postRef.collection(LIKES_SUBCOLLECTION).doc(userId); // Document per user like
//
//     try {
//         const result = await db.runTransaction(async (transaction) => {
//             const postDoc = await transaction.get(postRef);
//             if (!postDoc.exists) {
//                 throwHttpsError('not-found', 'Post not found.');
//             }
//
//             const likeDoc = await transaction.get(likeRef);
//             let newLikeCount = postDoc.data().likeCount || 0;
//             let status;
//
//             if (likeDoc.exists) {
//                 // User already liked, so unlike
//                 transaction.delete(likeRef);
//                 newLikeCount = Math.max(0, newLikeCount - 1); // Ensure count doesn't go below zero
//                 status = 'unliked';
//             } else {
//                 // User has not liked, so like
//                 transaction.set(likeRef, {
//                     userId: userId,
//                     likedAt: admin.firestore.FieldValue.serverTimestamp(),
//                 });
//                 newLikeCount += 1;
//                 status = 'liked';
//             }
//
//             transaction.update(postRef, { likeCount: newLikeCount });
//             return { status, newLikeCount };
//         });
//
//         console.log(`User ${userId} ${result.status} post ${postId}. New count: ${result.newLikeCount}`);
//         return { status: result.status, newLikeCount: result.newLikeCount, postId: postId, message: 'Like status updated.' };
//     } catch (error) {
//         console.error(`Error in handleLikePost for post ${postId} by user ${userId}:`, error);
//         // Ensure any custom errors from transaction also converted to HttpsError
//         if (error instanceof functions.https.HttpsError) {
//             throw error;
//         }
//         throwHttpsError('internal', 'Failed to update like status.', error.message);
//     }
// }
//
// async function handleAddComment(payload, userId) {
//     const { postId, text } = payload;
//
//     if (!postId || typeof postId !== 'string') {
//         throwHttpsError('invalid-argument', 'A valid postId is required.');
//     }
//     if (!text || typeof text !== 'string' || text.trim().length === 0) {
//         throwHttpsError('invalid-argument', 'Comment text is required.');
//     }
//
//     const postRef = db.collection(POSTS_COLLECTION).doc(postId);
//     const commentsRef = postRef.collection(COMMENTS_SUBCOLLECTION);
//
//     try {
//         const postDoc = await postRef.get();
//         if (!postDoc.exists) {
//             throwHttpsError('not-found', 'Post not found.');
//         }
//
//         // Get user display name and profile pic (optional)
//         const userDoc = await db.collection(USERS_COLLECTION).doc(userId).get();
//         const userData = userDoc.exists ? userDoc.data() : {};
//         const userDisplayName = userData.displayName || userId;
//         const userProfilePic = userData.profilePicUrl || null;
//
//         const newCommentRef = commentsRef.doc();
//         await newCommentRef.set({
//             userId: userId,
//             userDisplayName: userDisplayName,
//             userProfilePic: userProfilePic,
//             text: text.trim(),
//             createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         });
//
//         // Increment comment count on the post
//         await postRef.update({
//             commentCount: admin.firestore.FieldValue.increment(1)
//         });
//
//         console.log(`User ${userId} commented on post ${postId}: "${text.trim()}"`);
//         return { commentId: newCommentRef.id, message: 'Comment added successfully!' };
//     } catch (error) {
//         console.error(`Error in handleAddComment for post ${postId} by user ${userId}:`, error);
//         throwHttpsError('internal', 'Failed to add comment.', error.message);
//     }
// }
//
// async function handleFollowUser(payload, userId) {
//     const { targetUserId } = payload;
//
//     if (!targetUserId || typeof targetUserId !== 'string') {
//         throwHttpsError('invalid-argument', 'A valid targetUserId is required.');
//     }
//     if (userId === targetUserId) {
//         throwHttpsError('invalid-argument', 'Cannot follow yourself.');
//     }
//
//     const userRef = db.collection(USERS_COLLECTION).doc(userId);
//     const targetUserRef = db.collection(USERS_COLLECTION).doc(targetUserId);
//
//     const followingRef = userRef.collection(FOLLOWING_SUBCOLLECTION).doc(targetUserId);
//     const followerRef = targetUserRef.collection(FOLLOWERS_SUBCOLLECTION).doc(userId);
//
//     try {
//         await db.runTransaction(async (transaction) => {
//             const [userDoc, targetUserDoc, followingDoc, followerDoc] = await Promise.all([
//                 transaction.get(userRef),
//                 transaction.get(targetUserRef),
//                 transaction.get(followingRef),
//                 transaction.get(followerRef)
//             ]);
//
//             if (!userDoc.exists || !targetUserDoc.exists) {
//                 throwHttpsError('not-found', 'One or both user profiles not found.');
//             }
//
//             let status;
//             if (followingDoc.exists && followerDoc.exists) {
//                 // Already following, so unfollow
//                 transaction.delete(followingRef);
//                 transaction.delete(followerRef);
//                 transaction.update(userRef, { followingCount: admin.firestore.FieldValue.increment(-1) });
//                 transaction.update(targetUserRef, { followersCount: admin.firestore.FieldValue.increment(-1) });
//                 status = 'unfollowed';
//             } else {
//                 // Not following, so follow
//                 transaction.set(followingRef, {
//                     userId: targetUserId,
//                     followedAt: admin.firestore.FieldValue.serverTimestamp(),
//                 });
//                 transaction.set(followerRef, {
//                     userId: userId,
//                     followedAt: admin.firestore.FieldValue.serverTimestamp(),
//                 });
//                 transaction.update(userRef, { followingCount: admin.firestore.FieldValue.increment(1) });
//                 transaction.update(targetUserRef, { followersCount: admin.firestore.FieldValue.increment(1) });
//                 status = 'followed';
//             }
//             return { status };
//         });
//
//         console.log(`User ${userId} ${status} user ${targetUserId}`);
//         return { status: status, message: `Successfully ${status} user ${targetUserId}.` };
//     } catch (error) {
//         console.error(`Error in handleFollowUser for user ${userId} and target ${targetUserId}:`, error);
//         if (error instanceof functions.https.HttpsError) {
//             throw error;
//         }
//         throwHttpsError('internal', 'Failed to update follow status.', error.message);
//     }
// }
//
// async function handleGetProfile(payload, userId) {
//     const { profileUserId } = payload;
//     const targetId = profileUserId || userId; // If no ID provided, get current user's profile
//
//     if (!targetId || typeof targetId !== 'string') {
//         throwHttpsError('invalid-argument', 'A valid user ID is required to fetch a profile.');
//     }
//
//     try {
//         const userDoc = await db.collection(USERS_COLLECTION).doc(targetId).get();
//
//         if (!userDoc.exists) {
//             throwHttpsError('not-found', 'User profile not found.');
//         }
//
//         const profileData = userDoc.data();
//         // Remove sensitive data before sending to client if applicable
//         delete profileData.email; // Example: Don't send user's full email to public profiles
//
//         console.log(`Fetched profile for user ${targetId}`);
//         return { profile: profileData, message: 'Profile fetched successfully.' };
//     } catch (error) {
//         console.error(`Error in handleGetProfile for ${targetId}:`, error);
//         throwHttpsError('internal', 'Failed to fetch profile.', error.message);
//     }
// }
//
// async function handleUpdateProfile(payload, userId) {
//     const { displayName, bio, profilePicUrl } = payload; // Only allow specific fields to be updated
//
//     // Basic validation
//     if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length === 0)) {
//         throwHttpsError('invalid-argument', 'Display name must be a non-empty string.');
//     }
//     if (bio !== undefined && typeof bio !== 'string') {
//         throwHttpsError('invalid-argument', 'Bio must be a string.');
//     }
//     if (profilePicUrl !== undefined && (typeof profilePicUrl !== 'string' || !profilePicUrl.startsWith('https://'))) {
//         throwHttpsError('invalid-argument', 'Profile picture URL must be a valid https:// URL.');
//     }
//
//     const updateData = {};
//     if (displayName !== undefined) updateData.displayName = displayName.trim();
//     if (bio !== undefined) updateData.bio = bio.trim();
//     if (profilePicUrl !== undefined) updateData.profilePicUrl = profilePicUrl;
//
//     if (Object.keys(updateData).length === 0) {
//         throwHttpsError('invalid-argument', 'No valid fields provided for update.');
//     }
//
//     try {
//         await db.collection(USERS_COLLECTION).doc(userId).update(updateData);
//         console.log(`User ${userId} updated profile.`);
//         return { message: 'Profile updated successfully!' };
//     } catch (error) {
//         console.error(`Error in handleUpdateProfile for user ${userId}:`, error);
//         throwHttpsError('internal', 'Failed to update profile.', error.message);
//     }
// }
//
//
// // --- Optional: Background Function Example (not part of the callable API) ---
// // This function might trigger when a user is created via Firebase Authentication
// exports.createUserProfile = functions.auth.user().onCreate(async (user) => {
//     const { uid, email, displayName, photoURL } = user;
//
//     console.log(`Creating profile for new user: ${uid} (${email})`);
//
//     try {
//         await db.collection(USERS_COLLECTION).doc(uid).set({
//             email: email,
//             displayName: displayName || `User_${uid.substring(0, 8)}`,
//             profilePicUrl: photoURL || null,
//             createdAt: admin.firestore.FieldValue.serverTimestamp(),
//             followersCount: 0,
//             followingCount: 0,
//             bio: '',
//             // Add other default profile fields
//         });
//         console.log(`Profile created successfully for ${uid}`);
//     } catch (error) {
//         console.error(`Error creating profile for user ${uid}:`, error);
//     }
// });