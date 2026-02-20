import { db, admin } from '../utils/firebase.js';
import { throwHttpsError } from '../utils/errors.js';
import { COLLECTIONS, SUBCOLLECTIONS } from '../utils/constants.js';

export async function handleDeleteUserAccount(payload, userId) {
    if (!userId || typeof userId !== 'string') {
        throwHttpsError('unauthenticated', 'Valid authentication required for account deletion.');
    }
    const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
        throwHttpsError('not-found', 'User account not found.');
    }
    console.log(`Account deletion initiated for user: ${userId}`);
    executeUserDeletion(userId).catch(error => {
        console.error(`Background deletion failed for user ${userId}:`, error);
    });
    return {
        message: 'Account deletion initiated. Your account and all associated data will be permanently deleted.',
        userId: userId,
        timestamp: new Date().toISOString(),
        warning: 'This action cannot be undone. You will be logged out shortly.'
    };
}

async function executeUserDeletion(userId) {
    const startTime = Date.now();
    console.log(`🗑️ [AUDIT] Starting complete deletion for user ${userId} at ${new Date().toISOString()}`);

    let deletionStats = {
        postsDeleted: 0,
        commentsDeleted: 0,
        likesDeleted: 0,
        bookmarksDeleted: 0,
        followRelationshipsDeleted: 0,
        errors: []
    };

    try {
        console.log(`🗑️ [AUDIT] Phase 1: Deleting user's posts for ${userId}`);
        await deleteUserPosts(userId, deletionStats);

        console.log(`🗑️ [AUDIT] Phase 2: Cleaning follower/following relationships for ${userId}`);
        await cleanupFollowRelationships(userId, deletionStats);

        console.log(`🗑️ [AUDIT] Phase 3: Deleting user's likes for ${userId}`);
        await deleteUserLikes(userId, deletionStats);

        console.log(`🗑️ [AUDIT] Phase 4: Deleting user's comments for ${userId}`);
        await deleteUserComments(userId, deletionStats);

        console.log(`🗑️ [AUDIT] Phase 5: Deleting user's bookmarks for ${userId}`);
        await deleteUserBookmarks(userId, deletionStats);

        console.log(`🗑️ [AUDIT] Phase 6: Deleting user document for ${userId}`);
        await db.collection(COLLECTIONS.USERS).doc(userId).delete();

        console.log(`🗑️ [AUDIT] Phase 7: Deleting Firebase Auth account for ${userId}`);
        try {
            await admin.auth().deleteUser(userId);
            console.log(`✅ [AUDIT] Firebase Auth account deleted for ${userId}`);
        } catch (authError) {
            console.error(`⚠️ [AUDIT] Firebase Auth deletion failed for ${userId}:`, authError.message);
            deletionStats.errors.push(`Auth deletion failed: ${authError.message}`);
        }

        const totalTime = Date.now() - startTime;
        console.log(`✅ [AUDIT] Complete deletion finished for user ${userId}:`);
        console.log(`   📊 Posts deleted: ${deletionStats.postsDeleted}`);
        console.log(`   📊 Comments deleted: ${deletionStats.commentsDeleted}`);
        console.log(`   📊 Likes deleted: ${deletionStats.likesDeleted}`);
        console.log(`   📊 Bookmarks deleted: ${deletionStats.bookmarksDeleted}`);
        console.log(`   📊 Follow relationships deleted: ${deletionStats.followRelationshipsDeleted}`);
        console.log(`   ⏱️ Total time: ${totalTime}ms`);

        if (deletionStats.errors.length > 0) {
            console.log(`   ⚠️ Errors encountered: ${deletionStats.errors.length}`);
            deletionStats.errors.forEach(error => console.log(`      - ${error}`));
        } else {
            console.log(`   ✨ No errors - complete success!`);
        }

    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.error(`❌ [AUDIT] User deletion failed for ${userId} after ${totalTime}ms:`, error);
        console.error(`   📊 Partial completion stats:`, deletionStats);
    }
}

