import functions from 'firebase-functions';
import { db, admin } from '../utils/firebase.js';
import { throwHttpsError } from '../utils/errors.js';
import { analyzePhoto, checkSafeSearch } from '../utils/ai.js';
import { generateSearchKeywords } from '../utils/search.js';
import { COLLECTIONS, SUBCOLLECTIONS, LIMITS, POST_TYPES } from '../utils/constants.js';

export async function handleCreatePost(payload, userId) {
    const { description, type, fileUrls = [], location = null, year = [] } = payload;

    if (typeof description !== 'string' || description.trim().length === 0) {
        throwHttpsError('invalid-argument', 'Description is required and must be a non-empty string.');
    }
    if (description.trim().length > LIMITS.POST_DESCRIPTION_MAX) {
        throwHttpsError('invalid-argument', `Description cannot exceed ${LIMITS.POST_DESCRIPTION_MAX} characters.`);
    }
    if (!POST_TYPES.includes(type)) {
        throwHttpsError('invalid-argument', 'Invalid post type provided.');
    }

    if (type !== 'youtube') {
        if (!Array.isArray(fileUrls) || fileUrls.some(url => typeof url !== 'string' || url.trim().length === 0)) {
            throwHttpsError('invalid-argument', 'File URLs must be an array of non-empty strings for non-YouTube posts.');
        }
        if (fileUrls.length === 0) {
            throwHttpsError('invalid-argument', 'At least one file URL is required for this post type.');
        }
    } else {
        if (!Array.isArray(fileUrls) || fileUrls.length !== 1 || typeof fileUrls[0] !== 'string' || !fileUrls[0].includes('youtube.com')) {
            throwHttpsError('invalid-argument', 'A single valid YouTube URL is required for YouTube posts.');
        }
    }

    if (!Array.isArray(year) || year.some(y => typeof y !== 'number' || y < LIMITS.YEAR_MIN || y > LIMITS.YEAR_MAX)) {
        throwHttpsError('invalid-argument', `Years must be an array of valid numbers between ${LIMITS.YEAR_MIN} and ${LIMITS.YEAR_MAX}.`);
    }

    try {
        const result = await db.runTransaction(async (transaction) => {
            const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
            const userDoc = await transaction.get(userRef);

            if (!userDoc.exists) {
                throwHttpsError('not-found', 'User profile not found. Cannot create post.');
            }
            const userData = userDoc.data();
            const userDisplayName = userData.displayName || userDoc.id;
            const userProfilePicUrl = userData.profilePictureUrl || null;

            let AiMetadata = null;
            let safeSearchLikelihood = null;

            if (type === 'photo' || type === 'document' || type === 'item') {
                try {
                    safeSearchLikelihood = await checkSafeSearch(fileUrls[0]);

                    if (!safeSearchLikelihood.isAppropriate) {
                        throwHttpsError('invalid-argument', 'Image cannot be posted.');
                    }
                    AiMetadata = await analyzePhoto(fileUrls[0], { description, year, location });
                    console.log('Photo analyzed and moderated successfully:', AiMetadata || 'No title');
                } catch (error) {
                    if (error.code === 'invalid-argument') {
                        throw error;
                    }
                    console.warn('Photo analysis or moderation failed:', error.message);
                }
            }

            const newPostRef = db.collection(COLLECTIONS.POSTS).doc();

            const postData = {
                userId: userId,
                userDisplayName: userDisplayName,
                userProfilePicUrl: userProfilePicUrl,
                description: description.trim(),
                type: type,
                files: fileUrls,
                location: (location && typeof location._lat === 'number' && typeof location._long === 'number')
                    ? new admin.firestore.GeoPoint(location._lat, location._long)
                    : null,
                year: year.sort((a, b) => a - b),
                likesCount: 0,
                commentsCount: 0,
                bookmarksCount: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
                AiMetadata,
                safeSearch: safeSearchLikelihood,
            };

            const searchKeywords = generateSearchKeywords(postData);
            postData.searchKeywords = searchKeywords;

            console.log(`Generated ${searchKeywords.length} search keywords:`, searchKeywords.slice(0, 10));

            transaction.set(newPostRef, postData);

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
            throw error;
        }
        throwHttpsError('internal', 'Failed to create post.', error.message);
    }
}

export async function handleDeletePost(payload, userId) {
    const { postId } = payload;

    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }

    const postRef = db.collection(COLLECTIONS.POSTS).doc(postId);
    const userRef = db.collection(COLLECTIONS.USERS).doc(userId);

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

            transaction.delete(postRef);

            const likesSnapshot = await postRef.collection(SUBCOLLECTIONS.LIKES).get();
            likesSnapshot.docs.forEach(doc => {
                transaction.delete(doc.ref);
            });

            const commentsSnapshot = await postRef.collection(SUBCOLLECTIONS.COMMENTS).get();
            commentsSnapshot.docs.forEach(doc => {
                transaction.delete(doc.ref);
            });

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
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to delete post and its related data.', error.message);
    }
}

