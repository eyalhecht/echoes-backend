import functions from 'firebase-functions';
import { db } from '../utils/firebase.js';
import { throwHttpsError } from '../utils/errors.js';
import { COLLECTIONS, SUBCOLLECTIONS } from '../utils/constants.js';

export async function handleCreateUserProfile(payload, userId) {
    const { displayName, photoURL } = payload || {};

    try {
        const existingProfile = await db.collection(COLLECTIONS.USERS).doc(userId).get();
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

        await db.collection(COLLECTIONS.USERS).doc(userId).set(profileData);
        console.log(`Profile created successfully for ${userId}`);

        return { message: 'Profile created successfully', profile: profileData };
    } catch (error) {
        console.error(`Error creating profile for user ${userId}:`, error);
        throwHttpsError('internal', 'Failed to create profile', error.message);
    }
}

export async function handleGetProfile(payload, userId) {
    const { profileUserId } = payload;
    const targetId = profileUserId || userId;

    if (!targetId || typeof targetId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid user ID is required to fetch a profile.');
    }

    try {
        const userDocRef = db.collection(COLLECTIONS.USERS).doc(targetId);
        const userDoc = await userDocRef.get();

        if (!userDoc.exists) {
            throwHttpsError('not-found', 'User profile not found.');
        }

        const profileData = userDoc.data();

        const followersSnapshot = await userDocRef.collection(SUBCOLLECTIONS.FOLLOWERS).get();
        const followerIds = followersSnapshot.docs.map(doc => doc.id);
        profileData.followers = followerIds;
        profileData.followersCount = followerIds.length;

        const followingSnapshot = await userDocRef.collection(SUBCOLLECTIONS.FOLLOWING).get();
        const followingIds = followingSnapshot.docs.map(doc => doc.id);
        profileData.following = followingIds;
        profileData.followingCount = followingIds.length;

        let isFollowedByCurrentUser = false;
        if (userId && userId !== targetId) {
            isFollowedByCurrentUser = followerIds.includes(userId);
        }
        profileData.isFollowedByCurrentUser = isFollowedByCurrentUser;

        if (profileUserId) {
            delete profileData.email;
            delete profileData.createdAt;
            delete profileData.updatedAt;
        }

        console.log(`Fetched profile for user ${targetId} with data ${JSON.stringify(profileData)}`);
        return { profile: profileData, message: 'Profile fetched successfully.' };

    } catch (error) {
        console.error(`Error in handleGetProfile for ${targetId}:`, error);
        throwHttpsError('internal', 'Failed to fetch profile.', error.message);
    }
}

export async function handleGetUserPosts(payload, userId) {
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
        const userDoc = await db.collection(COLLECTIONS.USERS).doc(targetId).get();
        if (!userDoc.exists) {
            throwHttpsError('not-found', 'User not found.');
        }

        let postsQuery = db.collection(COLLECTIONS.POSTS)
            .where('userId', '==', targetId)
            .orderBy('createdAt', 'desc');

        if (lastPostId) {
            const lastPostSnapshot = await db.collection(COLLECTIONS.POSTS).doc(lastPostId).get();
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
                const likeDocRef = db.collection(COLLECTIONS.POSTS)
                    .doc(doc.id)
                    .collection('likes')
                    .doc(userId);
                const likeDoc = await likeDocRef.get();
                postData.likedByCurrentUser = likeDoc.exists;

                const bookmarkDocRef = db.collection(COLLECTIONS.USERS)
                    .doc(userId)
                    .collection('bookmarks')
                    .doc(doc.id);
                const bookmarkDoc = await bookmarkDocRef.get();
                postData.bookmarkedByCurrentUser = bookmarkDoc.exists;

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

export async function handleGetSuggestedUsers(payload, userId) {
    const { limit = 5 } = payload;

    if (typeof limit !== 'number' || limit < 1 || limit > 20) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 20.');
    }

    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const currentUserRef = db.collection(COLLECTIONS.USERS).doc(userId);
        const followingSnapshot = await currentUserRef.collection('following').get();
        const followingIds = followingSnapshot.docs.map(doc => doc.id);
        followingIds.push(userId);

        const recentPostsSnapshot = await db.collection(COLLECTIONS.POSTS)
            .where('createdAt', '>=', thirtyDaysAgo)
            .get();

        const userPostCounts = {};
        recentPostsSnapshot.docs.forEach(doc => {
            const postData = doc.data();
            const postUserId = postData.userId;

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

        const activeUsers = Object.entries(userPostCounts)
            .map(([userId, data]) => ({
                userId,
                postCount: data.count,
                userDisplayName: data.userDisplayName,
                userProfilePicUrl: data.userProfilePicUrl
            }))
            .sort((a, b) => b.postCount - a.postCount)
            .slice(0, limit);

        const suggestedUsers = await Promise.all(
            activeUsers.map(async (user) => {
                try {
                    const userDoc = await db.collection(COLLECTIONS.USERS).doc(user.userId).get();
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

export async function handleSearchUsers(payload, userId) {
    const { query, limit = 10 } = payload;

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
        const searchVariations = [
            searchTerm,
            searchTerm.charAt(0).toUpperCase() + searchTerm.slice(1),
            searchTerm.toUpperCase()
        ];

        console.log(`Searching for users with query: "${searchTerm}"`);

        let allUsers = [];

        for (const variation of searchVariations) {
            const exactMatchQuery = db.collection(COLLECTIONS.USERS)
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