async function deleteUserPosts(userId, stats) {
    try {
        const postsQuery = db.collection(COLLECTIONS.POSTS).where('userId', '==', userId);
        const postsSnapshot = await postsQuery.get();

        console.log(`   🔍 Found ${postsSnapshot.docs.length} posts to delete for user ${userId}`);

        for (const postDoc of postsSnapshot.docs) {
            try {
                const postRef = postDoc.ref;

                const likesSnapshot = await postRef.collection(SUBCOLLECTIONS.LIKES).get();
                const deletelikesPromises = likesSnapshot.docs.map(doc => doc.ref.delete());
                await Promise.all(deletelikesPromises);

                const commentsSnapshot = await postRef.collection(SUBCOLLECTIONS.COMMENTS).get();
                const deleteCommentsPromises = commentsSnapshot.docs.map(doc => doc.ref.delete());
                await Promise.all(deleteCommentsPromises);

                await postRef.delete();

                stats.postsDeleted++;
                console.log(`   ✅ Deleted post ${postDoc.id} with ${likesSnapshot.docs.length} likes and ${commentsSnapshot.docs.length} comments`);

            } catch (postError) {
                const errorMsg = `Failed to delete post ${postDoc.id}: ${postError.message}`;
                console.error(`   ❌ ${errorMsg}`);
                stats.errors.push(errorMsg);
            }
        }

    } catch (error) {
        const errorMsg = `Failed to query user posts: ${error.message}`;
        console.error(`   ❌ ${errorMsg}`);
        stats.errors.push(errorMsg);
    }
}

async function cleanupFollowRelationships(userId, stats) {
    try {
        const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
        const followersSnapshot = await userRef.collection(SUBCOLLECTIONS.FOLLOWERS).get();

        console.log(`   🔍 Found ${followersSnapshot.docs.length} followers to clean up for user ${userId}`);

        for (const followerDoc of followersSnapshot.docs) {
            try {
                const followerId = followerDoc.id;
                const followerUserRef = db.collection(COLLECTIONS.USERS).doc(followerId);

                await db.runTransaction(async (transaction) => {
                    const followerUserDoc = await transaction.get(followerUserRef);
                    if (followerUserDoc.exists) {
                        const followingRef = followerUserRef.collection(SUBCOLLECTIONS.FOLLOWING).doc(userId);
                        transaction.delete(followingRef);

                        const currentCount = followerUserDoc.data().followingCount || 0;
                        transaction.update(followerUserRef, {
                            followingCount: Math.max(0, currentCount - 1)
                        });
                    }
                });

                stats.followRelationshipsDeleted++;

            } catch (relationError) {
                const errorMsg = `Failed to clean follower relationship ${followerDoc.id}: ${relationError.message}`;
                console.error(`   ❌ ${errorMsg}`);
                stats.errors.push(errorMsg);
            }
        }

        const followingSnapshot = await userRef.collection(SUBCOLLECTIONS.FOLLOWING).get();

        console.log(`   🔍 Found ${followingSnapshot.docs.length} following relationships to clean up for user ${userId}`);

        for (const followingDoc of followingSnapshot.docs) {
            try {
                const followedUserId = followingDoc.id;
                const followedUserRef = db.collection(COLLECTIONS.USERS).doc(followedUserId);

                await db.runTransaction(async (transaction) => {
                    const followedUserDoc = await transaction.get(followedUserRef);
                    if (followedUserDoc.exists) {
                        const followersRef = followedUserRef.collection(SUBCOLLECTIONS.FOLLOWERS).doc(userId);
                        transaction.delete(followersRef);

                        const currentCount = followedUserDoc.data().followersCount || 0;
                        transaction.update(followedUserRef, {
                            followersCount: Math.max(0, currentCount - 1)
                        });
                    }
                });

                stats.followRelationshipsDeleted++;

            } catch (relationError) {
                const errorMsg = `Failed to clean following relationship ${followingDoc.id}: ${relationError.message}`;
                console.error(`   ❌ ${errorMsg}`);
                stats.errors.push(errorMsg);
            }
        }

    } catch (error) {
        const errorMsg = `Failed to query follow relationships: ${error.message}`;
        console.error(`   ❌ ${errorMsg}`);
        stats.errors.push(errorMsg);
    }
}