export async function handleGetPost(payload, userId) {
    const { postId } = payload;

    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }

    try {
        const postRef = db.collection(COLLECTIONS.POSTS).doc(postId);
        const postDoc = await postRef.get();

        if (!postDoc.exists) {
            throwHttpsError('not-found', 'Post not found.');
        }

        const postData = { id: postDoc.id, ...postDoc.data() };

        try {
            const likeDocRef = db.collection(COLLECTIONS.POSTS)
                .doc(postId)
                .collection(SUBCOLLECTIONS.LIKES)
                .doc(userId);
            const likeDoc = await likeDocRef.get();
            postData.likedByCurrentUser = likeDoc.exists;
        } catch (err) {
            console.error(`Error checking like status for post ${postId}:`, err);
            postData.likedByCurrentUser = false;
        }

        try {
            const bookmarkDocRef = db.collection(COLLECTIONS.USERS)
                .doc(userId)
                .collection(SUBCOLLECTIONS.BOOKMARKS)
                .doc(postId);
            const bookmarkDoc = await bookmarkDocRef.get();
            postData.bookmarkedByCurrentUser = bookmarkDoc.exists;
        } catch (err) {
            console.error(`Error checking bookmark status for post ${postId}:`, err);
            postData.bookmarkedByCurrentUser = false;
        }

        console.log(`Fetched post ${postId} for user ${userId}`);

        return {
            post: postData,
            message: 'Post fetched successfully.'
        };

    } catch (error) {
        console.error(`Error in handleGetPost for post ${postId}:`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to fetch post.', error.message);
    }
}

