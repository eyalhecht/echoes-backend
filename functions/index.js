import 'dotenv/config';
import functions from 'firebase-functions';
import './utils/firebase.js'; // triggers admin.initializeApp()
import { throwHttpsError } from './utils/errors.js';
import { openaiApiKey, analyzePhoto, moderateImage } from './utils/ai.js';

import { handleCreatePost, handleDeletePost, handleGetPost, handleLikePost, handleToggleBookmark, handleGetBookmarks, handleAddComment, handleGetComments } from './handlers/posts.js';
import { handleGetFeed, handleGetTrending, handleSearchPosts, handleGetPostsByLocation } from './handlers/feed.js';
import { handleCreateUserProfile, handleGetProfile, handleGetUserPosts, handleGetSuggestedUsers, handleSearchUsers } from './handlers/users.js';
import { handleFollowUnfollow, handleGetFollowersFollowing } from './handlers/social.js';
import { handleDeleteUserAccount } from './handlers/account.js';

export const apiGateway = functions.https.onCall({ secrets: [openaiApiKey] }, async (request, response) => {
    if (!request.auth) {
        throwHttpsError('unauthenticated', 'Authentication required for this action.');
    }

    const userId = request.auth.uid;
    const userEmail = request.auth.token.email;
    console.log(`API call by user: ${userId} (${userEmail})`);

    const data = request.data;
    const { action, payload } = data;
    console.log(`action:`, action);
    console.log(`payload:`, payload);

    try {
        let result;
        switch (action) {
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
            case 'getBookmarks':
                result = await handleGetBookmarks(payload, userId);
                break;
            case 'getTrending':
                result = await handleGetTrending(payload, userId);
                break;
            case 'getPost':
                result = await handleGetPost(payload, userId);
                break;
            case 'deleteUserAccount':
                result = await handleDeleteUserAccount(payload, userId);
                break;
            default:
                throwHttpsError('not-found', `Action "${action}" not found.`);
        }

        return result;

    } catch (error) {
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        console.error(`Error processing action "${action}" for user ${userId}:`, error);
        throwHttpsError('internal', 'An unexpected error occurred.', error.message);
    }
});

export { analyzePhoto, moderateImage };
