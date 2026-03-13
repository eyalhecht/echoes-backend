#!/usr/bin/env node
/**
 * Wikimedia Commons → Echoes import pipeline.
 *
 * Usage:
 *   node functions/scripts/importWikimedia.js [options]
 *
 * Options:
 *   --category <name>   Wikimedia Commons category (default: New_York_City_in_the_1900s)
 *   --limit <n>         Max photos to import (default: 100)
 *
 * Always runs against dev project: echoes-677
 */

import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, mkdir } from 'fs/promises';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local from the functions directory before anything reads process.env
dotenv.config({ path: resolve(__dirname, '../.env.local') });

// --- CLI argument parsing ---
function parseArgs(argv) {
    const args = {
        category: 'New_York_City_in_the_1900s',
        limit: 100,
        bucket: 'echoes-677.firebasestorage.app',
        project: 'echoes-677',
        tags: [],
        requireGeo: true,
        noAi: false,
        preview: false,
    };

    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--category':    args.category = argv[++i]; break;
            case '--limit':       args.limit = parseInt(argv[++i], 10); break;
            case '--tags':        args.tags = argv[++i].split(',').map(t => t.trim().toLowerCase()); break;
            case '--require-geo':    args.requireGeo = true; break;
            case '--no-require-geo': args.requireGeo = false; break;
            case '--no-ai':          args.noAi = true; break;
            case '--preview':        args.preview = true; break;
        }
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));

// --- Firebase Admin init ---
import admin from 'firebase-admin';

admin.initializeApp({ projectId: args.project });
const db = admin.firestore();

// --- Project imports (after admin init) ---
import { analyzePhoto } from '../utils/ai.js';
import { generateSearchKeywords } from '../utils/search.js';
import { fetchImagesFromCategory } from './wikimediaApi.js';
import {
    buildDescription,
    extractYears,
    downloadImageBuffer,
    uploadToStorage,
    deleteFromStorage,
    checkAlreadyImported,
    sleep,
    retryWithBackoff,
} from './importUtils.js';

// --- Constants ---
const CURATOR_USER_ID = 'wikimedia-curator';
const CURATOR_DISPLAY_NAME = 'Echoes Archive';
const EXTRA_KEYWORDS = ['wikimedia commons', ...args.tags];
const DELAY_BETWEEN_PHOTOS_MS = 3000;

