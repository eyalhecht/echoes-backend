/**
 * Archivist Agent Engine
 *
 * Shared engine that any persona config plugs into.
 * Exports `runArchivist(persona)` — creates a LangChain agent that browses
 * Wikimedia Commons, evaluates photos, and creates posts in Echoes.
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { createAgent, tool } from 'langchain';
import { z } from 'zod';
import { db, admin } from '../utils/firebase.js';
import { openaiApiKey, analyzePhoto } from '../utils/ai.js';
import { generateSearchKeywords } from '../utils/search.js';
import { AI_CONFIG } from '../utils/constants.js';
import {
    downloadImageBuffer,
    uploadToStorage,
    deleteFromStorage,
    extractYears,
    checkAlreadyImported,
    retryWithBackoff,
} from '../scripts/importUtils.js';
import {
    browseCategoryLight,
    fetchSubcategories,
} from '../scripts/wikimediaApi.js';

// --- Constants ---
const BUCKET = 'echoes-677.firebasestorage.app';

const BAD_CONTENT_TERMS = [
    'sign', 'map', 'plaque', 'document', 'menu', 'notice board', 'information board',
    'signage', 'diagram', 'chart', 'text panel', 'poster', 'tourist sign', 'notice',
    'label', 'inscription', 'wall text', 'interpretive panel',
];

// --- Helpers ---

async function ensurePersonaUser(persona) {
    const userRef = db.collection('users').doc(persona.id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
        await userRef.set({
            userId: persona.id,
            displayName: persona.displayName,
            profilePictureUrl: persona.profilePictureUrl || null,
            bio: persona.bio,
            postsCount: 0,
            followersCount: 0,
            followingCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[archivist] Created persona user: ${persona.id}`);
    }
}

function isGoodContent(aiResult) {
    if (aiResult.location_confidence === 'unknown') return false;

    const allTerms = [
        ...(aiResult.tags || []),
        ...(aiResult.subject_terms || []),
    ].map(t => t.toLowerCase());

    return !BAD_CONTENT_TERMS.some(bad => allTerms.some(term => term.includes(bad)));
}

function buildAttributionFooter(meta) {
    const parts = ['Source: Wikimedia Commons'];
    if (meta.license) parts.push(`License: ${meta.license}`);
    if (meta.artist) parts.push(`Author: ${meta.artist}`);
    if (meta.title) parts.push(`File: ${meta.title}`);
    return parts.join(' | ');
}

// --- Tool factories ---

function createTools(persona) {
    const exploredCategories = new Set();

    // In-memory cache of browsed image metadata so viewImage can look them up
    const imageCache = new Map();

    const browseCategoryTool = tool(
        async ({ category }) => {
            try {
                if (exploredCategories.has(category)) {
                    return `Already browsed "${category}" this session. Try a different one.`;
                }
                exploredCategories.add(category);

                const images = await retryWithBackoff(() => browseCategoryLight(category, 20));

                // Filter by era
                const [minYear, maxYear] = persona.era;
                const filtered = images.filter(img => {
                    const years = extractYears(img, null);
                    if (years.length === 0) return true; // can't determine, allow through
                    return years.some(y => y >= minYear && y <= maxYear);
                });

                // Cache for later viewImage lookups
                for (const img of filtered) {
                    imageCache.set(img.title, img);
                }

                if (filtered.length === 0) {
                    return `No images found in "${category}" matching era ${minYear}–${maxYear}.`;
                }

                const summaries = filtered.map(img => ({
                    title: img.title,
                    hasGeo: img.lat !== null,
                    date: img.dateTimeOriginal || 'unknown',
                    description: (img.description || '').substring(0, 100),
                }));

                return JSON.stringify({ category, imageCount: filtered.length, images: summaries });
            } catch (error) {
                return `Error browsing "${category}": ${error.message}`;
            }
        },
        {
            name: 'browseCategory',
            description: 'Browse a Wikimedia Commons category to see available images. Returns a list of image titles, dates, and whether they have geolocation. Use this to find candidates before deciding what to post.',
            schema: z.object({
                category: z.string().describe('Wikimedia Commons category name (without "Category:" prefix)'),
            }),
        }
    );

    const browseSubcategoriesTool = tool(
        async ({ category }) => {
            try {
                const subcats = await retryWithBackoff(() => fetchSubcategories(category));
                if (subcats.length === 0) {
                    return `No subcategories found for "${category}".`;
                }
                return JSON.stringify({ category, subcategories: subcats });
            } catch (error) {
                return `Error fetching subcategories for "${category}": ${error.message}`;
            }
        },
        {
            name: 'browseSubcategories',
            description: 'Discover subcategories within a Wikimedia Commons category. Use this to find more specific or interesting collections to browse.',
            schema: z.object({
                category: z.string().describe('Wikimedia Commons category name (without "Category:" prefix)'),
            }),
        }
    );

    const viewImageTool = tool(
        async ({ title }) => {
            const meta = imageCache.get(title);
            if (!meta) {
                return `Image "${title}" not found. Browse a category first.`;
            }
            return JSON.stringify({
                title: meta.title,
                url: meta.url,
                description: meta.description,
                date: meta.dateTimeOriginal || 'unknown',
                hasGeo: meta.lat !== null,
                lat: meta.lat,
                lng: meta.lng,
                license: meta.license,
                artist: meta.artist,
                dimensions: `${meta.width}x${meta.height}`,
            });
        },
        {
            name: 'viewImage',
            description: 'Get detailed metadata for a specific image you found while browsing. Use this to evaluate whether an image is worth posting — check its description, date, location, and quality.',
            schema: z.object({
                title: z.string().describe('Exact title of the image as returned by browseCategory'),
            }),
        }
    );

    const createPostTool = tool(
        async ({ title, description }) => {
            const meta = imageCache.get(title);
            if (!meta) {
                return `Image "${title}" not found in cache. Browse a category first.`;
            }

            try {
                // Deduplication check
                const alreadyExists = await checkAlreadyImported(db, meta.title, persona.id);
                if (alreadyExists) {
                    return `Skipped — "${title}" was already posted.`;
                }

                // Download
                const imageBuffer = await retryWithBackoff(() => downloadImageBuffer(meta.url));
                console.log(`[archivist] Downloaded: ${title} (${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

                // Upload to Storage
                const storageUrl = await retryWithBackoff(() =>
                    uploadToStorage(imageBuffer, meta.title, meta.mime, persona.id, BUCKET)
                );
                console.log(`[archivist] Uploaded: ${title}`);

                // AI analysis
                let aiResult = null;
                try {
                    const userContext = {
                        description: meta.description || undefined,
                        year: extractYears(meta, null),
                        location: meta.lat !== null ? { _lat: meta.lat, _long: meta.lng } : undefined,
                    };
                    aiResult = await analyzePhoto(storageUrl, userContext);
                    console.log(`[archivist] AI analysis complete: ${title}`);
                } catch (err) {
                    console.error(`[archivist] AI analysis failed for ${title}: ${err.message}`);
                    // Continue without AI metadata — the agent's description is still valuable
                }

                // Content filter (only if AI data available)
                if (aiResult && !isGoodContent(aiResult)) {
                    await deleteFromStorage(storageUrl, BUCKET).catch(() => {});
                    return `Skipped — "${title}" didn't pass content filter (sign/map/document or unknown location).`;
                }

                // Build post
                const years = extractYears(meta, aiResult);
                const location = (meta.lat !== null && meta.lng !== null)
                    ? new admin.firestore.GeoPoint(meta.lat, meta.lng)
                    : null;

                const attribution = buildAttributionFooter(meta);
                const fullDescription = `${description}\n\n${attribution}`;

                const postData = {
                    userId: persona.id,
                    userDisplayName: persona.displayName,
                    userProfilePicUrl: persona.profilePictureUrl || null,
                    description: fullDescription.substring(0, 5000),
                    type: 'photo',
                    files: [storageUrl],
                    location,
                    year: years,
                    AiMetadata: aiResult,
                    safeSearch: null,
                    wikimediaTitle: meta.title,
                    likesCount: 0,
                    commentsCount: 0,
                    bookmarksCount: 0,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                };

                // Search keywords
                const baseKeywords = generateSearchKeywords({ ...postData, tags: aiResult?.tags || [] });
                postData.searchKeywords = [...new Set([...baseKeywords, 'wikimedia commons'])].sort();

                // Write to Firestore
                await retryWithBackoff(async () => {
                    await db.runTransaction(async (tx) => {
                        const postRef = db.collection('posts').doc();
                        const userRef = db.collection('users').doc(persona.id);
                        tx.set(postRef, postData);
                        tx.update(userRef, {
                            postsCount: admin.firestore.FieldValue.increment(1),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                        console.log(`[archivist] Post created: posts/${postRef.id} — "${title}"`);
                    });
                });

                return `Successfully posted "${title}".`;
            } catch (error) {
                console.error(`[archivist] Failed to create post for ${title}: ${error.message}`);
                return `Failed to post "${title}": ${error.message}`;
            }
        },
        {
            name: 'createPost',
            description: 'Download, analyze, and publish a photo as a post. Provide the image title (from browseCategory) and your curator description. The attribution footer is added automatically.',
            schema: z.object({
                title: z.string().describe('Exact title of the image as returned by browseCategory'),
                description: z.string().describe('Your curator description for this photo — short, evocative, in your voice'),
            }),
        }
    );

    const getRecentPostsTool = tool(
        async ({ limit }) => {
            try {
                const snapshot = await db
                    .collection('posts')
                    .where('userId', '==', persona.id)
                    .orderBy('createdAt', 'desc')
                    .limit(limit)
                    .get();

                if (snapshot.empty) {
                    return 'No previous posts found. This is your first session!';
                }

                const posts = snapshot.docs.map(doc => {
                    const d = doc.data();
                    return {
                        title: d.wikimediaTitle || 'untitled',
                        description: (d.description || '').substring(0, 100),
                        year: d.year,
                    };
                });

                return JSON.stringify({ recentPosts: posts });
            } catch (error) {
                return `Error fetching recent posts: ${error.message}`;
            }
        },
        {
            name: 'getRecentPosts',
            description: 'See your most recent posts to avoid posting duplicates and to vary your selections. Call this at the start of each session.',
            schema: z.object({
                limit: z.number().describe('Number of recent posts to retrieve (e.g. 10)'),
            }),
        }
    );

    return [browseCategoryTool, browseSubcategoriesTool, viewImageTool, createPostTool, getRecentPostsTool];
}

// --- System prompt ---

function buildSystemPrompt(persona) {
    return `You are ${persona.displayName} — an AI archivist for the Echoes photo sharing platform. You browse Wikimedia Commons to discover and share compelling photographs.

## Your taste
${persona.taste}

## Your voice
${persona.voice}

## Constraints
- Only post photos from the era ${persona.era[0]}–${persona.era[1]}
- Post between ${persona.postsPerRun[0]} and ${persona.postsPerRun[1]} photos this session
- ${persona.preferGeo ? 'Prefer geo-tagged images when possible, but don\'t reject great photos just because they lack coordinates' : 'Geolocation is not required'}
- Always check getRecentPosts first to see what you've already shared — don't repeat yourself
- Don't browse the same category twice in one session
- Quality over quantity — be selective, not every photo is worth sharing
- When you write a description, do NOT include attribution info — it's added automatically as a footer

## Workflow
1. Call getRecentPosts to see what you've posted recently
2. Pick a category from your list to explore (or use browseSubcategories to discover deeper collections)
3. Browse it, review the candidates using viewImage
4. For the best finds, call createPost with your description
5. Try different categories for variety
6. Stop when you've posted ${persona.postsPerRun[0]}–${persona.postsPerRun[1]} photos`;
}

// --- Main entry point ---

export async function runArchivist(persona) {
    console.log(`\n[archivist] Starting session for: ${persona.displayName}`);
    console.log(`[archivist] Era: ${persona.era[0]}–${persona.era[1]}`);
    console.log(`[archivist] Posts per run: ${persona.postsPerRun[0]}–${persona.postsPerRun[1]}`);

    await ensurePersonaUser(persona);

    const model = new ChatOpenAI({
        model: AI_CONFIG.MODEL,
        temperature: 0.7,
        apiKey: openaiApiKey.value(),
    });

    const tools = createTools(persona);
    const systemPrompt = buildSystemPrompt(persona);

    const agent = createAgent({
        model,
        tools,
        systemPrompt,
    });

    const categoryList = persona.categories.join(', ');

    const result = await agent.invoke({
        messages: [
            new HumanMessage({
                content: `Start your session. Your categories to explore: ${categoryList}. Find and share ${persona.postsPerRun[0]}–${persona.postsPerRun[1]} great photos. Pick categories that feel right today — you don't need to use all of them.`,
            }),
        ],
    });

    const finalMessage = result.messages?.[result.messages.length - 1]?.content || 'Session complete.';
    console.log(`\n[archivist] Session summary: ${finalMessage}`);

    return { persona: persona.id, summary: finalMessage };
}