export async function handleLikePost(payload, userId) {
    const { postId } = payload;

    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }

    const postRef = db.collection(COLLECTIONS.POSTS).doc(postId);
    const likeRef = postRef.collection(SUBCOLLECTIONS.LIKES).doc(userId);

    try {
        const result = await db.runTransaction(async (transaction) => {
            const postDoc = await transaction.get(postRef);
            if (!postDoc.exists) {
                throwHttpsError('not-found', 'Post not found.');
            }

            const likeDoc = await transaction.get(likeRef);
            let newLikeCount = postDoc.data().likesCount || 0;
            let status;

            if (likeDoc.exists) {
                transaction.delete(likeRef);
                newLikeCount = Math.max(0, newLikeCount - 1);
                status = 'unliked';
            } else {
                transaction.set(likeRef, {
                    userId: userId,
                    createdAt: new Date(),
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
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to update like status.', error.message);
    }
}

export async function handleToggleBookmark(payload, userId) {
    const { postId } = payload;

    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }

    try {
        const result = await db.runTransaction(async (transaction) => {
            const postRef = db.collection(COLLECTIONS.POSTS).doc(postId);
            const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
            const bookmarkRef = userRef.collection(SUBCOLLECTIONS.BOOKMARKS).doc(postId);

            const postDoc = await transaction.get(postRef);
            if (!postDoc.exists) {
                throwHttpsError('not-found', 'Post not found.');
            }

            const bookmarkDoc = await transaction.get(bookmarkRef);

            let status;
            let newBookmarkCount = postDoc.data().bookmarksCount || 0;

            if (bookmarkDoc?.exists) {
                transaction.delete(bookmarkRef);
                newBookmarkCount = Math.max(0, newBookmarkCount - 1);
                status = 'unbookmarked';
            } else {
                transaction.set(bookmarkRef, {
                    postId: postId,
                    bookmarkedAt: new Date(),
                });
                newBookmarkCount += 1;
                status = 'bookmarked';
            }

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

export async function handleGetBookmarks(payload, userId) {
    const { limit = 20, lastBookmarkId = null, requestedUserId = null } = payload;

    if (typeof limit !== 'number' || limit < 1 || limit > 50) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 50.');
    }
    if (lastBookmarkId !== null && typeof lastBookmarkId !== 'string') {
        throwHttpsError('invalid-argument', 'lastBookmarkId must be a string or null.');
    }

    const targetUserId = requestedUserId || userId;
    if (targetUserId !== userId) {
        throwHttpsError('permission-denied', 'You can only access your own bookmarks.');
    }

    try {
        const userRef = db.collection(COLLECTIONS.USERS).doc(userId);

        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            throwHttpsError('not-found', 'User not found.');
        }

        let bookmarksQuery = userRef.collection(SUBCOLLECTIONS.BOOKMARKS)
            .orderBy('bookmarkedAt', 'desc');

        if (lastBookmarkId) {
            const lastBookmarkSnapshot = await userRef.collection(SUBCOLLECTIONS.BOOKMARKS).doc(lastBookmarkId).get();
            if (lastBookmarkSnapshot.exists) {
                bookmarksQuery = bookmarksQuery.startAfter(lastBookmarkSnapshot);
            } else {
                console.warn(`lastBookmarkId ${lastBookmarkId} not found, fetching from start.`);
            }
        }

        const bookmarksSnapshot = await bookmarksQuery.limit(limit + 1).get();
        const bookmarkDocs = bookmarksSnapshot.docs.slice(0, limit);
        const hasMore = bookmarksSnapshot.docs.length > limit;

        const bookmarkedPosts = await Promise.all(
            bookmarkDocs.map(async (bookmarkDoc) => {
                const bookmarkData = bookmarkDoc.data();
                const postId = bookmarkDoc.id;

                try {
                    const postDoc = await db.collection(COLLECTIONS.POSTS).doc(postId).get();

                    if (!postDoc.exists) {
                        console.warn(`Bookmarked post ${postId} no longer exists`);
                        return null;
                    }

                    const postData = { id: postDoc.id, ...postDoc.data() };
                    postData.bookmarkedAt = bookmarkData.bookmarkedAt;
                    postData.bookmarkedByCurrentUser = true;

                    try {
                        const likeDocRef = db.collection(COLLECTIONS.POSTS)
                            .doc(postId)
                            .collection(SUBCOLLECTIONS.LIKES)
                            .doc(userId);
                        const likeDoc = await likeDocRef.get();
                        postData.likedByCurrentUser = likeDoc.exists;
                    } catch (err) {
                        console.error(`Error checking like status for post ${postId}:`, err);
                        postData.likedByCurrentUser = false;
                    }

                    return postData;

                } catch (error) {
                    console.error(`Error fetching post data for bookmark ${postId}:`, error);
                    return null;
                }
            })
        );

        const validBookmarks = bookmarkedPosts.filter(post => post !== null);
        const lastVisibleDoc = bookmarkDocs.length > 0 ? bookmarkDocs[bookmarkDocs.length - 1] : null;

        console.log(`Fetched ${validBookmarks.length} bookmarked posts for user ${userId}`);

        return {
            posts: validBookmarks,
            count: validBookmarks.length,
            hasMore: hasMore,
            lastDocId: lastVisibleDoc ? lastVisibleDoc.id : null,
            userId: userId,
            message: 'Bookmarked posts fetched successfully.'
        };

    } catch (error) {
        console.error(`Error in handleGetBookmarks for user ${userId}:`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to fetch bookmarked posts.', error.message);
    }
}

export async function handleAddComment(payload, userId) {
    const { postId, text } = payload;

    if (!postId || typeof postId !== 'string') {
        throwHttpsError('invalid-argument', 'A valid postId is required.');
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        throwHttpsError('invalid-argument', 'Comment text is required and must be a non-empty string.');
    }
    if (text.trim().length > 1000) {
        throwHttpsError('invalid-argument', 'Comment text cannot exceed 1000 characters.');
    }

    const postRef = db.collection(COLLECTIONS.POSTS).doc(postId);
    const commentsRef = postRef.collection(SUBCOLLECTIONS.COMMENTS);

    try {
        const result = await db.runTransaction(async (transaction) => {
            const postDoc = await transaction.get(postRef);
            if (!postDoc.exists) {
                throwHttpsError('not-found', 'Post not found.');
            }

            const userDoc = await transaction.get(db.collection(COLLECTIONS.USERS).doc(userId));
            const userData = userDoc.exists ? userDoc.data() : {};
            const userDisplayName = userData.displayName || `User_${userId.substring(0, 8)}`;
            const userProfilePicUrl = userData.profilePictureUrl || null;

            const newCommentRef = commentsRef.doc();
            const commentData = {
                userId: userId,
                userDisplayName: userDisplayName,
                userProfilePicUrl: userProfilePicUrl,
                text: text.trim(),
                createdAt: new Date(),
            };

            transaction.set(newCommentRef, commentData);

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

export async function handleGetComments(payload, userId) {
    const { postId, limit = 200, lastCommentId = null } = payload;

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
        const postRef = db.collection(COLLECTIONS.POSTS).doc(postId);
        const postDoc = await postRef.get();
        if (!postDoc.exists) {
            throwHttpsError('not-found', 'Post not found.');
        }

        let commentsQuery = postRef.collection(SUBCOLLECTIONS.COMMENTS)
            .orderBy('createdAt', 'desc');

        if (lastCommentId) {
            const lastCommentSnapshot = await postRef.collection(SUBCOLLECTIONS.COMMENTS).doc(lastCommentId).get();
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