// --- Curator user setup ---
async function ensureCuratorUser() {
    const userRef = db.collection('users').doc(CURATOR_USER_ID);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
        await userRef.set({
            userId: CURATOR_USER_ID,
            displayName: CURATOR_DISPLAY_NAME,
            profilePictureUrl: null,
            bio: 'Historical photos sourced from Wikimedia Commons and enriched with AI analysis.',
            postsCount: 0,
            followersCount: 0,
            followingCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[setup] Created curator user: ${CURATOR_USER_ID}`);
    } else {
        console.log(`[setup] Curator user already exists: ${CURATOR_USER_ID}`);
    }
}

// --- Content quality filters (uses existing AI data, no extra API calls) ---
const BAD_CONTENT_TERMS = [
    'sign', 'map', 'plaque', 'document', 'menu', 'notice board', 'information board',
    'signage', 'diagram', 'chart', 'text panel', 'poster', 'tourist sign', 'notice',
    'label', 'inscription', 'wall text', 'interpretive panel',
];

function isGoodContent(aiResult) {
    // Reject if AI couldn't identify where the photo was taken
    if (aiResult.location_confidence === 'unknown') return false;

    // Reject if the subject is primarily a sign, map, or document
    const allTerms = [
        ...(aiResult.tags || []),
        ...(aiResult.subject_terms || []),
    ].map(t => t.toLowerCase());

    return !BAD_CONTENT_TERMS.some(bad => allTerms.some(term => term.includes(bad)));
}

function isWithinYearLimit(years, maxYear) {
    // If no years detected, allow through (we can't be sure)
    if (!years.length) return true;
    // Reject only if ALL detected years are after the limit
    return Math.min(...years) <= maxYear;
}

// --- Location resolution ---
function resolveLocation(meta) {
    if (meta.lat !== null && meta.lng !== null) {
        return new admin.firestore.GeoPoint(meta.lat, meta.lng);
    }
    return null;
}

// --- Progress logger ---
function log(index, total, filename, message) {
    console.log(`[${index}/${total}] ${filename ? filename + ': ' : ''}${message}`);
}

// --- Interactive preview ---
async function promptPreview(meta, imageBuffer) {
    // Write to a temp file and open it
    const ext = meta.mime === 'image/png' ? '.png' : '.jpg';
    const tmpDir = resolve(__dirname, '../../imports/.preview');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = resolve(tmpDir, `preview${ext}`);
    await writeFile(tmpPath, imageBuffer);

    const { exec } = await import('child_process');
    exec(`start "" "${tmpPath}"`); // Windows: opens in default image viewer

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r => rl.question('  → Import this image? [Y/n/q] ', r));
    rl.close();

    const a = answer.trim().toLowerCase();
    if (a === 'q') return 'quit';
    if (a === 'n') return 'skip';
    return 'yes';
}

// --- Main import loop ---
async function runImport() {
    const { category, limit, bucket } = args;

    console.log(`\nEchoes — Wikimedia Commons Import`);
    console.log(`  Category : ${category}`);
    console.log(`  Limit    : ${limit}`);
    console.log(`  Bucket   : ${bucket}\n`);

    await ensureCuratorUser();

    console.log(`[1/${limit}] Querying Wikimedia Commons: Category:${category}`);
    const overFetchMultiplier = args.requireGeo ? 8 : 3;
    const images = await retryWithBackoff(() => fetchImagesFromCategory(category, limit, overFetchMultiplier));
    const total = images.length;
    console.log(`[1/${limit}] Found ${total} valid images to process\n`);

    const summary = {
        category,
        limit,
        total,
        imported: 0,
        skipped: { duplicate: 0, inappropriate: 0, tooSmall: 0, noLicense: 0, downloadError: 0, aiError: 0, writeError: 0 },
        errors: [],
        startedAt: new Date().toISOString(),
        completedAt: null,
    };

    for (let i = 0; i < images.length; i++) {
        const meta = images[i];
        const idx = i + 1;

        console.log(`[${idx}/${total}] Processing: ${meta.title}`);

        // --- Geo filter ---
        if (args.requireGeo && (meta.lat === null || meta.lng === null)) {
            log(idx, total, null, '→ Skipped (no geolocation)');
            summary.skipped.noLicense++;
            continue;
        }

        // --- Resumability: skip already-imported photos ---
        try {
            const alreadyDone = await checkAlreadyImported(db, meta.title);
            if (alreadyDone) {
                log(idx, total, null, '→ Skipped (already imported)');
                summary.skipped.duplicate++;
                continue;
            }
        } catch (err) {
            log(idx, total, null, `→ Deduplication check failed: ${err.message}`);
        }

        // --- Download image ---
        let imageBuffer;
        try {
            imageBuffer = await retryWithBackoff(() => downloadImageBuffer(meta.url));
            log(idx, total, null, `→ Downloaded (${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
        } catch (err) {
            log(idx, total, null, `→ SKIP — download failed: ${err.message}`);
            summary.skipped.downloadError++;
            summary.errors.push({ title: meta.title, stage: 'download', error: err.message });
            continue;
        }

        // --- Preview (when --preview is set) ---
        if (args.preview) {
            const decision = await promptPreview(meta, imageBuffer);
            if (decision === 'quit') {
                log(idx, total, null, '→ Quitting (user requested)');
                break;
            }
            if (decision === 'skip') {
                log(idx, total, null, '→ Skipped (user rejected)');
                summary.skipped.inappropriate++;
                continue;
            }
        }

        // --- Upload to Firebase Storage ---
        let storageUrl;
        try {
            storageUrl = await retryWithBackoff(() =>
                uploadToStorage(imageBuffer, meta.title, meta.mime, CURATOR_USER_ID, bucket)
            );
            log(idx, total, null, `→ Uploaded to Storage: ${storageUrl.split('/').slice(-2).join('/')}`);
        } catch (err) {
            log(idx, total, null, `→ SKIP — storage upload failed: ${err.message}`);
            summary.skipped.downloadError++;
            summary.errors.push({ title: meta.title, stage: 'upload', error: err.message });
            continue;
        }

        // --- AI analysis (skipped when --no-ai) ---
        let aiResult = null;
        if (!args.noAi) {
            try {
                const userContext = {
                    description: meta.description || undefined,
                    year: extractYears(meta, null),
                    location: meta.lat !== null ? { _lat: meta.lat, _long: meta.lng } : undefined,
                };
                aiResult = await analyzePhoto(storageUrl, userContext);
                log(idx, total, null, `→ AI Analysis: "${aiResult.description?.substring(0, 80)}..." (date confidence: ${aiResult.date_confidence})`);
            } catch (err) {
                log(idx, total, null, `→ SKIP — AI analysis failed: ${err.message}`);
                summary.skipped.aiError++;
                summary.errors.push({ title: meta.title, stage: 'ai', error: err.message });
                await deleteFromStorage(storageUrl, bucket).catch(() => {});
                continue;
            }
        }

        // --- Year / content filters (only when AI data available) ---
        const years = extractYears(meta, aiResult);

        if (aiResult) {
            if (!isWithinYearLimit(years, 2001)) {
                log(idx, total, null, `→ SKIP — too recent (years: ${years.join(', ')})`);
                summary.skipped.inappropriate++;
                await deleteFromStorage(storageUrl, bucket).catch(() => {});
                continue;
            }

            if (!isGoodContent(aiResult)) {
                log(idx, total, null, `→ SKIP — poor content (sign/map/document or unknown location)`);
                summary.skipped.inappropriate++;
                await deleteFromStorage(storageUrl, bucket).catch(() => {});
                continue;
            }
        }

        // --- Build post document ---
        const location = resolveLocation(meta);
        const description = buildDescription(meta);

        const postData = {
            userId: CURATOR_USER_ID,
            userDisplayName: CURATOR_DISPLAY_NAME,
            userProfilePicUrl: null,
            description,
            type: 'photo',
            files: [storageUrl],
            location,
            year: years,
            AiMetadata: aiResult,
            safeSearch: null,
            wikimediaTitle: meta.title, // for deduplication
            likesCount: 0,
            commentsCount: 0,
            bookmarksCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Generate search keywords and merge extra ones
        const baseKeywords = generateSearchKeywords({ ...postData, tags: aiResult?.tags || [] });
        postData.searchKeywords = [...new Set([...baseKeywords, ...EXTRA_KEYWORDS])].sort();

        if (years.length > 0) {
            log(idx, total, null, `→ Year: [${years.join(', ')}]`);
        }
        log(idx, total, null, `→ Location: ${location ? `GeoPoint(${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)})` : 'null'}`);

        // --- Write to Firestore with curator postsCount increment ---
        try {
            await retryWithBackoff(async () => {
                await db.runTransaction(async (tx) => {
                    const postRef = db.collection('posts').doc();
                    const userRef = db.collection('users').doc(CURATOR_USER_ID);
                    tx.set(postRef, postData);
                    tx.update(userRef, {
                        postsCount: admin.firestore.FieldValue.increment(1),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    log(idx, total, null, `→ Post created: posts/${postRef.id}`);
                });
            });
            summary.imported++;
        } catch (err) {
            log(idx, total, null, `→ SKIP — Firestore write failed: ${err.message}`);
            summary.skipped.writeError++;
            summary.errors.push({ title: meta.title, stage: 'firestore', error: err.message });
            continue;
        }

        // Rate-limit delay (skip after last item)
        if (i < images.length - 1) {
            log(idx, total, null, `→ Waiting ${DELAY_BETWEEN_PHOTOS_MS / 1000}s...\n`);
            await sleep(DELAY_BETWEEN_PHOTOS_MS);
        }
    }

    // --- Summary ---
    summary.completedAt = new Date().toISOString();

    const totalSkipped = Object.values(summary.skipped).reduce((a, b) => a + b, 0);

    console.log('\n---');
    console.log('Import complete.');
    console.log(`  Total processed       : ${total}`);
    console.log(`  Successfully imported : ${summary.imported}`);
    console.log(`  Skipped (duplicate)   : ${summary.skipped.duplicate}`);
    console.log(`  Skipped (AI error)    : ${summary.skipped.aiError}`);
    console.log(`  Skipped (download err): ${summary.skipped.downloadError}`);
    console.log(`  Skipped (write error) : ${summary.skipped.writeError}`);
    console.log(`  Total skipped         : ${totalSkipped}`);
    console.log(`  Errors logged         : ${summary.errors.length}`);

    // Write summary JSON
    const date = new Date().toISOString().split('T')[0];
    const summaryDir = resolve(__dirname, '../../imports');
    const summaryPath = resolve(summaryDir, `manhattan-${date}.json`);

    try {
        await mkdir(summaryDir, { recursive: true });
        await writeFile(summaryPath, JSON.stringify(summary, null, 2));
        console.log(`  Summary written to    : imports/manhattan-${date}.json`);
    } catch (err) {
        console.error('  Failed to write summary file:', err.message);
    }
}

runImport().catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
});
