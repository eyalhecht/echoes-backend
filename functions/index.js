// functions/index.js
import 'dotenv/config';
import functions from 'firebase-functions';
import admin from 'firebase-admin';
import { GeoPoint } from 'firebase-admin/firestore';
import vision from '@google-cloud/vision';
import OpenAI from 'openai';

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

// --- Rate Limiting Configuration ---
const RATE_LIMITS = {
    createPost: { max: 5, windowMs: 60 * 60 * 1000 },      // 5 per hour
    likePost: { max: 100, windowMs: 60 * 60 * 1000 },      // 100 per hour
    toggleBookmark: { max: 100, windowMs: 60 * 60 * 1000 }, // 100 per hour
    addComment: { max: 20, windowMs: 60 * 60 * 1000 },     // 20 per hour
    followUser: { max: 50, windowMs: 60 * 60 * 1000 },     // 50 per hour
    unfollowUser: { max: 50, windowMs: 60 * 60 * 1000 },   // 50 per hour
    searchPosts: { max: 100, windowMs: 60 * 60 * 1000 },   // 100 per hour
    searchUsers: { max: 50, windowMs: 60 * 60 * 1000 },    // 50 per hour
    getFeed: { max: 200, windowMs: 60 * 60 * 1000 },       // 200 per hour
    getProfile: { max: 500, windowMs: 60 * 60 * 1000 },    // 500 per hour
    getUserPosts: { max: 300, windowMs: 60 * 60 * 1000 },  // 300 per hour
    createUserProfile: { max: 2, windowMs: 60 * 60 * 1000 }, // 2 per hour
    deletePost: { max: 10, windowMs: 60 * 60 * 1000 },     // 10 per hour
    getComments: { max: 200, windowMs: 60 * 60 * 1000 },   // 200 per hour
    getPostsByLocation: { max: 100, windowMs: 60 * 60 * 1000 }, // 100 per hour
    getSuggestedUsers: { max: 50, windowMs: 60 * 60 * 1000 }, // 50 per hour
    getFollowersList: { max: 20, windowMs: 60 * 60 * 1000 }, // 20 per hour
    getFollowingList: { max: 20, windowMs: 60 * 60 * 1000 }, // 20 per hour
};

const rateLimiter = {
    users: new Map(),
    cleanup: null
};

// --- Helper for standardized error messages ---
// This ensures your errors are caught nicely by the client-side Firebase SDK
const throwHttpsError = (code, message, details) => {
    throw new functions.https.HttpsError(code, message, details);
};

// --- Rate Limiting Functions ---
const checkRateLimit = (userId, action) => {
    const limits = RATE_LIMITS[action];
    if (!limits) {
        return true;
    }

    const now = Date.now();
    const userLimits = rateLimiter.users.get(userId);
    
    if (!userLimits) {
        return true;
    }

    const actionLimit = userLimits[action];
    if (!actionLimit) {
        return true; // First request for this action
    }

    // Check if window has expired
    if (now >= actionLimit.resetTime) {
        return true; // Window expired, allow request
    }

    // Check if within limit
    return actionLimit.count < limits.max;
};

const incrementRateLimit = (userId, action) => {
    const limits = RATE_LIMITS[action];
    if (!limits) {
        return; // No limit defined for this action
    }

    const now = Date.now();
    
    // Get or create user limits
    let userLimits = rateLimiter.users.get(userId);
    if (!userLimits) {
        userLimits = {};
        rateLimiter.users.set(userId, userLimits);
    }

    // Get or create action limit
    let actionLimit = userLimits[action];
    if (!actionLimit || now >= actionLimit.resetTime) {
        // Create new window
        actionLimit = {
            count: 1,
            resetTime: now + limits.windowMs
        };
        userLimits[action] = actionLimit;
    } else {
        // Increment existing window
        actionLimit.count++;
    }
};

const cleanupExpiredEntries = () => {
    const now = Date.now();
    
    for (const [userId, userLimits] of rateLimiter.users.entries()) {
        const activeActions = {};
        let hasActiveActions = false;

        // Check each action for this user
        for (const [action, actionLimit] of Object.entries(userLimits)) {
            if (now < actionLimit.resetTime) {
                // Action limit is still active
                activeActions[action] = actionLimit;
                hasActiveActions = true;
            }
        }

        if (hasActiveActions) {
            // Update user with only active actions
            rateLimiter.users.set(userId, activeActions);
        } else {
            // Remove user entirely if no active actions
            rateLimiter.users.delete(userId);
        }
    }

    console.log(`Rate limiter cleanup: ${rateLimiter.users.size} active users`);
};

// Start cleanup interval when module loads
if (!rateLimiter.cleanup) {
    rateLimiter.cleanup = setInterval(cleanupExpiredEntries, 15 * 60 * 1000); // Every 15 minutes
}

