import functions from 'firebase-functions';
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
    users: new Map(), // userId -> { action -> { count, resetTime } }
    cleanup: null     // Cleanup interval reference
};
const checkRateLimit = (userId, action) => {
    const limits = RATE_LIMITS[action];
    if (!limits) {
        return true; // No limit defined for this action
    }

    const now = Date.now();
    const userLimits = rateLimiter.users.get(userId);
    
    if (!userLimits) {
        return true; // First request from this user
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

const rateLimitMiddleware = (userId, action) => {
    if (!checkRateLimit(userId, action)) {
        console.warn(`Rate limit exceeded: ${userId} attempted ${action}`);
        throw new functions.https.HttpsError('resource-exhausted', 'Rate limit exceeded. Please try again later.');
    }
};

if (!rateLimiter.cleanup) {
    rateLimiter.cleanup = setInterval(cleanupExpiredEntries, 15 * 60 * 1000); // Every 15 minutes
}

// --- Exports ---
export {
    checkRateLimit,
    incrementRateLimit,
    rateLimitMiddleware,
    cleanupExpiredEntries,
    RATE_LIMITS
};
