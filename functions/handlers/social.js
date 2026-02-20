import functions from 'firebase-functions';
import { db, admin } from '../utils/firebase.js';
import { throwHttpsError } from '../utils/errors.js';
import { COLLECTIONS, SUBCOLLECTIONS } from '../utils/constants.js';

export async function handleFollowUnfollow(payload, userId, actionType) {
    const { targetUserId } = payload;

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

    const currentUserRef = db.collection(COLLECTIONS.USERS).doc(userId);
    const targetUserRef = db.collection(COLLECTIONS.USERS).doc(targetUserId);

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

    try {
        await db.runTransaction(async (transaction) => {
            const now = admin.firestore.FieldValue.serverTimestamp();

            const currentUserFollowingDocRef = currentUserRef.collection('following').doc(targetUserId);
            const targetUserFollowersDocRef = targetUserRef.collection('followers').doc(userId);

            if (actionType === 'followUser') {
                const currentUserFollowingDoc = await transaction.get(currentUserFollowingDocRef);
                if (currentUserFollowingDoc.exists) {
                    console.log(`User ${userId} already follows ${targetUserId}. No action needed.`);
                    return { message: 'Already following.' };
                }

                transaction.set(currentUserFollowingDocRef, { createdAt: now });
                transaction.set(targetUserFollowersDocRef, { createdAt: now });

                transaction.update(currentUserRef, {
                    followingCount: admin.firestore.FieldValue.increment(1)
                });
                transaction.update(targetUserRef, {
                    followersCount: admin.firestore.FieldValue.increment(1)
                });

                console.log(`User ${userId} successfully followed ${targetUserId}.`);
                return { message: 'User followed successfully.' };

            } else if (actionType === 'unfollowUser') {
                const currentUserFollowingDoc = await transaction.get(currentUserFollowingDocRef);
                if (!currentUserFollowingDoc.exists) {
                    console.log(`User ${userId} does not follow ${targetUserId}. No action needed.`);
                    return { message: 'Not currently following.' };
                }

                transaction.delete(currentUserFollowingDocRef);
                transaction.delete(targetUserFollowersDocRef);

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

        return { success: true, message: `${actionType === 'followUser' ? 'Follow' : 'Unfollow'} action completed.` };

    } catch (error) {
        console.error(`Error in handleFollowUnfollow for ${userId} and ${targetUserId} (${actionType}):`, error);
        throwHttpsError('internal', 'Failed to update follow status.', error.message);
    }
}

export async function handleGetFollowersFollowing(payload, userId, actionType) {
    const { profileUserId, limit = 50, lastUserId = null } = payload;

    if (!profileUserId || typeof profileUserId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid profileUserId is required.');
    }
    if (typeof limit !== 'number' || limit < 1 || limit > 100) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 100.');
    }
    if (lastUserId !== null && typeof lastUserId !== 'string') {
        throwHttpsError('invalid-argument', 'lastUserId must be a string or null.');
    }

    if (profileUserId !== userId) {
        throwHttpsError('permission-denied', 'You can only view your own followers/following lists.');
    }

    try {
        const userDoc = await db.collection(COLLECTIONS.USERS).doc(profileUserId).get();
        if (!userDoc.exists) {
            throwHttpsError('not-found', 'User not found.');
        }

        const collectionName = actionType === 'getFollowersList' ? 'followers' : 'following';

        let query = db.collection(COLLECTIONS.USERS)
            .doc(profileUserId)
            .collection(collectionName)
            .orderBy('createdAt', 'desc');

        if (lastUserId) {
            const lastUserSnapshot = await db.collection(COLLECTIONS.USERS)
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

        const users = await Promise.all(
            userDocs.map(async (doc) => {
                const relationshipData = doc.data();
                const targetUserId = doc.id;

                try {
                    const targetUserDoc = await db.collection(COLLECTIONS.USERS).doc(targetUserId).get();

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
                            isFollowedByCurrentUser: actionType === 'getFollowersList' ?
                                false :
                                true
                        };
                    }
                    return null;
                } catch (err) {
                    console.error(`Error fetching user data for ${targetUserId}:`, err);
                    return null;
                }
            })
        );

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