// --- Your Main API  Gateway Callable Function ---
// This function handles all client-side API calls and dispatches to appropriate logic.
export const apiGateway = functions.https.onCall(async (request, response) => {
    // 1. **Authentication Check (Automatic with onCall)**
    //    context.auth is automatically populated if the user is signed in with Firebase Auth.
    if (!request.auth) {
        // If not authenticated, throw an error. The client SDK will receive 'unauthenticated' error code.
        throwHttpsError('unauthenticated', 'Authentication required for this action.');
    }

    const userId = request.auth.uid; // The unique ID of the authenticated user
    const userEmail = request.auth.token.email; // The email from the ID token
    console.log(`API call by user: ${userId} (${userEmail})`);

    // 2. **Input Validation (Action Dispatch)**
    const data = request.data
    const { action, payload } = data; // Expecting { action: 'likePost', payload: { postId: 'abc' } }
    console.log(`action:`,action);
    console.log(`payload:`,payload);

    // 3. **Rate Limiting Check**
    if (!checkRateLimit(userId, action)) {
        console.warn(`Rate limit exceeded: ${userId} attempted ${action}`);
        throwHttpsError('resource-exhausted', 'Rate limit exceeded. Please try again later.');
    }

    // if (!action || typeof action !== 'string') {
    //     throwHttpsError('invalid-argument', 'Action is required and must be a string.');
    // }

    // Use a switch statement or object mapping to dispatch to specific handlers
    try {
        let result;
        switch (action) {
            //     case 'createPost':
            //         return await handleCreatePost(payload, userId);
            case 'followUser':
            case 'unfollowUser':
                result = await handleFollowUnfollow(payload, userId, action);
                break;
            case 'getFeed':
                result = await handleGetFeed(payload, userId);
                break;
            case 'createPost':
                result = await handleCreatePost(payload, userId);
                break;
            case 'createUserProfile':
                result = await handleCreateUserProfile(payload, userId);
                break;
            case 'likePost':
                result = await handleLikePost(payload, userId);
                break;
            case 'toggleBookmark':
                result = await handleToggleBookmark(payload, userId);
                break;
            //     case 'likePost':
            //         return await handleLikePost(payload, userId);
            //     case 'addComment':
            //         return await handleAddComment(payload, userId);
            //     case 'followUser':
            //         return await handleFollowUser(payload, userId);
            case 'getProfile':
                result = await handleGetProfile(payload, userId);
                break;
            case 'getUserPosts':
                result = await handleGetUserPosts(payload, userId);
                break;
            case 'deletePost':
                result = await handleDeletePost(payload, userId);
                break;
            case 'addComment':
                result = await handleAddComment(payload, userId);
                break;
            case 'getComments':
                result = await handleGetComments(payload, userId);
                break;
            case 'getPostsByLocation':
                result = await handleGetPostsByLocation(payload, userId);
                break;
            case 'getSuggestedUsers':
                result = await handleGetSuggestedUsers(payload, userId);
                break;
            case 'getFollowersList':
            case 'getFollowingList':
                result = await handleGetFollowersFollowing(payload, userId, action);
                break;
            case 'searchUsers':
                result = await handleSearchUsers(payload, userId);
                break;
            case 'searchPosts':
                result = await handleSearchPosts(payload, userId);
                break;

            //     case 'updateProfile':
            //         return await handleUpdateProfile(payload, userId);
            //     // Add more actions as your app grows
            default:
                throwHttpsError('not-found', `Action "${action}" not found.`);
        }

        // 4. **Increment Rate Limit Counter (only after successful execution)**
        incrementRateLimit(userId, action);
        
        return result;

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
function generateSearchKeywords(postData) {
    const keywords = new Set(); // Use Set to automatically handle duplicates
    
    // Helper to clean and split text
    const cleanAndSplit = (text) => {
        if (!text || typeof text !== 'string') return [];
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
            .split(/\s+/) // Split on whitespace
            .filter(word => word.length > 1); // Filter out single characters
    };
    
    // Helper to add array of strings
    const addArrayTerms = (arr) => {
        if (Array.isArray(arr)) {
            arr.forEach(item => {
                if (typeof item === 'string') {
                    cleanAndSplit(item).forEach(word => keywords.add(word));
                }
            });
        }
    };
    
    // 1. Add words from top-level description
    if (postData.description) {
        cleanAndSplit(postData.description).forEach(word => keywords.add(word));
    }
    
    // 2. Add top-level tags
    addArrayTerms(postData.tags);
    
    // 3. Add year as string
    if (Array.isArray(postData.year)) {
        postData.year.forEach(y => {
            if (typeof y === 'number') {
                keywords.add(y.toString());
            }
        });
    }
    
    // 4. Process AiMetadata if it exists
    if (postData.AiMetadata && typeof postData.AiMetadata === 'object') {
        const ai = postData.AiMetadata;
        
        // AI description
        if (ai.description) {
            cleanAndSplit(ai.description).forEach(word => keywords.add(word));
        }
        
        // Cultural context
        if (ai.cultural_context) {
            cleanAndSplit(ai.cultural_context).forEach(word => keywords.add(word));
        }
        
        // Historical period
        if (ai.historical_period) {
            cleanAndSplit(ai.historical_period).forEach(word => keywords.add(word));
        }
        
        // Geographic terms
        addArrayTerms(ai.geographic_terms);
        
        // Subject terms
        addArrayTerms(ai.subject_terms);
        
        // All tags from AI
        addArrayTerms(ai.tags);
        
        // People identified (extract names without confidence levels)
        if (Array.isArray(ai.people_identified)) {
            ai.people_identified.forEach(person => {
                if (typeof person === 'string') {
                    // Remove confidence indicators like "(definite)" or "(probable)"
                    const cleanName = person.replace(/\s*\([^)]*\)\s*/g, '');
                    cleanAndSplit(cleanName).forEach(word => keywords.add(word));
                }
            });
        }
        
        // Date estimate
        if (ai.date_estimate) {
            cleanAndSplit(ai.date_estimate).forEach(word => keywords.add(word));
        }
        
        // Location from AI
        if (ai.location) {
            cleanAndSplit(ai.location).forEach(word => keywords.add(word));
        }
    }
    
    // Convert Set to Array and return
    return Array.from(keywords).sort(); // Sort for consistency
}

async function handleGetFeed(payload, userId) {
    const { limit = 10, lastPostId = null } = payload;
    const POST_LIMIT = limit;

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

        if (lastPostId) {
            const lastPostSnapshot = await db.collection(POSTS_COLLECTION).doc(lastPostId).get();
            if (lastPostSnapshot.exists) {
                postsQuery = postsQuery.startAfter(lastPostSnapshot);
            } else {
                console.warn(`lastPostId ${lastPostId} not found, fetching from start.`);
            }
        }

        // Fetch one extra document to check for 'hasMore'
        const postsSnapshot = await postsQuery.limit(POST_LIMIT + 1).get();

        // Check if there are more posts by comparing the actual fetched count
        const hasMore = postsSnapshot.docs.length > POST_LIMIT;

        // Only take the requested number of posts (exclude the extra one)
        const postDocs = postsSnapshot.docs.slice(0, POST_LIMIT);

        const fetchedPosts = await Promise.all(postDocs.map(async (doc) => {
            const postData = { id: doc.id, ...doc.data() };
            try {
                // Check if post is liked by current user
                const likeDocRef = db.collection(POSTS_COLLECTION)
                    .doc(doc.id)
                    .collection('likes')
                    .doc(userId);
                const likeDoc = await likeDocRef.get();
                postData.likedByCurrentUser = likeDoc.exists;

                // Check if post is bookmarked by current user
                const bookmarkDocRef = db.collection(USERS_COLLECTION)
                    .doc(userId)
                    .collection('bookmarks')
                    .doc(doc.id);
                const bookmarkDoc = await bookmarkDocRef.get();
                postData.bookmarkedByCurrentUser = bookmarkDoc.exists;
            } catch (err) {
                console.error(`Error checking like/bookmark for post ${doc.id}`, err);
                postData.likedByCurrentUser = false;
                postData.bookmarkedByCurrentUser = false;
            }
            return postData;
        }));

        // Get the last document ID for pagination
        const lastVisibleDoc = postDocs.length > 0 ? postDocs[postDocs.length - 1] : null;

        console.log(`Fetched ${fetchedPosts.length} posts for user ${userId}, hasMore: ${hasMore}`);

        return {
            posts: fetchedPosts,
            lastDocId: lastVisibleDoc ? lastVisibleDoc.id : null,
            hasMore: hasMore,
            message: 'Feed fetched successfully.',
        };
    } catch (error) {
        console.error('Error in handleGetFeed:', error);
        throwHttpsError('internal', 'Failed to fetch feed.', error.message);
    }
}
async function handleCreatePost(payload, userId) {
    const { description, type, fileUrls = [], location = null, year = [] } = payload;

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

    // // Validate location as GeoPoint
    // let validatedLocation = null;
    // if (location !== null && location !== undefined) {
    //     // Check if it's already a GeoPoint instance
    //     if (location instanceof GeoPoint) {
    //         validatedLocation = location;
    //     }
    //     // Check if it's an object with lat/lng properties
    //     else if (
    //         typeof location === 'object' &&
    //         typeof location.lat === 'number' &&
    //         typeof location.lng === 'number'
    //     ) {
    //         // Validate latitude and longitude ranges
    //         if (location.lat < -90 || location.lat > 90) {
    //             throwHttpsError('invalid-argument', 'Latitude must be between -90 and 90 degrees.');
    //         }
    //         if (location.lng < -180 || location.lng > 180) {
    //             throwHttpsError('invalid-argument', 'Longitude must be between -180 and 180 degrees.');
    //         }
    //         // Create GeoPoint from coordinates
    //         validatedLocation = new GeoPoint(location.lat, location.lng);
    //     }
    //     // Check if it's a Firestore serialized GeoPoint (has _latitude and _longitude)
    //     else if (
    //         typeof location === 'object' &&
    //         typeof location._latitude === 'number' &&
    //         typeof location._longitude === 'number'
    //     ) {
    //         validatedLocation = new GeoPoint(location._latitude, location._longitude);
    //     }
    //     else {
    //         throwHttpsError('invalid-argument', 'Location must be a valid GeoPoint or an object with lat/lng properties.');
    //     }
    // }

    if (!Array.isArray(year) || year.some(y => typeof y !== 'number' || y < 1000 || y > 3000)) { // Basic year range validation
        throwHttpsError('invalid-argument', 'Years must be an array of valid numbers.');
    }

    try {
    // --- 2. Use Transaction to ensure data consistency ---
    const result = await db.runTransaction(async (transaction) => {
        // Fetch User Data (for displayName, profilePicUrl etc.)
        const userRef = db.collection(USERS_COLLECTION).doc(userId);
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
            throwHttpsError('not-found', 'User profile not found. Cannot create post.');
        }
        const userData = userDoc.data();
        const userDisplayName = userData.displayName || userDoc.id; // Fallback to UID
        const userProfilePicUrl = userData.profilePictureUrl || null; // Get user's profile picture

        // AI Metadata generation (if applicable)
        let AiMetadata = null;
        if (type === 'photo' || type === 'document' || type === 'item') {
            try {
                AiMetadata = await analyzePhoto(fileUrls[0]);
                console.log('Photo analyzed successfully:', AiMetadata || 'No title');
            } catch (error) {
                console.warn('Photo analysis failed:', error.message);
                // Continue with post creation even if AI analysis fails
            }
        }

            // Create New Post Document in Firestore
            const newPostRef = db.collection(POSTS_COLLECTION).doc(); // Auto-generate ID

        const postData = {
            userId: userId,
            userDisplayName: userDisplayName,
            userProfilePicUrl: userProfilePicUrl, // Store user's profile pic with the post for easier display
            description: description.trim(),
            type: type,
            files: fileUrls, // Array of file URLs (or YouTube URL)
            location: (location && typeof location._lat === 'number' && typeof location._long === 'number')
                ? new admin.firestore.GeoPoint(location._lat, location._long)
                : null,
            year: year.sort((a, b) => a - b), // Ensure years are sorted
            likesCount: 0,
            commentsCount: 0,
            bookmarksCount: 0,
            createdAt: new Date(), // Server timestamp is best practice
            updatedAt: new Date(),
            AiMetadata
            // safeSearch: safeSearchLikelihood,
        };

        const searchKeywords = generateSearchKeywords(postData);
        postData.searchKeywords = searchKeywords;

        console.log(`Generated ${searchKeywords.length} search keywords:`, searchKeywords.slice(0, 10)); // Log first 10 for debugging

            // Create the post
            transaction.set(newPostRef, postData);

            // *** FIX: Increment user's postsCount ***
            const currentPostsCount = userData.postsCount || 0;
            transaction.update(userRef, {
                postsCount: currentPostsCount + 1,
                updatedAt: new Date()
            });

            return { postId: newPostRef.id };
        });

        console.log(`Post ${result.postId} (${type}) created by ${userId} and postsCount incremented`);
        return { postId: result.postId, message: 'Post created successfully!' };

    } catch (error) {
        console.error('Error in handleCreatePost:', error);
        if (error instanceof functions.https.HttpsError) {
            throw error; // Re-throw already handled HttpsErrors
        }
        throwHttpsError('internal', 'Failed to create post.', error.message);
    }
}


