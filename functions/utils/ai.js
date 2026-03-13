import vision from '@google-cloud/vision';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { createAgent, tool } from 'langchain';
import { z } from 'zod';
import { defineSecret } from 'firebase-functions/params';
import { AI_CONFIG } from './constants.js';

export const openaiApiKey = defineSecret('OPENAI_API_KEY');

const SynthesisSchema = z.object({
    description: z.string().describe("Rich authoritative narrative combining historical, geographic, and subject analysis"),
    date_estimate: z.string().describe("Most specific time period supported by evidence"),
    date_confidence: z.enum(['definite', 'probable', 'possible', 'unknown']),
    location: z.string().describe("Most specific to general location"),
    location_confidence: z.enum(['definite', 'probable', 'possible', 'unknown']),
    historical_period: z.string().describe("Named historical period or era"),
    historical_significance: z.string().describe("Why this moment, place, or person matters historically — the broader story this image is part of"),
    cultural_context: z.string().describe("The social, political, or cultural backdrop of the era depicted"),
    era_indicators: z.array(z.string()).describe("Specific visual clues that informed the date estimate, e.g. 'sepia tone', 'Model T Ford visible', 'WWI-era infantry uniform'"),
    people_identified: z.array(z.object({
        name: z.string().describe("Full name of the identified person"),
        role: z.string().describe("Their historical role or significance at this time, e.g. 'British Prime Minister, 1940-1945'"),
        confidence: z.enum(['definite', 'probable', 'possible']),
    })).describe("People identified in the photograph"),
    geographic_terms: z.array(z.string()).describe("Locations from specific to general with Getty TGN refs"),
    subject_terms: z.array(z.string()).describe("Getty AAT subject classifications"),
    tags: z.array(z.string()).describe("~20 searchable tags merging all insights"),
});

