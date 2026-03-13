/**
 * Helper utilities for the Wikimedia Commons import pipeline.
 */

import { getStorage } from 'firebase-admin/storage';

const USER_AGENT = 'EchoesBot/1.0 (https://echoes.app; contact@echoes.app)';
const DESCRIPTION_MAX = 5000;
const DESCRIPTION_BODY_MAX = 4700; // leave room for attribution footer

/**
 * Builds a post description from Wikimedia metadata.
 * Includes the original description (if any) and attribution footer.
 */
export function buildDescription(meta) {
    const parts = [];

    if (meta.description) {
        parts.push(meta.description.substring(0, DESCRIPTION_BODY_MAX));
    }

    const attributionParts = ['Source: Wikimedia Commons'];
    if (meta.license) attributionParts.push(`License: ${meta.license}`);
    if (meta.artist) attributionParts.push(`Author: ${meta.artist}`);
    if (meta.title) attributionParts.push(`File: ${meta.title}`);
    parts.push(attributionParts.join(' | '));

    return parts.join('\n\n').substring(0, DESCRIPTION_MAX);
}

/**
 * Extracts a sorted array of years from Wikimedia metadata and/or AI date_estimate.
 * Returns [] if no year can be determined.
 */
export function extractYears(meta, aiMetadata) {
    const years = new Set();

    const parseYears = (text) => {
        if (!text) return;
        const matches = text.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/g) || [];
        for (const y of matches) {
            const year = parseInt(y, 10);
            if (year >= 1000 && year <= 3000) years.add(year);
        }
    };

    parseYears(meta.dateTimeOriginal);

    // Fall back to AI estimate only if Wikimedia didn't provide a year
    if (years.size === 0) {
        parseYears(aiMetadata?.date_estimate);
    }

    return Array.from(years).sort((a, b) => a - b);
}

/**
 * Downloads an image from a URL and returns a Buffer.
 */
export async function downloadImageBuffer(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
    });

    if (!res.ok) {
        throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
    }

    return Buffer.from(await res.arrayBuffer());
}

/**
 * Uploads an image buffer to Firebase Storage and returns the public URL.
 * Path format: post_media/{curatorUserId}/{timestamp}_{sanitizedFilename}
 */
export async function uploadToStorage(buffer, filename, contentType, curatorUserId, bucketName) {
    const bucket = getStorage().bucket(bucketName);
    const timestamp = Date.now();
    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
    const storagePath = `post_media/${curatorUserId}/${timestamp}_${sanitized}`;

    const file = bucket.file(storagePath);
    await file.save(buffer, {
        contentType,
        metadata: { cacheControl: 'public, max-age=31536000' },
    });

    await file.makePublic();

    return `https://storage.googleapis.com/${bucketName}/${storagePath}`;
}

/**
 * Deletes a previously uploaded file from Firebase Storage by its public URL.
 */
export async function deleteFromStorage(publicUrl, bucketName) {
    const prefix = `https://storage.googleapis.com/${bucketName}/`;
    const storagePath = publicUrl.replace(prefix, '');
    const bucket = getStorage().bucket(bucketName);
    await bucket.file(storagePath).delete();
}

/**
 * Checks if a photo has already been imported (by Wikimedia filename).
 * Uses a custom `wikimediaTitle` field stored on the post document.
 */
export async function checkAlreadyImported(db, title, userId = 'wikimedia-curator') {
    const snapshot = await db
        .collection('posts')
        .where('userId', '==', userId)
        .where('wikimediaTitle', '==', title)
        .limit(1)
        .get();

    return !snapshot.empty;
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retries an async function up to maxRetries times with exponential backoff.
 */
export async function retryWithBackoff(fn, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000;
                await sleep(delay);
            }
        }
    }
    throw lastError;
}