// System prompt for consistent, professional analysis
const SYSTEM_PROMPT = `You are an expert photo analyst specializing in historical and cultural documentation. You have knowledge of:
- Getty Vocabulary Program (AAT, TGN) for standardized terms
- Library of Congress Subject Headings (LCSH)
- Professional archival cataloging practices
- Historical figures, celebrities, and notable people

Your task is to analyze photographs and provide metadata that balances academic rigor with accessibility. Always:
1. Use controlled vocabularies and standardized terms when available
2. Provide multiple levels of geographic specificity
3. Include cultural and historical context
4. Generate comprehensive tags for high-quality search functionality
5. Use consistent terminology (e.g., "Berlin" not "berlin", "New York City" not "NYC")
6. Identify notable people when clearly visible, including historical figures, celebrities, and public personalities`;

// User prompt template
const USER_PROMPT = `Analyze this photograph and provide comprehensive metadata for search and cataloging purposes.

Return a JSON object with this exact structure:

{
  "description": "Clear description of what's happening in the image",
  "date_estimate": "Time period estimate (e.g., '1960s', '1980s', 'early 2000s')",
  "date_confidence": "definite|probable|possible|unknown",
  "location": "Most specific to general location (e.g., 'Times Square, New York City, United States')",
  "location_confidence": "definite|probable|possible|unknown", 
  "cultural_context": "Brief cultural or social context",
  "historical_period": "Historical period or era",
  "people_identified": ["Array of specific people if clearly identifiable with confidence levels"],
  "geographic_terms": ["Array of locations with TGN IDs when available, from specific to general"],
  "subject_terms": ["Array of subject classifications with AAT IDs when available"],
  "tags": ["Array of ~20 searchable tags covering objects, people, activities, time, place, style, mood, etc."]
}

Guidelines:
- Use standardized geographic names (Getty TGN preferred)
- Include all location levels in both location field and tags
- Use professional subject terms (Getty AAT preferred) 
- Generate ~20 tags for optimal search coverage
- Tags should include: specific objects/brands, general subjects, activities, time period, locations, style/mood
- **People identification**: If you can clearly identify specific historical figures, celebrities, politicians, or notable people, include them in both people_identified field and tags
- Use format like "Nelson Mandela (definite)" or "Elvis Presley (probable)" for people_identified
- Include identified people's names directly in tags (e.g., "Nelson Mandela", "John F. Kennedy")
- Use consistent capitalization and spelling`;


export async function analyzePhoto(photoUrl) {
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: SYSTEM_PROMPT
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: USER_PROMPT
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: photoUrl,
                                detail: 'auto'
                            }
                        }
                    ]
                }
            ],
            temperature: 0.3,
            max_tokens: 2000,
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(response.choices[0].message.content);
        return validateAndCleanResult(result);

    } catch (error) {
        console.error('Photo analysis failed:', error);
        throw new Error(`Failed to analyze photo: ${error.message}`);
    }
}

/**
 * Validates and cleans the API response
 */
function validateAndCleanResult(result) {
    // Return the new simplified structure
    const cleaned = {
        description: result.description || 'Photograph',
        date_estimate: result.date_estimate || 'Unknown period',
        date_confidence: result.date_confidence || 'unknown',
        location: result.location || 'Unknown location',
        location_confidence: result.location_confidence || 'unknown',
        cultural_context: result.cultural_context || '',
        historical_period: result.historical_period || '',
        people_identified: Array.isArray(result.people_identified) ? result.people_identified : [],
        geographic_terms: Array.isArray(result.geographic_terms) ? result.geographic_terms : [],
        subject_terms: Array.isArray(result.subject_terms) ? result.subject_terms : [],
        tags: Array.isArray(result.tags) ? result.tags : []
    };
    return cleaned;
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

async function handleLikePost(payload, userId) {
    const { postId } = payload;

    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }

    const postRef = db.collection(POSTS_COLLECTION).doc(postId);
    const likeRef = postRef.collection(LIKES_SUBCOLLECTION).doc(userId); // Document per user like

    try {
        const result = await db.runTransaction(async (transaction) => {
            const postDoc = await transaction.get(postRef);
            if (!postDoc.exists) {
                throwHttpsError('not-found', 'Post not found.');
            }

            const likeDoc = await transaction.get(likeRef);
            let newLikeCount = postDoc.data().likesCount || 0; // Note: using likesCount (plural) to match your schema
            let status;
            // race condition
            if (likeDoc.exists) {
                // User already liked, so unlike
                transaction.delete(likeRef);
                newLikeCount = Math.max(0, newLikeCount - 1); // Ensure count doesn't go below zero
                status = 'unliked';
            } else {
                // User has not liked, so like
                transaction.set(likeRef, {
                    userId: userId,
                    createdAt: new Date(), // Using new Date() to match your timestamp format
                });
                newLikeCount += 1;
                status = 'liked';
            }
            transaction.update(postRef, { likesCount: newLikeCount });
            return { status, newLikeCount };
        });

        console.log(`User ${userId} ${result.status} post ${postId}. New count: ${result.newLikeCount}`);
        return {
            status: result.status,
            newLikeCount: result.newLikeCount,
            postId: postId,
            message: 'Like status updated.'
        };
    } catch (error) {
        console.error(`Error in handleLikePost for post ${postId} by user ${userId}:`, error);
        // Ensure any custom errors from transaction also converted to HttpsError
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to update like status.', error.message);
    }
}