function createVisionTools(imageUrl) {
    const detectLandmarks = tool(
        async () => {
            const client = new vision.ImageAnnotatorClient();
            const [result] = await client.annotateImage({
                image: { source: { imageUri: imageUrl } },
                features: [{ type: 'LANDMARK_DETECTION', maxResults: AI_CONFIG.VISION_MAX_LANDMARKS }],
            });
            const landmarks = (result.landmarkAnnotations || []).map(l => ({
                name: l.description,
                confidence: l.score,
                location: l.locations?.[0]?.latLng || null,
            }));
            return JSON.stringify(landmarks.length > 0 ? landmarks : 'No landmarks detected');
        },
        {
            name: 'detectLandmarks',
            description: 'Detect well-known landmarks, monuments, and buildings in the image. Call when you see buildings, monuments, or recognizable places.',
            schema: z.object({}),
        }
    );

    const extractText = tool(
        async () => {
            const client = new vision.ImageAnnotatorClient();
            const [result] = await client.annotateImage({
                image: { source: { imageUri: imageUrl } },
                features: [{ type: 'TEXT_DETECTION' }],
            });
            const text = result.textAnnotations?.[0]?.description || '';
            return text ? text.substring(0, AI_CONFIG.VISION_TEXT_MAX_CHARS) : 'No text detected';
        },
        {
            name: 'extractText',
            description: 'OCR — extract all visible text from signs, newspapers, documents, captions, or labels in the image. Call when you see readable text.',
            schema: z.object({}),
        }
    );

    const searchWeb = tool(
        async () => {
            const client = new vision.ImageAnnotatorClient();
            const [result] = await client.annotateImage({
                image: { source: { imageUri: imageUrl } },
                features: [{ type: 'WEB_DETECTION', maxResults: AI_CONFIG.VISION_MAX_WEB_RESULTS }],
            });
            const webDetection = result.webDetection || {};
            const webEntities = (webDetection.webEntities || [])
                .filter(e => e.description && e.score > 0.5)
                .map(e => ({ description: e.description, score: e.score }));
            const matchCount = [
                ...(webDetection.fullMatchingImages || []),
                ...(webDetection.partialMatchingImages || []),
            ].length;
            const pagesWithMatchingImages = (webDetection.pagesWithMatchingImages || [])
                .slice(0, 5)
                .map(p => ({ url: p.url, title: p.pageTitle || '' }));
            return JSON.stringify({ webEntities, matchingImageCount: matchCount, pagesWithMatchingImages });
        },
        {
            name: 'searchWeb',
            description: 'Search the web for matching images and entities. Call when you want to identify people, find context about the image, or discover what this image depicts.',
            schema: z.object({}),
        }
    );

    const detectLabels = tool(
        async () => {
            const client = new vision.ImageAnnotatorClient();
            const [result] = await client.annotateImage({
                image: { source: { imageUri: imageUrl } },
                features: [{ type: 'LABEL_DETECTION', maxResults: AI_CONFIG.VISION_MAX_LABELS }],
            });
            const labels = (result.labelAnnotations || [])
                .filter(l => l.score > 0.7)
                .map(l => ({ description: l.description, score: l.score }));
            return JSON.stringify(labels.length > 0 ? labels : 'No high-confidence labels detected');
        },
        {
            name: 'detectLabels',
            description: 'Classify the scene and detect objects via label detection. Call when you want to understand the general content, objects, and scene type.',
            schema: z.object({}),
        }
    );

    const detectLogos = tool(
        async () => {
            const client = new vision.ImageAnnotatorClient();
            const [result] = await client.annotateImage({
                image: { source: { imageUri: imageUrl } },
                features: [{ type: 'LOGO_DETECTION', maxResults: AI_CONFIG.VISION_MAX_LOGOS }],
            });
            const logos = (result.logoAnnotations || []).map(l => ({
                name: l.description,
                confidence: l.score,
            }));
            return JSON.stringify(logos.length > 0 ? logos : 'No logos detected');
        },
        {
            name: 'detectLogos',
            description: 'Detect logos, brand marks, newspaper mastheads, military insignia, government seals, and organizational symbols. Call when you see any printed material, uniforms, vehicles, storefronts, or official documents — logos often pinpoint the exact organization, publication, or era.',
            schema: z.object({}),
        }
    );

    const searchWikipedia = tool(
        async ({ query }) => {
            try {
                const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`;
                const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'Echoes-HistoricalAnalysis/1.0' } });
                const searchData = await searchRes.json();
                const hits = searchData?.query?.search || [];

                if (hits.length === 0) return 'No Wikipedia articles found for this query.';

                const topTitle = hits[0].title;
                const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topTitle)}`;
                const summaryRes = await fetch(summaryUrl, { headers: { 'User-Agent': 'Echoes-HistoricalAnalysis/1.0' } });
                const summaryData = await summaryRes.json();

                return JSON.stringify({
                    title: summaryData.title,
                    summary: summaryData.extract?.substring(0, 800) || '',
                    otherResults: hits.slice(1).map(h => h.title),
                });
            } catch (error) {
                console.error('searchWikipedia failed:', error.message);
                return `Wikipedia lookup failed: ${error.message}`;
            }
        },
        {
            name: 'searchWikipedia',
            description: 'Look up a specific person, event, place, or organization on Wikipedia to get factual historical context. Call this after identifying something from other tools — e.g. a named person from searchWeb, a landmark from detectLandmarks, a logo or insignia from detectLogos, or a historical event you want to verify. Use a precise query like a full name or event name.',
            schema: z.object({
                query: z.string().describe('Specific search query, e.g. "Winston Churchill", "Battle of the Somme", "Eiffel Tower history"'),
            }),
        }
    );

    return [detectLandmarks, extractText, searchWeb, detectLabels, detectLogos, searchWikipedia];
}

export async function checkSafeSearch(imageUrl) {
    const client = new vision.ImageAnnotatorClient();

    try {
        const [result] = await client.annotateImage({
            image: { source: { imageUri: imageUrl } },
            features: [{ type: 'SAFE_SEARCH_DETECTION' }],
        });

        const likelihoodToScore = {
            'VERY_UNLIKELY': 1,
            'UNLIKELY': 2,
            'POSSIBLE': 3,
            'LIKELY': 4,
            'VERY_LIKELY': 5,
        };

        const ss = result.safeSearchAnnotation;
        return {
            adult: ss.adult,
            violence: ss.violence,
            racy: ss.racy,
            medical: ss.medical,
            spoof: ss.spoof,
            adultScore: likelihoodToScore[ss.adult] || 1,
            violenceScore: likelihoodToScore[ss.violence] || 1,
            racyScore: likelihoodToScore[ss.racy] || 1,
            isAppropriate: (
                likelihoodToScore[ss.adult] <= 2 &&
                likelihoodToScore[ss.violence] <= 2 &&
                likelihoodToScore[ss.racy] <= 3
            ),
        };
    } catch (error) {
        console.error('Safe search detection failed:', error);
        return {
            adult: 'UNKNOWN', violence: 'UNKNOWN', racy: 'UNKNOWN',
            medical: 'UNKNOWN', spoof: 'UNKNOWN',
            adultScore: 1, violenceScore: 1, racyScore: 1,
            isAppropriate: false, error: error.message,
        };
    }
}

