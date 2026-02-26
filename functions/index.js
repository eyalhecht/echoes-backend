import 'dotenv/config';
import functions from 'firebase-functions';
import './utils/firebase.js'; // triggers admin.initializeApp()
import { throwHttpsError } from './utils/errors.js';
import { openaiApiKey, analyzePhoto, runVisionAnalysis } from './utils/ai.js';

import { handleCreatePost, handleDeletePost, handleGetPost, handleLikePost, handleToggleBookmark, handleGetBookmarks, handleAddComment, handleGetComments } from './handlers/posts.js';
import { handleGetFeed, handleGetTrending, handleSearchPosts, handleGetPostsByLocation } from './handlers/feed.js';
import { handleCreateUserProfile, handleGetProfile, handleGetUserPosts, handleGetSuggestedUsers, handleSearchUsers } from './handlers/users.js';
import { handleFollowUnfollow, handleGetFollowersFollowing } from './handlers/social.js';
import { handleDeleteUserAccount } from './handlers/account.js';

export const api = functions.https.onCall({ secrets: [openaiApiKey] }, async (request, response) => {
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

    const handlers = {
        createPost:        (p, u) => handleCreatePost(p, u),
        deletePost:        (p, u) => handleDeletePost(p, u),
        getPost:           (p, u) => handleGetPost(p, u),
        likePost:          (p, u) => handleLikePost(p, u),
        toggleBookmark:    (p, u) => handleToggleBookmark(p, u),
        getBookmarks:      (p, u) => handleGetBookmarks(p, u),
        addComment:        (p, u) => handleAddComment(p, u),
        getComments:       (p, u) => handleGetComments(p, u),
        getFeed:           (p, u) => handleGetFeed(p, u),
        getTrending:       (p, u) => handleGetTrending(p, u),
        searchPosts:       (p, u) => handleSearchPosts(p, u),
        getPostsByLocation:(p, u) => handleGetPostsByLocation(p, u),
        createUserProfile: (p, u) => handleCreateUserProfile(p, u),
        getProfile:        (p, u) => handleGetProfile(p, u),
        getUserPosts:      (p, u) => handleGetUserPosts(p, u),
        getSuggestedUsers: (p, u) => handleGetSuggestedUsers(p, u),
        searchUsers:       (p, u) => handleSearchUsers(p, u),
        followUser:        (p, u) => handleFollowUnfollow(p, u, 'followUser'),
        unfollowUser:      (p, u) => handleFollowUnfollow(p, u, 'unfollowUser'),
        getFollowersList:  (p, u) => handleGetFollowersFollowing(p, u, 'getFollowersList'),
        getFollowingList:  (p, u) => handleGetFollowersFollowing(p, u, 'getFollowingList'),
        deleteUserAccount: (p, u) => handleDeleteUserAccount(p, u),
    };

    try {
        const handler = handlers[action];
        if (!handler) throwHttpsError('not-found', `Action "${action}" not found.`);

        const result = await handler(payload, userId);
        return result;

    } catch (error) {
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        console.error(`Error processing action "${action}" for user ${userId}:`, error);
        throwHttpsError('internal', 'An unexpected error occurred.', error.message);
    }
});

export { analyzePhoto, runVisionAnalysis };