async function handleToggleBookmark(payload, userId) {
    const { postId } = payload;

    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }

    try {
        const result = await db.runTransaction(async (transaction) => {
            // References
            const postRef = db.collection(POSTS_COLLECTION).doc(postId);
            const userRef = db.collection(USERS_COLLECTION).doc(userId);
            const bookmarkRef = userRef.collection('bookmarks').doc(postId);

            // Check if post exists
            const postDoc = await transaction.get(postRef);
            if (!postDoc.exists) {
                throwHttpsError('not-found', 'Post not found.');
            }

            // Check if user has already bookmarked this post
            const bookmarkDoc = await transaction.get(bookmarkRef);

            let status;
            let newBookmarkCount = postDoc.data().bookmarksCount || 0;

            if (bookmarkDoc?.exists) {
                // User has bookmarked, so remove bookmark
                transaction.delete(bookmarkRef);
                newBookmarkCount = Math.max(0, newBookmarkCount - 1);
                status = 'unbookmarked';
            } else {
                // User hasn't bookmarked, so add bookmark
                transaction.set(bookmarkRef, {
                    postId: postId,
                    bookmarkedAt: new Date(),
                });
                newBookmarkCount += 1;
                status = 'bookmarked';
            }

            // Update bookmark count on the post
            transaction.update(postRef, {
                bookmarksCount: newBookmarkCount,
                updatedAt: new Date()
            });

            return { status, newBookmarkCount };
        });

        console.log(`User ${userId} ${result.status} post ${postId}. New bookmark count: ${result.newBookmarkCount}`);

        return {
            status: result.status,
            newBookmarkCount: result.newBookmarkCount,
            postId: postId,
            message: `Post ${result.status} successfully.`
        };

    } catch (error) {
        console.error(`Error toggling bookmark for post ${postId} by user ${userId}:`, error);

        if (error instanceof functions.https.HttpsError) {
            throw error;
        }

        throwHttpsError('internal', 'Failed to update bookmark status.', error.message);
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
async function handleGetProfile(payload, userId) {
    const { profileUserId } = payload;
    // Determine the target user ID: from payload for other profiles, or current user's ID
    const targetId = profileUserId || userId;

    if (!targetId || typeof targetId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid user ID is required to fetch a profile.');
    }

    try {
        const userDocRef = db.collection(USERS_COLLECTION).doc(targetId);
        const userDoc = await userDocRef.get();

        if (!userDoc.exists) {
            throwHttpsError('not-found', 'User profile not found.');
        }

        const profileData = userDoc.data();

        // --- Fetch Followers List (IDs) ---
        const followersSnapshot = await userDocRef.collection('followers').get();
        // Map over the documents to get an array of their IDs
        const followerIds = followersSnapshot.docs.map(doc => doc.id);
        profileData.followers = followerIds; // Add the array of IDs to profileData
        profileData.followersCount = followerIds.length; // You can still provide the count

        // --- Fetch Following List (IDs) ---
        const followingSnapshot = await userDocRef.collection('following').get();
        // Map over the documents to get an array of their IDs
        const followingIds = followingSnapshot.docs.map(doc => doc.id);
        profileData.following = followingIds; // Add the array of IDs to profileData
        profileData.followingCount = followingIds.length; // You can still provide the count

        // Optional: Also check if the *current authenticated user* is following this profile
        let isFollowedByCurrentUser = false;
        if (userId && userId !== targetId) { // Only relevant if viewing someone else's profile
            isFollowedByCurrentUser = followerIds.includes(userId);
            // This is more efficient than a separate Firestore read if followerIds is already fetched
            // const followerDoc = await userDocRef.collection('followers').doc(userId).get();
            // isFollowedByCurrentUser = followerDoc.exists;
        }
        profileData.isFollowedByCurrentUser = isFollowedByCurrentUser;


        // Remove sensitive or unnecessary data for public profiles
        if (profileUserId) { // If profileUserId is provided, it means it's a public profile request
            delete profileData.email;
            delete profileData.createdAt;
            delete profileData.updatedAt;
            // You might also want to remove 'followers' and 'following' arrays themselves
            // if you don't want them exposed directly on public profiles,
            // but just the counts. This depends on your app's privacy requirements.
            // If you only want counts, comment out the lines that set profileData.followers and profileData.following.
        }

        console.log(`Fetched profile for user ${targetId} with data ${JSON.stringify(profileData)}`);
        return { profile: profileData, message: 'Profile fetched successfully.' };

    } catch (error) {
        console.error(`Error in handleGetProfile for ${targetId}:`, error);
        throwHttpsError('internal', 'Failed to fetch profile.', error.message);
    }
}

async function handleGetFollowersFollowing(payload, userId, actionType) {
    const { profileUserId, limit = 50, lastUserId = null } = payload;

    // Basic validation
    if (!profileUserId || typeof profileUserId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid profileUserId is required.');
    }
    if (typeof limit !== 'number' || limit < 1 || limit > 100) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 100.');
    }
    if (lastUserId !== null && typeof lastUserId !== 'string') {
        throwHttpsError('invalid-argument', 'lastUserId must be a string or null.');
    }

    // IMPORTANT: Privacy validation - users can only see their own lists
    if (profileUserId !== userId) {
        throwHttpsError('permission-denied', 'You can only view your own followers/following lists.');
    }

    try {
        // Check if user exists
        const userDoc = await db.collection(USERS_COLLECTION).doc(profileUserId).get();
        if (!userDoc.exists) {
            throwHttpsError('not-found', 'User not found.');
        }

        const collectionName = actionType === 'getFollowersList' ? 'followers' : 'following';

        let query = db.collection(USERS_COLLECTION)
            .doc(profileUserId)
            .collection(collectionName)
            .orderBy('createdAt', 'desc');

        // Handle pagination
        if (lastUserId) {
            const lastUserSnapshot = await db.collection(USERS_COLLECTION)
                .doc(profileUserId)
                .collection(collectionName)
                .doc(lastUserId)
                .get();

            if (lastUserSnapshot.exists) {
                query = query.startAfter(lastUserSnapshot);
            } else {
                console.warn(`lastUserId ${lastUserId} not found, fetching from start.`);
            }
        }

        const snapshot = await query.limit(limit + 1).get();
        const hasMore = snapshot.docs.length > limit;
        const userDocs = snapshot.docs.slice(0, limit);

        // Get full user data for each follower/following
        const users = await Promise.all(
            userDocs.map(async (doc) => {
                const relationshipData = doc.data();
                const targetUserId = doc.id;

                try {
                    // Get the full user profile data
                    const targetUserDoc = await db.collection(USERS_COLLECTION).doc(targetUserId).get();

                    if (targetUserDoc.exists) {
                        const userData = targetUserDoc.data();
                        return {
                            userId: targetUserId,
                            displayName: userData.displayName,
                            profilePictureUrl: userData.profilePictureUrl,
                            bio: userData.bio || '',
                            followersCount: userData.followersCount || 0,
                            followingCount: userData.followingCount || 0,
                            postsCount: userData.postsCount || 0,
                            createdAt: relationshipData.createdAt,
                            // Check if current user is following this user (for follow/unfollow button)
                            isFollowedByCurrentUser: actionType === 'getFollowersList' ?
                                false : // Don't need this for followers list since it's obvious
                                true   // Don't need this for following list since it's obvious
                        };
                    }
                    return null;
                } catch (err) {
                    console.error(`Error fetching user data for ${targetUserId}:`, err);
                    return null;
                }
            })
        );

        // Filter out null results
        const validUsers = users.filter(user => user !== null);
        const lastVisibleDoc = userDocs.length > 0 ? userDocs[userDocs.length - 1] : null;

        console.log(`Fetched ${validUsers.length} ${collectionName} for user ${profileUserId}`);

        return {
            users: validUsers,
            count: validUsers.length,
            hasMore: hasMore,
            lastUserId: lastVisibleDoc ? lastVisibleDoc.id : null,
            listType: actionType === 'getFollowersList' ? 'followers' : 'following',
            message: `${actionType === 'getFollowersList' ? 'Followers' : 'Following'} list fetched successfully.`
        };

    } catch (error) {
        console.error(`Error in handleGetFollowersFollowing for ${profileUserId} (${actionType}):`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', `Failed to fetch ${actionType === 'getFollowersList' ? 'followers' : 'following'} list.`, error.message);
    }
}

async function handleGetPostsByLocation(payload, userId) {
    const { center, radiusKm = 10, limit = 50 } = payload;

    // Input validation
    if (!center || typeof center.lat !== 'number' || typeof center.lng !== 'number') {
        throwHttpsError('invalid-argument', 'Valid center coordinates (lat, lng) are required.');
    }
    if (typeof radiusKm !== 'number' || radiusKm < 0.1 || radiusKm > 100) {
        throwHttpsError('invalid-argument', 'Radius must be between 0.1 and 100 kilometers.');
    }
    if (typeof limit !== 'number' || limit < 1 || limit > 100) {
        throwHttpsError('invalid-argument', 'Limit must be between 1 and 100.');
    }

    try {
        // Convert radius to approximate lat/lng bounds for initial filtering
        // 1 degree latitude ≈ 111 km
        const latDelta = radiusKm / 111;
        const lngDelta = radiusKm / (111 * Math.cos(center.lat * Math.PI / 180));

        const northEast = new GeoPoint(center.lat + latDelta, center.lng + lngDelta);
        const southWest = new GeoPoint(center.lat - latDelta, center.lng - lngDelta);

        // Query posts with location within approximate bounds
        let postsQuery = db.collection(POSTS_COLLECTION)
            .where('location', '>=', southWest)
            .where('location', '<=', northEast)
            .orderBy('location')
            .limit(limit * 2); // Get more than needed to filter by exact distance

        const postsSnapshot = await postsQuery.get();

        // Function to calculate distance between two points using Haversine formula
        const calculateDistance = (lat1, lng1, lat2, lng2) => {
            const R = 6371; // Earth's radius in kilometers
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLng = (lng2 - lng1) * Math.PI / 180;
            const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng/2) * Math.sin(dLng/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            return R * c;
        };

        // Filter posts by exact distance and add user interaction data
        const filteredPosts = await Promise.all(
            postsSnapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(post => {
                    if (!post.location || !post.location._latitude || !post.location._longitude) {
                        return false;
                    }
                    const distance = calculateDistance(
                        center.lat, center.lng,
                        post.location._latitude, post.location._longitude
                    );
                    return distance <= radiusKm;
                })
                .slice(0, limit) // Final limit
                .map(async (post) => {
                    try {
                        // Check if current user liked this post
                        const likeDocRef = db.collection(POSTS_COLLECTION)
                            .doc(post.id)
                            .collection('likes')
                            .doc(userId);
                        const likeDoc = await likeDocRef.get();
                        post.likedByCurrentUser = likeDoc.exists;

                        // Check if current user bookmarked this post
                        const bookmarkDocRef = db.collection(USERS_COLLECTION)
                            .doc(userId)
                            .collection('bookmarks')
                            .doc(post.id);
                        const bookmarkDoc = await bookmarkDocRef.get();
                        post.bookmarkedByCurrentUser = bookmarkDoc.exists;

                        // Add distance for sorting/display
                        post.distanceKm = calculateDistance(
                            center.lat, center.lng,
                            post.location._latitude, post.location._longitude
                        );

                    } catch (err) {
                        console.error(`Error checking interactions for post ${post.id}:`, err);
                        post.likedByCurrentUser = false;
                        post.bookmarkedByCurrentUser = false;
                        post.distanceKm = 0;
                    }
                    return post;
                })
        );

        // Sort by distance (closest first)
        const sortedPosts = filteredPosts.sort((a, b) => a.distanceKm - b.distanceKm);

        console.log(`Found ${sortedPosts.length} posts within ${radiusKm}km of lat:${center.lat}, lng:${center.lng}`);

        return {
            posts: sortedPosts,
            center: center,
            radiusKm: radiusKm,
            count: sortedPosts.length,
            message: 'Location-based posts fetched successfully.'
        };

    } catch (error) {
        console.error(`Error in handleGetPostsByLocation:`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to fetch posts by location.', error.message);
    }
}

async function handleFollowUnfollow(payload, userId, actionType) {
    const { targetUserId } = payload;

    // 1. Basic Validation
    if (!userId) {
        throwHttpsError('unauthenticated', 'You must be authenticated to perform this action.');
    }
    if (!targetUserId || typeof targetUserId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid target user ID is required.');
    }
    if (userId === targetUserId) {
        throwHttpsError('invalid-argument', 'You cannot follow or unfollow yourself.');
    }
    if (actionType !== 'followUser' && actionType !== 'unfollowUser') {
        throwHttpsError('invalid-argument', 'Invalid action type. Must be "followUser" or "unfollowUser".');
    }

    const currentUserRef = db.collection(USERS_COLLECTION).doc(userId);
    const targetUserRef = db.collection(USERS_COLLECTION).doc(targetUserId);

    // Check if both users exist (optional but good for data integrity)
    const [currentUserDoc, targetUserDoc] = await Promise.all([
        currentUserRef.get(),
        targetUserRef.get()
    ]);

    if (!currentUserDoc.exists) {
        throwHttpsError('not-found', 'Your user profile was not found.');
    }
    if (!targetUserDoc.exists) {
        throwHttpsError('not-found', 'The target user profile was not found.');
    }

    // 2. Perform the transaction
    try {
        await db.runTransaction(async (transaction) => {
            const now = admin.firestore.FieldValue.serverTimestamp();

            // References to the specific documents in subcollections
            const currentUserFollowingDocRef = currentUserRef.collection('following').doc(targetUserId);
            const targetUserFollowersDocRef = targetUserRef.collection('followers').doc(userId);

            if (actionType === 'followUser') {
                // Check if already following to prevent redundant writes
                const currentUserFollowingDoc = await transaction.get(currentUserFollowingDocRef);
                if (currentUserFollowingDoc.exists) {
                    console.log(`User ${userId} already follows ${targetUserId}. No action needed.`);
                    return { message: 'Already following.' }; // Transaction will still commit successfully
                }

                // Add to current user's 'following' subcollection
                transaction.set(currentUserFollowingDocRef, { createdAt: now });
                // Add to target user's 'followers' subcollection
                transaction.set(targetUserFollowersDocRef, { createdAt: now });

                // Increment counts on main user documents
                transaction.update(currentUserRef, {
                    followingCount: admin.firestore.FieldValue.increment(1)
                });
                transaction.update(targetUserRef, {
                    followersCount: admin.firestore.FieldValue.increment(1)
                });

                console.log(`User ${userId} successfully followed ${targetUserId}.`);
                return { message: 'User followed successfully.' };

            } else if (actionType === 'unfollowUser') {
                // Check if currently following to prevent redundant writes
                const currentUserFollowingDoc = await transaction.get(currentUserFollowingDocRef);
                if (!currentUserFollowingDoc.exists) {
                    console.log(`User ${userId} does not follow ${targetUserId}. No action needed.`);
                    return { message: 'Not currently following.' }; // Transaction will still commit successfully
                }

                // Delete from current user's 'following' subcollection
                transaction.delete(currentUserFollowingDocRef);
                // Delete from target user's 'followers' subcollection
                transaction.delete(targetUserFollowersDocRef);

                // Decrement counts on main user documents (ensure not to go below 0)
                transaction.update(currentUserRef, {
                    followingCount: admin.firestore.FieldValue.increment(-1)
                });
                transaction.update(targetUserRef, {
                    followersCount: admin.firestore.FieldValue.increment(-1)
                });

                console.log(`User ${userId} successfully unfollowed ${targetUserId}.`);
                return { message: 'User unfollowed successfully.' };
            }
        });

        // The transaction itself handles the return value, so we return a generic success message here
        return { success: true, message: `${actionType === 'followUser' ? 'Follow' : 'Unfollow'} action completed.` };

    } catch (error) {
        console.error(`Error in handleFollowUnfollow for ${userId} and ${targetUserId} (${actionType}):`, error);
        // Rethrow an HTTPS error for the client
        throwHttpsError('internal', 'Failed to update follow status.', error.message);
    }
}

async function handleGetUserPosts(payload, userId) {
    const {
        profileUserId,
        limit = 10,
        lastPostId = null,
        includePrivate = false
    } = payload;

    const targetId = profileUserId || userId;

    if (!targetId || typeof targetId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid user ID is required to fetch posts.');
    }
    if (typeof limit !== 'number' || limit < 1 || limit > 50) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 50.');
    }
    if (lastPostId !== null && typeof lastPostId !== 'string') {
        throwHttpsError('invalid-argument', 'lastPostId must be a string or null.');
    }

    try {
        const userDoc = await db.collection(USERS_COLLECTION).doc(targetId).get();
        if (!userDoc.exists) {
            throwHttpsError('not-found', 'User not found.');
        }

        let postsQuery = db.collection(POSTS_COLLECTION)
            .where('userId', '==', targetId)
            .orderBy('createdAt', 'desc');

        if (lastPostId) {
            const lastPostSnapshot = await db.collection(POSTS_COLLECTION).doc(lastPostId).get();
            if (lastPostSnapshot.exists) {
                postsQuery = postsQuery.startAfter(lastPostSnapshot);
            } else {
                console.warn(`lastPostId ${lastPostId} not found, fetching from start.`);
            }
        }

        const postsSnapshot = await postsQuery.limit(limit + 1).get();
        const postDocs = postsSnapshot.docs.slice(0, limit);
        const hasMore = postsSnapshot.docs.length > limit;

        const posts = await Promise.all(postDocs.map(async (doc) => {
            const postData = { id: doc.id, ...doc.data() };

            try {
                const likeDocRef = db.collection(POSTS_COLLECTION)
                    .doc(doc.id)
                    .collection('likes')
                    .doc(userId); // Use requesting user's ID
                const likeDoc = await likeDocRef.get();
                postData.likedByCurrentUser = likeDoc.exists;

                const bookmarkDocRef = db.collection(USERS_COLLECTION)
                    .doc(userId) // Use requesting user's ID
                    .collection('bookmarks')
                    .doc(doc.id);
                const bookmarkDoc = await bookmarkDocRef.get();
                postData.bookmarkedByCurrentUser = bookmarkDoc.exists;

                if (profileUserId && profileUserId !== userId && !includePrivate) {
                    // Remove any sensitive fields if needed
                    // For now, keeping all post data public
                }

            } catch (err) {
                console.error(`Error checking like/bookmark for post ${doc.id}:`, err);
                postData.likedByCurrentUser = false;
                postData.bookmarkedByCurrentUser = false;
            }

            return postData;
        }));

        const lastVisibleDoc = postDocs.length > 0 ? postDocs[postDocs.length - 1] : null;

        console.log(`Fetched ${posts.length} posts for user ${targetId} (requested by ${userId})`);

        return {
            posts,
            count: posts.length,
            hasMore,
            lastDocId: lastVisibleDoc ? lastVisibleDoc.id : null,
            userId: targetId,
            message: 'User posts fetched successfully.'
        };

    } catch (error) {
        console.error(`Error in handleGetUserPosts for ${targetId}:`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to fetch user posts.', error.message);
    }
}

async function handleDeletePost(payload, userId) {
    const { postId } = payload;

    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }

    const postRef = db.collection(POSTS_COLLECTION).doc(postId);
    const userRef = db.collection(USERS_COLLECTION).doc(userId); // Define userRef here

    try {
        await db.runTransaction(async (transaction) => {
            const postDoc = await transaction.get(postRef);

            if (!postDoc.exists) {
                throwHttpsError('not-found', 'Post not found.');
            }

            const postData = postDoc.data();

            if (postData.userId !== userId) {
                throwHttpsError('permission-denied', 'You do not have permission to delete this post.');
            }

            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throwHttpsError('internal', 'User profile not found for post owner.');
            }
            const currentPostsCount = userDoc.data().postsCount || 0;

            // 1. Delete the post document itself
            transaction.delete(postRef);

            // 2. Delete all subcollections: Likes and Comments
            // Note: For very large collections, consider a separate Cloud Function triggered by onDelete.
            const likesSnapshot = await postRef.collection(LIKES_SUBCOLLECTION).get();
            likesSnapshot.docs.forEach(doc => {
                transaction.delete(doc.ref);
            });

            const commentsSnapshot = await postRef.collection(COMMENTS_SUBCOLLECTION).get();
            commentsSnapshot.docs.forEach(doc => {
                transaction.delete(doc.ref);
            });

            // // 3. Remove post from users' bookmarks via collection group query TODO
            // // Requires a Firestore index on 'bookmarks' collectionGroup: { collectionGroup: 'bookmarks', fields: ['postId'], orderBy: 'asc' }
            // const allBookmarksSnapshot = await db.collectionGroup(BOOKMARKS_SUBCOLLECTION)
            //     .where('postId', '==', postId)
            //     .get();
            // allBookmarksSnapshot.docs.forEach(bookmarkDoc => {
            //     transaction.delete(bookmarkDoc.ref);
            // });

            // 4. Decrement the user's `postsCount` ONLY if > 0
            if (currentPostsCount > 0) {
                transaction.update(userRef, {
                    postsCount: admin.firestore.FieldValue.increment(-1)
                });
            }
        });

        console.log(`Post ${postId} and all related data deleted successfully by user ${userId}.`);
        return { postId: postId, message: 'Post and all associated data deleted successfully!' };

    } catch (error) {
        console.error(`Error in handleDeletePost for post ${postId} by user ${userId}:`, error);
        // Only re-throw HttpsErrors, convert others to generic internal error
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to delete post and its related data.', error.message);
    }
}