async function deleteUserLikes(userId, stats) {
    try {
        const likesQuery = db.collectionGroup(SUBCOLLECTIONS.LIKES).where('userId', '==', userId);
        const likesSnapshot = await likesQuery.get();

        console.log(`   🔍 Found ${likesSnapshot.docs.length} likes to delete for user ${userId}`);

        for (const likeDoc of likesSnapshot.docs) {
            try {
                const pathParts = likeDoc.ref.path.split('/');
                const postId = pathParts[1];

                await db.runTransaction(async (transaction) => {
                    const postRef = db.collection(COLLECTIONS.POSTS).doc(postId);
                    const postDoc = await transaction.get(postRef);

                    if (postDoc.exists) {
                        transaction.delete(likeDoc.ref);

                        const currentCount = postDoc.data().likesCount || 0;
                        transaction.update(postRef, {
                            likesCount: Math.max(0, currentCount - 1)
                        });
                    }
                });

                stats.likesDeleted++;

            } catch (likeError) {
                const errorMsg = `Failed to delete like ${likeDoc.id}: ${likeError.message}`;
                console.error(`   ❌ ${errorMsg}`);
                stats.errors.push(errorMsg);
            }
        }

    } catch (error) {
        const errorMsg = `Failed to query user likes: ${error.message}`;
        console.error(`   ❌ ${errorMsg}`);
        stats.errors.push(errorMsg);
    }
}

async function deleteUserComments(userId, stats) {
    try {
        const commentsQuery = db.collectionGroup(SUBCOLLECTIONS.COMMENTS).where('userId', '==', userId);
        const commentsSnapshot = await commentsQuery.get();

        console.log(`   🔍 Found ${commentsSnapshot.docs.length} comments to delete for user ${userId}`);

        for (const commentDoc of commentsSnapshot.docs) {
            try {
                const pathParts = commentDoc.ref.path.split('/');
                const postId = pathParts[1];

                await db.runTransaction(async (transaction) => {
                    const postRef = db.collection(COLLECTIONS.POSTS).doc(postId);
                    const postDoc = await transaction.get(postRef);

                    if (postDoc.exists) {
                        transaction.delete(commentDoc.ref);

                        const currentCount = postDoc.data().commentsCount || 0;
                        transaction.update(postRef, {
                            commentsCount: Math.max(0, currentCount - 1)
                        });
                    }
                });

                stats.commentsDeleted++;

            } catch (commentError) {
                const errorMsg = `Failed to delete comment ${commentDoc.id}: ${commentError.message}`;
                console.error(`   ❌ ${errorMsg}`);
                stats.errors.push(errorMsg);
            }
        }

    } catch (error) {
        const errorMsg = `Failed to query user comments: ${error.message}`;
        console.error(`   ❌ ${errorMsg}`);
        stats.errors.push(errorMsg);
    }
}

async function deleteUserBookmarks(userId, stats) {
    try {
        const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
        const bookmarksSnapshot = await userRef.collection(SUBCOLLECTIONS.BOOKMARKS).get();

        console.log(`   🔍 Found ${bookmarksSnapshot.docs.length} bookmarks to delete for user ${userId}`);

        for (const bookmarkDoc of bookmarksSnapshot.docs) {
            try {
                const postId = bookmarkDoc.id;

                await db.runTransaction(async (transaction) => {
                    const postRef = db.collection(COLLECTIONS.POSTS).doc(postId);
                    const postDoc = await transaction.get(postRef);

                    if (postDoc.exists) {
                        transaction.delete(bookmarkDoc.ref);

                        const currentCount = postDoc.data().bookmarksCount || 0;
                        transaction.update(postRef, {
                            bookmarksCount: Math.max(0, currentCount - 1)
                        });
                    }
                });

                stats.bookmarksDeleted++;

            } catch (bookmarkError) {
                const errorMsg = `Failed to delete bookmark for post ${bookmarkDoc.id}: ${bookmarkError.message}`;
                console.error(`   ❌ ${errorMsg}`);
                stats.errors.push(errorMsg);
            }
        }

    } catch (error) {
        const errorMsg = `Failed to query user bookmarks: ${error.message}`;
        console.error(`   ❌ ${errorMsg}`);
        stats.errors.push(errorMsg);
    }
}
