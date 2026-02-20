import { GeoPoint } from 'firebase-admin/firestore';
import functions from 'firebase-functions';
import { db } from '../utils/firebase.js';
import { throwHttpsError } from '../utils/errors.js';
import { calculateRelevanceScore } from '../utils/search.js';
import { COLLECTIONS, SUBCOLLECTIONS, LIMITS, DEFAULTS } from '../utils/constants.js';

export async function handleGetFeed(payload, userId) {
    const { limit = DEFAULTS.FEED_LIMIT, lastPostId = null, feedType = 'recent' } = payload;
    const POST_LIMIT = limit;

    if (typeof limit !== 'number' || limit < 1 || limit > LIMITS.FEED_LIMIT_MAX) {
        throwHttpsError('invalid-argument', `Limit must be a number between 1 and ${LIMITS.FEED_LIMIT_MAX}.`);
    }
    if (lastPostId !== null && typeof lastPostId !== 'string') {
        throwHttpsError('invalid-argument', 'lastPostId must be a string or null.');
    }
    if (!['recent', 'following'].includes(feedType)) {
        throwHttpsError('invalid-argument', 'feedType must be either "recent" or "following".');
    }

    try {
        let postDocs = [];
        let hasMore = false;

        if (feedType === 'following') {
            const followingSnapshot = await db.collection(COLLECTIONS.USERS)
                .doc(userId)
                .collection('following')
                .get();

            const followingUserIds = followingSnapshot.docs.map(doc => doc.id);

            if (followingUserIds.length === 0) {
                console.log(`User ${userId} doesn't follow anyone. Returning empty feed.`);
                return {
                    posts: [],
                    lastDocId: null,
                    hasMore: false,
                    message: 'Feed fetched successfully.',
                };
            }

            const BATCH_SIZE = 30;
            let allPosts = [];

            for (let i = 0; i < followingUserIds.length; i += BATCH_SIZE) {
                const batch = followingUserIds.slice(i, i + BATCH_SIZE);

                let postsQuery = db.collection(COLLECTIONS.POSTS)
                    .where('userId', 'in', batch)
                    .orderBy('createdAt', 'desc');

                if (lastPostId && i === 0) {
                    const lastPostSnapshot = await db.collection(COLLECTIONS.POSTS).doc(lastPostId).get();
                    if (lastPostSnapshot.exists) {
                        postsQuery = postsQuery.startAfter(lastPostSnapshot);
                    } else {
                        console.warn(`lastPostId ${lastPostId} not found, fetching from start.`);
                    }
                }

                const postsSnapshot = await postsQuery.limit(POST_LIMIT + 1).get();
                allPosts.push(...postsSnapshot.docs);
            }
            allPosts.sort((a, b) => b.data().createdAt - a.data().createdAt);
            hasMore = allPosts.length > POST_LIMIT;
            postDocs = allPosts.slice(0, POST_LIMIT);

        } else {
            let postsQuery = db.collection(COLLECTIONS.POSTS)
                .orderBy('createdAt', 'desc');

            if (lastPostId) {
                const lastPostSnapshot = await db.collection(COLLECTIONS.POSTS).doc(lastPostId).get();
                if (lastPostSnapshot.exists) {
                    postsQuery = postsQuery.startAfter(lastPostSnapshot);
                } else {
                    console.warn(`lastPostId ${lastPostId} not found, fetching from start.`);
                }
            }

            const postsSnapshot = await postsQuery.limit(POST_LIMIT + 1).get();
            hasMore = postsSnapshot.docs.length > POST_LIMIT;
            postDocs = postsSnapshot.docs.slice(0, POST_LIMIT);
        }

        const fetchedPosts = await Promise.all(postDocs.map(async (doc) => {
            const postData = { id: doc.id, ...doc.data() };
            try {
                const likeDocRef = db.collection(COLLECTIONS.POSTS)
                    .doc(doc.id)
                    .collection(SUBCOLLECTIONS.LIKES)
                    .doc(userId);
                const likeDoc = await likeDocRef.get();
                postData.likedByCurrentUser = likeDoc.exists;

                const bookmarkDocRef = db.collection(COLLECTIONS.USERS)
                    .doc(userId)
                    .collection(SUBCOLLECTIONS.BOOKMARKS)
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

        const lastVisibleDoc = postDocs.length > 0 ? postDocs[postDocs.length - 1] : null;

        console.log(`Fetched ${fetchedPosts.length} posts for user ${userId} (feedType: ${feedType}), hasMore: ${hasMore}`);

        return {
            posts: fetchedPosts,
            lastDocId: lastVisibleDoc ? lastVisibleDoc.id : null,
            hasMore: hasMore,
            feedType: feedType,
            message: 'Feed fetched successfully.',
        };
    } catch (error) {
        console.error('Error in handleGetFeed:', error);
        throwHttpsError('internal', 'Failed to fetch feed.', error.message);
    }
}

export async function handleGetTrending(payload, userId) {
    const { limit = 20, timeframe = '7d' } = payload;

    if (typeof limit !== 'number' || limit < 1 || limit > 50) {
        throwHttpsError('invalid-argument', 'Limit must be a number between 1 and 50.');
    }
    if (!['1d', '7d', '30d'].includes(timeframe)) {
        throwHttpsError('invalid-argument', 'Timeframe must be one of: 1d, 7d, 30d.');
    }

    try {
        const daysBack = timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : 30;
        const threshold = new Date();
        threshold.setDate(threshold.getDate() - daysBack);

        console.log(`Fetching trending posts from last ${daysBack} days for user ${userId}`);

        const postsQuery = db.collection(COLLECTIONS.POSTS)
            .where('createdAt', '>=', threshold)
            .orderBy('createdAt', 'desc')
            .limit(limit * 3);

        const snapshot = await postsQuery.get();

        if (snapshot.empty) {
            return {
                posts: [],
                timeframe,
                count: 0,
                message: 'No trending posts found for the specified timeframe.'
            };
        }

        const postsWithScores = snapshot.docs.map(doc => {
            const postData = { id: doc.id, ...doc.data() };

            const likesWeight = 2;
            const commentsWeight = 3;
            const bookmarksWeight = 4;
            const aiQualityBonus = postData.AiMetadata ? 5 : 0;

            const engagementScore =
                (postData.likesCount || 0) * likesWeight +
                (postData.commentsCount || 0) * commentsWeight +
                (postData.bookmarksCount || 0) * bookmarksWeight +
                aiQualityBonus;

            const ageInHours = (Date.now() - postData.createdAt.toDate().getTime()) / (1000 * 60 * 60);
            const maxAgeHours = daysBack * 24;
            const recencyWeight = Math.max(0.5, 1 - (ageInHours / maxAgeHours) * 0.5);

            const trendingScore = engagementScore * recencyWeight;

            return {
                ...postData,
                engagementScore,
                trendingScore,
                recencyWeight
            };
        });

        const trendingPosts = postsWithScores
            .sort((a, b) => b.trendingScore - a.trendingScore)
            .slice(0, limit);

        const enrichedPosts = await Promise.all(
            trendingPosts.map(async (post) => {
                try {
                    const likeDocRef = db.collection(COLLECTIONS.POSTS)
                        .doc(post.id)
                        .collection(SUBCOLLECTIONS.LIKES)
                        .doc(userId);
                    const likeDoc = await likeDocRef.get();
                    post.likedByCurrentUser = likeDoc.exists;

                    const bookmarkDocRef = db.collection(COLLECTIONS.USERS)
                        .doc(userId)
                        .collection(SUBCOLLECTIONS.BOOKMARKS)
                        .doc(post.id);
                    const bookmarkDoc = await bookmarkDocRef.get();
                    post.bookmarkedByCurrentUser = bookmarkDoc.exists;

                    delete post.engagementScore;
                    delete post.recencyWeight;

                } catch (err) {
                    console.error(`Error checking interactions for trending post ${post.id}:`, err);
                    post.likedByCurrentUser = false;
                    post.bookmarkedByCurrentUser = false;
                }
                return post;
            })
        );

        console.log(`Fetched ${enrichedPosts.length} trending posts for timeframe ${timeframe}`);

        return {
            posts: enrichedPosts,
            timeframe,
            count: enrichedPosts.length,
            threshold: threshold.toISOString(),
            message: 'Trending posts fetched successfully.'
        };

    } catch (error) {
        console.error(`Error in handleGetTrending for timeframe ${timeframe}:`, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throwHttpsError('internal', 'Failed to fetch trending posts.', error.message);
    }
}

export async function handleSearchPosts(payload, userId) {
    const { query, limit = 20, lastPostId = null } = payload;

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
        const searchTerms = query
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 1)
            .slice(0, 10);

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

        let postsQuery = db.collection(COLLECTIONS.POSTS)
            .where('searchKeywords', 'array-contains-any', searchTerms)
            .orderBy('createdAt', 'desc');

        if (lastPostId) {
            const lastPostSnapshot = await db.collection(COLLECTIONS.POSTS).doc(lastPostId).get();
            if (lastPostSnapshot.exists) {
                postsQuery = postsQuery.startAfter(lastPostSnapshot);
            }
        }

        const querySnapshot = await postsQuery.limit(limit * 3).get();

        const filteredPosts = [];

        querySnapshot.docs.forEach(doc => {
            const postData = doc.data();
            const postKeywords = postData.searchKeywords || [];

            const hasAllTerms = searchTerms.every(term =>
                postKeywords.some(keyword => keyword.includes(term))
            );

            if (hasAllTerms && filteredPosts.length < limit) {
                filteredPosts.push({
                    id: doc.id,
                    ...postData,
                    matchedTerms: searchTerms.filter(term =>
                        postKeywords.some(keyword => keyword.includes(term))
                    ),
                    relevanceScore: calculateRelevanceScore(postData, searchTerms)
                });
            }
        });

        filteredPosts.sort((a, b) => b.relevanceScore - a.relevanceScore);

        const enrichedPosts = await Promise.all(
            filteredPosts.map(async (post) => {
                try {
                    const likeDocRef = db.collection(COLLECTIONS.POSTS)
                        .doc(post.id)
                        .collection(SUBCOLLECTIONS.LIKES)
                        .doc(userId);
                    const likeDoc = await likeDocRef.get();
                    post.likedByCurrentUser = likeDoc.exists;

                    const bookmarkDocRef = db.collection(COLLECTIONS.USERS)
                        .doc(userId)
                        .collection(SUBCOLLECTIONS.BOOKMARKS)
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

export async function handleGetPostsByLocation(payload, userId) {
    const { center, radiusKm = 10, limit = 50 } = payload;

    if (!center || typeof center.lat !== 'number' || typeof center.lng !== 'number') {
        throwHttpsError('invalid-argument', 'Valid center coordinates (lat, lng) are required.');
    }
    if (typeof radiusKm !== 'number' || radiusKm < 0.1 || radiusKm > 500) {
        throwHttpsError('invalid-argument', 'Radius must be between 0.1 and 500 kilometers.');
    }
    if (typeof limit !== 'number' || limit < 1 || limit > 100) {
        throwHttpsError('invalid-argument', 'Limit must be between 1 and 100.');
    }

    try {
        const latDelta = radiusKm / 111;
        const lngDelta = radiusKm / (111 * Math.cos(center.lat * Math.PI / 180));

        const northEast = new GeoPoint(center.lat + latDelta, center.lng + lngDelta);
        const southWest = new GeoPoint(center.lat - latDelta, center.lng - lngDelta);

        let postsQuery = db.collection(COLLECTIONS.POSTS)
            .where('location', '>=', southWest)
            .where('location', '<=', northEast)
            .orderBy('location')
            .limit(limit * 2);

        const postsSnapshot = await postsQuery.get();

        const calculateDistance = (lat1, lng1, lat2, lng2) => {
            const R = 6371;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLng = (lng2 - lng1) * Math.PI / 180;
            const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng/2) * Math.sin(dLng/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            return R * c;
        };

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
                .slice(0, limit)
                .map(async (post) => {
                    try {
                        const likeDocRef = db.collection(COLLECTIONS.POSTS)
                            .doc(post.id)
                            .collection('likes')
                            .doc(userId);
                        const likeDoc = await likeDocRef.get();
                        post.likedByCurrentUser = likeDoc.exists;

                        const bookmarkDocRef = db.collection(COLLECTIONS.USERS)
                            .doc(userId)
                            .collection('bookmarks')
                            .doc(post.id);
                        const bookmarkDoc = await bookmarkDocRef.get();
                        post.bookmarkedByCurrentUser = bookmarkDoc.exists;

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