async function handleAddComment(payload, userId) {
    const { postId, text } = payload;

    // Input validation
    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        throwHttpsError('invalid-argument', 'Comment text is required and must be a non-empty string.');
    }
    if (text.trim().length > 1000) { // Set reasonable character limit
        throwHttpsError('invalid-argument', 'Comment text cannot exceed 1000 characters.');
    }

    const postRef = db.collection(POSTS_COLLECTION).doc(postId);
    const commentsRef = postRef.collection(COMMENTS_SUBCOLLECTION);

    try {
        const result = await db.runTransaction(async (transaction) => {
            // Check if post exists
            const postDoc = await transaction.get(postRef);
            if (!postDoc.exists) {
                throwHttpsError('not-found', 'Post not found.');
            }

            // Get user data for the comment
            const userDoc = await transaction.get(db.collection(USERS_COLLECTION).doc(userId));
            const userData = userDoc.exists ? userDoc.data() : {};
            const userDisplayName = userData.displayName || `User_${userId.substring(0, 8)}`;
            const userProfilePicUrl = userData.profilePictureUrl || null;

            // Create new comment
            const newCommentRef = commentsRef.doc(); // Auto-generate comment ID
            const commentData = {
                userId: userId,
                userDisplayName: userDisplayName,
                userProfilePicUrl: userProfilePicUrl,
                text: text.trim(),
                createdAt: new Date(),
            };

            transaction.set(newCommentRef, commentData);

            // Increment comment count on the post
            const currentCommentsCount = postDoc.data().commentsCount || 0;
            transaction.update(postRef, {
                commentsCount: currentCommentsCount + 1,
                updatedAt: new Date()
            });

            return {
                commentId: newCommentRef.id,
                commentData: commentData,
                newCommentsCount: currentCommentsCount + 1
            };
        });

        console.log(`User ${userId} added comment to post ${postId}: "${text.trim()}"`);
        return {
            commentId: result.commentId,
            comment: result.commentData,
            newCommentsCount: result.newCommentsCount,
            message: 'Comment added successfully!'
        };

    } catch (error) {
        console.error(`Error in handleAddComment for post ${postId} by user ${userId}:`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to add comment.', error.message);
    }
}