export async function analyzePhoto(photoUrl, userContext = {}) {
    const model = new ChatOpenAI({
        model: AI_CONFIG.MODEL,
        temperature: AI_CONFIG.TEMPERATURE,
        apiKey: openaiApiKey.value(),
    });

    const userContextLines = [];
    if (userContext.description) userContextLines.push(`User description: "${userContext.description}"`);
    if (userContext.year?.length > 0) userContextLines.push(`User-provided year(s): ${userContext.year.join(', ')}`);
    if (userContext.location) userContextLines.push(`User-provided location: ${JSON.stringify(userContext.location)}`);
    const userContextText = userContextLines.length > 0
        ? `\n\nUser-provided metadata:\n${userContextLines.join('\n')}`
        : '';

    const systemPrompt = `You are the Echoes historical photograph analyst — a senior archivist and historian revealing the hidden story of historical photographs.

## Available tools
- detectLabels: scene classification and object identification — always call this first
- detectLogos: logos, newspaper mastheads, military insignia, organizational symbols
- detectLandmarks: well-known buildings, monuments, recognizable places
- extractText: OCR of signs, newspapers, documents, captions
- searchWeb: reverse image search — web entities, matching images, named individuals
- searchWikipedia(query): look up a specific person, event, place, or organization to get verified historical facts — call this after other tools give you a name or event to investigate

## Two-phase workflow

### Phase 1 — Orient (always run first)
Call detectLabels immediately to understand the scene type. Based on the results, form an initial hypothesis:
- What era does this look like from photo quality alone (sepia/black-and-white/color)?
- What is the setting (military, civilian, urban, rural, document)?
- What specific features need deeper investigation?

### Phase 2 — Investigate (evidence-based, based on Phase 1)
Call only the tools that Phase 1 makes relevant:
- Uniforms, insignia, printed material, vehicles → detectLogos
- Buildings, monuments, recognizable skylines → detectLandmarks
- Visible text, signs, newspapers, captions → extractText
- Faces of potentially identifiable people, or need broader context → searchWeb
- Named person, event, place, or organization identified by any tool → searchWikipedia
Call multiple tools in parallel within this phase when appropriate. searchWikipedia can run in parallel with other Phase 2 tools if you already have a name to look up from Phase 1.

## Reasoning before your final answer
Before producing the archival record, explicitly reason through:
1. What visual clues indicate the time period? (photo quality, clothing, technology, vehicles)
2. What did the tools confirm or contradict about your initial estimate?
3. How confident are you in the date and location, and what evidence supports each?
4. What is the broader historical significance — what larger story is this image part of?

Your expertise covers: historical period dating from visual clues, identifying notable public figures, geographic identification using Getty TGN terminology, document analysis, and cultural/social context using Getty AAT subject classifications.
${userContextText}`;

    const agent = createAgent({
        model,
        tools: createVisionTools(photoUrl),
        systemPrompt,
        responseFormat: SynthesisSchema,
    });

    try {
        const result = await agent.invoke({
            messages: [
                new HumanMessage({
                    content: [
                        { type: 'text', text: 'Analyze this historical photograph. Use the available Vision API tools to gather evidence, then produce your final archival record.' },
                        { type: 'image_url', image_url: { url: photoUrl, detail: 'high' } },
                    ],
                }),
            ],
        }, { recursionLimit: 50 });

        return result.structuredResponse;

    } catch (error) {
        console.error('Photo analysis failed:', error);
        throw new Error(`Failed to analyze photo: ${error.message}`);
    }
}
