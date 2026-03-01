// --- Firestore Collections ---
export const COLLECTIONS = {
    POSTS: 'posts',
    USERS: 'users'
};

// --- Subcollections ---
export const SUBCOLLECTIONS = {
    COMMENTS: 'comments',
    LIKES: 'likes',
    FOLLOWERS: 'followers',
    FOLLOWING: 'following',
    BOOKMARKS: 'bookmarks'
};

// --- Validation Limits ---
export const LIMITS = {
    POST_DESCRIPTION_MAX: 5000,
    COMMENT_TEXT_MAX: 1000,
    BIO_MAX: 500,
    DISPLAY_NAME_MAX: 50,
    FEED_LIMIT_MAX: 100,
    USER_POSTS_LIMIT_MAX: 50,
    SEARCH_LIMIT_MAX: 50,
    FOLLOWERS_LIMIT_MAX: 100,
    COMMENTS_LIMIT_MAX: 500,
    LOCATION_RADIUS_MAX: 100,
    SEARCH_QUERY_MIN: 2,
    YEAR_MIN: 1000,
    YEAR_MAX: 3000
};

// --- Default Values ---
export const DEFAULTS = {
    FEED_LIMIT: 10,
    USER_POSTS_LIMIT: 10,
    COMMENTS_LIMIT: 200,
    FOLLOWERS_LIMIT: 50,
    SEARCH_LIMIT: 10,
    SUGGESTED_USERS_LIMIT: 5,
    LOCATION_RADIUS: 10,
    LOCATION_POSTS_LIMIT: 50,
    TRENDING_LIMIT: 20
};

// --- Post Configuration ---
export const POST_TYPES = [
    'photo',
    'video', 
    'document',
    'item',
    'youtube'
];

// --- AI Analysis Configuration ---
export const AI_CONFIG = {
    TEMPERATURE: 0.3,
    MAX_TOKENS: 2000,
    MODEL: "gpt-4o",
    DETAIL: 'auto',
    VISION_MAX_LANDMARKS: 5,
    VISION_MAX_LABELS: 10,
    VISION_MAX_WEB_RESULTS: 10,
    VISION_TEXT_MAX_CHARS: 500,
    VISION_MAX_LOGOS: 10,
};

// --- Geographic Constants ---
export const GEO = {
    LAT_MIN: -90,
    LAT_MAX: 90,
    LNG_MIN: -180,
    LNG_MAX: 180,
    KM_PER_DEGREE_LAT: 111
};

// --- Time Constants ---
export const TIME = {
    SUGGESTED_USERS_DAYS_BACK: 30,
    CLEANUP_INTERVAL_MS: 15 * 60 * 1000 // 15 minutes
};