async function handleGetComments(payload, userId) {
    const { postId, limit = 200, lastCommentId = null } = payload;

    // Input validation
    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }
    if (typeof limit !== 'number' || limit < 1 || limit > 500) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 50.');
    }
    if (lastCommentId !== null && typeof lastCommentId !== 'string') {
        throwHttpsError('invalid-argument', 'lastCommentId must be a string or null.');
    }

    try {
        // Check if post exists
        const postRef = db.collection(POSTS_COLLECTION).doc(postId);
        const postDoc = await postRef.get();
        if (!postDoc.exists) {
            throwHttpsError('not-found', 'Post not found.');
        }

        let commentsQuery = postRef.collection(COMMENTS_SUBCOLLECTION)
            .orderBy('createdAt', 'desc'); // Most recent comments first

        // Handle pagination
        if (lastCommentId) {
            const lastCommentSnapshot = await postRef.collection(COMMENTS_SUBCOLLECTION).doc(lastCommentId).get();
            if (lastCommentSnapshot.exists) {
                commentsQuery = commentsQuery.startAfter(lastCommentSnapshot);
            } else {
                console.warn(`lastCommentId ${lastCommentId} not found, fetching from start.`);
            }
        }

        const commentsSnapshot = await commentsQuery.limit(limit + 1).get();
        const commentDocs = commentsSnapshot.docs.slice(0, limit);
        const hasMore = commentsSnapshot.docs.length > limit;

        const comments = commentDocs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        const lastVisibleDoc = commentDocs.length > 0 ? commentDocs[commentDocs.length - 1] : null;

        console.log(`Fetched ${comments.length} comments for post ${postId}`);

        return {
            comments,
            postId,
            hasMore,
            lastDocId: lastVisibleDoc ? lastVisibleDoc.id : null,
            message: 'Comments fetched successfully.'
        };

    } catch (error) {
        console.error(`Error in handleGetComments for post ${postId}:`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to fetch comments.', error.message);
    }
}

