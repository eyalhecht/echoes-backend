/**
 * Wikimedia Commons API client.
 * Queries categories, fetches image metadata, and handles pagination.
 */

const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'EchoesBot/1.0 (https://echoes.app; contact@echoes.app)';

// License keywords to allow (case-insensitive match)
const ALLOWED_LICENSE_KEYWORDS = [
    'public domain',
    'cc0',
    'cc-by',
    'cc by',
    'no restrictions',
    'pdm',
    'public domain mark',
];

const MIN_IMAGE_DIMENSION = 400;
const MAX_API_PAGES = 20;

async function wikimediaFetch(params) {
    const url = new URL(WIKIMEDIA_API);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
    }
    url.searchParams.set('format', 'json');

    const res = await fetch(url.toString(), {
        headers: { 'User-Agent': USER_AGENT },
    });

    if (!res.ok) {
        throw new Error(`Wikimedia API HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

async function fetchCategoryBatch(category, batchSize, continueToken) {
    const params = {
        action: 'query',
        generator: 'categorymembers',
        gcmtitle: `Category:${category}`,
        gcmtype: 'file',
        gcmlimit: String(Math.min(batchSize, 50)),
        prop: 'imageinfo|coordinates',
        iiprop: 'url|extmetadata|size|mime',
        iiurlwidth: '1600',
        colimit: '50',
    };

    if (continueToken) {
        Object.assign(params, continueToken);
    }

    const data = await wikimediaFetch(params);
    const pages = data.query?.pages ? Object.values(data.query.pages) : [];
    return { pages, continue: data.continue || null };
}

function stripHtml(html) {
    return (html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export function extractImageMetadata(page) {
    const imageinfo = page.imageinfo?.[0] || {};
    const extmeta = imageinfo.extmetadata || {};

    let lat = null;
    let lng = null;

    if (page.coordinates?.[0]) {
        lat = page.coordinates[0].lat;
        lng = page.coordinates[0].lon;
    } else if (extmeta.GPSLatitude?.value && extmeta.GPSLongitude?.value) {
        lat = parseFloat(extmeta.GPSLatitude.value);
        lng = parseFloat(extmeta.GPSLongitude.value);
    }

    return {
        pageId: page.pageid,
        title: (page.title || '').replace(/^File:/, ''),
        url: imageinfo.thumburl || imageinfo.url || '',
        mime: imageinfo.mime || '',
        width: imageinfo.width || 0,
        height: imageinfo.height || 0,
        license: stripHtml(extmeta.LicenseShortName?.value || extmeta.License?.value || ''),
        description: stripHtml(extmeta.ImageDescription?.value || ''),
        artist: stripHtml(extmeta.Artist?.value || ''),
        dateTimeOriginal: extmeta.DateTimeOriginal?.value || extmeta.DateTime?.value || '',
        lat,
        lng,
    };
}

export function isValidImage(meta) {
    if (!['image/jpeg', 'image/png', 'image/tiff'].includes(meta.mime)) return false;
    if (meta.width < MIN_IMAGE_DIMENSION || meta.height < MIN_IMAGE_DIMENSION) return false;
    if (!meta.url) return false;

    const licenseLower = meta.license.toLowerCase();
    return ALLOWED_LICENSE_KEYWORDS.some(kw => licenseLower.includes(kw));
}

/**
 * Fetches up to `limit` valid images from a Wikimedia Commons category.
 * Handles pagination automatically.
 */
export async function fetchImagesFromCategory(category, limit, overFetchMultiplier = 3) {
    // Over-fetch so we can prioritise geo-tagged images
    const overFetchTarget = Math.min(limit * overFetchMultiplier, 300);
    const candidates = [];
    let continueToken = null;
    let apiPageCount = 0;

    while (candidates.length < overFetchTarget) {
        const result = await fetchCategoryBatch(category, 50, continueToken);
        apiPageCount++;

        for (const page of result.pages) {
            const meta = extractImageMetadata(page);
            if (isValidImage(meta)) {
                candidates.push(meta);
            }
        }

        if (!result.continue || apiPageCount >= MAX_API_PAGES) break;
        continueToken = result.continue;
    }

    // Sort: geo-tagged photos first, then the rest
    candidates.sort((a, b) => {
        const aHasGeo = a.lat !== null ? 0 : 1;
        const bHasGeo = b.lat !== null ? 0 : 1;
        return aHasGeo - bHasGeo;
    });

    return candidates.slice(0, limit);
}

/**
 * Fetches subcategories of a Wikimedia Commons category.
 * Returns an array of subcategory names (without the "Category:" prefix).
 */
export async function fetchSubcategories(category, limit = 50) {
    const params = {
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${category}`,
        cmtype: 'subcat',
        cmlimit: String(Math.min(limit, 50)),
    };

    const data = await wikimediaFetch(params);
    const members = data.query?.categorymembers || [];
    return members.map(m => m.title.replace(/^Category:/, ''));
}

/**
 * Light browse of a Wikimedia category — returns metadata without downloading images.
 * Useful for agents to evaluate candidates before committing to download.
 */
export async function browseCategoryLight(category, limit = 20) {
    const candidates = [];
    let continueToken = null;
    let apiPageCount = 0;

    while (candidates.length < limit) {
        const result = await fetchCategoryBatch(category, 50, continueToken);
        apiPageCount++;

        for (const page of result.pages) {
            const meta = extractImageMetadata(page);
            if (isValidImage(meta)) {
                candidates.push(meta);
            }
        }

        if (!result.continue || apiPageCount >= 3) break;
        continueToken = result.continue;
    }

    // Sort: geo-tagged first
    candidates.sort((a, b) => {
        const aHasGeo = a.lat !== null ? 0 : 1;
        const bHasGeo = b.lat !== null ? 0 : 1;
        return aHasGeo - bHasGeo;
    });

    return candidates.slice(0, limit);
}