async function handleGetSuggestedUsers(payload, userId) {
    const { limit = 5 } = payload;

    // Basic validation
    if (typeof limit !== 'number' || limit < 1 || limit > 20) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 20.');
    }

    try {
        // Calculate date 30 days ago
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // Get users that the current user is already following
        const currentUserRef = db.collection(USERS_COLLECTION).doc(userId);
        const followingSnapshot = await currentUserRef.collection('following').get();
        const followingIds = followingSnapshot.docs.map(doc => doc.id);
        followingIds.push(userId); // Also exclude self

        // Get posts from the last 30 days
        const recentPostsSnapshot = await db.collection(POSTS_COLLECTION)
            .where('createdAt', '>=', thirtyDaysAgo)
            .get();

        // Count posts per user in the last 30 days
        const userPostCounts = {};
        recentPostsSnapshot.docs.forEach(doc => {
            const postData = doc.data();
            const postUserId = postData.userId;
            
            // Skip if user is already followed or is current user
            if (followingIds.includes(postUserId)) {
                return;
            }

            if (!userPostCounts[postUserId]) {
                userPostCounts[postUserId] = {
                    count: 0,
                    userDisplayName: postData.userDisplayName,
                    userProfilePicUrl: postData.userProfilePicUrl
                };
            }
            userPostCounts[postUserId].count++;
        });

        // Convert to array and sort by post count (most active first)
        const activeUsers = Object.entries(userPostCounts)
            .map(([userId, data]) => ({
                userId,
                postCount: data.count,
                userDisplayName: data.userDisplayName,
                userProfilePicUrl: data.userProfilePicUrl
            }))
            .sort((a, b) => b.postCount - a.postCount)
            .slice(0, limit);

        // Get additional user data for the most active users
        const suggestedUsers = await Promise.all(
            activeUsers.map(async (user) => {
                try {
                    const userDoc = await db.collection(USERS_COLLECTION).doc(user.userId).get();
                    if (userDoc.exists) {
                        const userData = userDoc.data();
                        return {
                            userId: user.userId,
                            displayName: userData.displayName || user.userDisplayName,
                            profilePictureUrl: userData.profilePictureUrl || user.userProfilePicUrl,
                            followersCount: userData.followersCount || 0,
                            postsCount: userData.postsCount || 0,
                            recentPostsCount: user.postCount,
                            reason: `${user.postCount} recent posts`
                        };
                    }
                    return null;
                } catch (err) {
                    console.error(`Error fetching user data for ${user.userId}:`, err);
                    return null;
                }
            })
        );

        // Filter out null results
        const validSuggestions = suggestedUsers.filter(user => user !== null);

        console.log(`Found ${validSuggestions.length} suggested users for user ${userId}`);

        return {
            suggestedUsers: validSuggestions,
            count: validSuggestions.length,
            message: 'Suggested users fetched successfully.'
        };

    } catch (error) {
        console.error('Error in handleGetSuggestedUsers:', error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to fetch suggested users.', error.message);
    }
}

async function handleSearchUsers(payload, userId) {
    const { query, limit = 10 } = payload;

    // Input vali dation
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        throwHttpsError('invalid-argument', 'Search query is required and must be a non-empty string.');
    }
    if (query.trim().length < 2) {
        throwHttpsError('invalid-argument', 'Search query must be at least 2 characters long.');
    }
    if (typeof limit !== 'number' || limit < 1 || limit > 20) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 20.');
    }

    const searchTerm = query.trim().toLowerCase();

    try {
        // Create search variations for better matching
        const searchVariations = [
            searchTerm,
            searchTerm.charAt(0).toUpperCase() + searchTerm.slice(1), // Capitalize first letter
            searchTerm.toUpperCase() // All uppercase
        ];

        console.log(`Searching for users with query: "${searchTerm}"`);

        // We'll search for users where displayName contains the search term
        // Since Firestore doesn't have full-text search, we'll use array-contains-any with a workaround
        // Note: This is a basic implementation. For production, consider using Algolia or similar service.

        let allUsers = [];

        // Search by exact match first (most relevant)
        for (const variation of searchVariations) {
            const exactMatchQuery = db.collection(USERS_COLLECTION)
                .where('displayName', '>=', variation)
                .where('displayName', '<=', variation + '\uf8ff')
                .limit(limit);

            const exactMatchSnapshot = await exactMatchQuery.get();
            exactMatchSnapshot.docs.forEach(doc => {
                const userData = doc.data();
                allUsers.push({
                    userId: doc.id,
                    displayName: userData.displayName,
                    profilePictureUrl: userData.profilePictureUrl || null,
                    followersCount: userData.followersCount || 0,
                    postsCount: userData.postsCount || 0,
                    matchType: 'exact'
                });
            });
        }


        const uniqueUsers = allUsers
            .filter((user, index, self) => 
                index === self.findIndex(u => u.userId === user.userId) && 
                user.userId !== userId
            )
            .slice(0, limit);

        uniqueUsers.sort((a, b) => {
            if (a.matchType !== b.matchType) {
                return a.matchType === 'exact' ? -1 : 1;
            }
            return b.followersCount - a.followersCount;
        });

        console.log(`Found ${uniqueUsers.length} users matching query: "${searchTerm}"`);

        return {
            users: uniqueUsers,
            query: searchTerm,
            count: uniqueUsers.length,
            message: 'User search completed successfully.'
        };

    } catch (error) {
        console.error(`Error in handleSearchUsers for query "${searchTerm}":`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to search users.', error.message);
    }
}

async function handleSearchPosts(payload, userId) {
    const { query, limit = 20, lastPostId = null } = payload;

    // Input validation
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        throwHttpsError('invalid-argument', 'Search query is required and must be a non-empty string.');
    }
    if (query.trim().length < 2) {
        throwHttpsError('invalid-argument', 'Search query must be at least 2 characters long.');
    }
    if (typeof limit !== 'number' || limit < 1 || limit > 50) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 50.');
    }

    try {
        // Process search query: lowercase, split, clean
        const searchTerms = query
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
            .split(/\s+/) // Split on whitespace
            .filter(word => word.length > 1) // Filter out single characters
            .slice(0, 10); // Limit to 10 terms for performance

        if (searchTerms.length === 0) {
            return {
                posts: [],
                query: query.trim(),
                searchTerms: [],
                totalResults: 0,
                message: 'No valid search terms found.'
            };
        }

        console.log(`Searching posts with terms: [${searchTerms.join(', ')}]`);

        // Build Firestore query using array-contains-any
        let postsQuery = db.collection(POSTS_COLLECTION)
            .where('searchKeywords', 'array-contains-any', searchTerms)
            .orderBy('createdAt', 'desc');

        // Handle pagination
        if (lastPostId) {
            const lastPostSnapshot = await db.collection(POSTS_COLLECTION).doc(lastPostId).get();
            if (lastPostSnapshot.exists) {
                postsQuery = postsQuery.startAfter(lastPostSnapshot);
            }
        }

        // Get more results than needed for client-side filtering
        const querySnapshot = await postsQuery.limit(limit * 3).get();

        // Client-side filtering: ensure ALL search terms are present
        const filteredPosts = [];

        querySnapshot.docs.forEach(doc => {
            const postData = doc.data();
            const postKeywords = postData.searchKeywords || [];

            // Check if ALL search terms are present in this post's keywords
            const hasAllTerms = searchTerms.every(term =>
                postKeywords.some(keyword => keyword.includes(term))
            );

            if (hasAllTerms && filteredPosts.length < limit) {
                filteredPosts.push({
                    id: doc.id,
                    ...postData,
                    // Add search relevance info
                    matchedTerms: searchTerms.filter(term =>
                        postKeywords.some(keyword => keyword.includes(term))
                    ),
                    relevanceScore: calculateRelevanceScore(postData, searchTerms)
                });
            }
        });

        // Sort by relevance score (highest first)
        filteredPosts.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Add user interaction data (like/bookmark status)
        const enrichedPosts = await Promise.all(
            filteredPosts.map(async (post) => {
                try {
                    // Check if current user liked this post
                    const likeDocRef = db.collection(POSTS_COLLECTION)
                        .doc(post.id)
                        .collection('likes')
                        .doc(userId);
                    const likeDoc = await likeDocRef.get();
                    post.likedByCurrentUser = likeDoc.exists;

                    // Check if current user bookmarked this post
                    const bookmarkDocRef = db.collection(USERS_COLLECTION)
                        .doc(userId)
                        .collection('bookmarks')
                        .doc(post.id);
                    const bookmarkDoc = await bookmarkDocRef.get();
                    post.bookmarkedByCurrentUser = bookmarkDoc.exists;

                } catch (err) {
                    console.error(`Error checking interactions for post ${post.id}:`, err);
                    post.likedByCurrentUser = false;
                    post.bookmarkedByCurrentUser = false;
                }
                return post;
            })
        );

        const hasMore = querySnapshot.docs.length >= (limit * 3) && enrichedPosts.length >= limit;
        const lastVisibleDoc = enrichedPosts.length > 0 ?
            querySnapshot.docs.find(doc => doc.id === enrichedPosts[enrichedPosts.length - 1].id) :
            null;

        console.log(`Found ${enrichedPosts.length} posts matching all search terms: [${searchTerms.join(', ')}]`);

        return {
            posts: enrichedPosts,
            query: query.trim(),
            searchTerms: searchTerms,
            totalResults: enrichedPosts.length,
            hasMore: hasMore,
            lastDocId: lastVisibleDoc ? lastVisibleDoc.id : null,
            message: 'Post search completed successfully.'
        };

    } catch (error) {
        console.error(`Error in handleSearchPosts for query "${query}":`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to search posts.', error.message);
    }
}

// Helper function to calculate relevance score
function calculateRelevanceScore(postData, searchTerms) {
    let score = 0;
    const keywords = postData.searchKeywords || [];
    
    searchTerms.forEach(term => {
        // Exact matches in different fields get different weights
        if (postData.description && postData.description.toLowerCase().includes(term)) {
            score += 10; // High weight for description matches
        }
        
        if (postData.tags && postData.tags.some(tag => tag.toLowerCase().includes(term))) {
            score += 8; // High weight for tag matches
        }
        
        if (postData.AiMetadata?.tags && postData.AiMetadata.tags.some(tag => tag.toLowerCase().includes(term))) {
            score += 7; // AI tags
        }
        
        if (postData.AiMetadata?.subject_terms && postData.AiMetadata.subject_terms.some(subject => subject.toLowerCase().includes(term))) {
            score += 6; // Subject terms
        }
        
        if (postData.AiMetadata?.geographic_terms && postData.AiMetadata.geographic_terms.some(geo => geo.toLowerCase().includes(term))) {
            score += 5; // Geographic terms
        }
        
        // General keyword match (lowest weight)
        if (keywords.some(keyword => keyword.includes(term))) {
            score += 1;
        }
    });
    
    // Boost score based on post engagement
    score += (postData.likesCount || 0) * 0.1;
    score += (postData.commentsCount || 0) * 0.2;
    
    return score;
}

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