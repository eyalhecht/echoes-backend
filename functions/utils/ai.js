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
    people_identified: z.array(z.string()).describe("List of identified people with confidence levels"),
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
            return JSON.stringify({
                webEntities,
                matchingImageCount: matchCount,
                pagesWithMatchingImages,
            });
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

    return [detectLandmarks, extractText, searchWeb, detectLabels];
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

You have access to Google Cloud Vision API tools to gather evidence about the image. Use them strategically:
- detectLandmarks: when you see buildings, monuments, or recognizable places
- extractText: when you see text, signs, newspapers, documents, or captions
- searchWeb: when you want to identify people, find context, or match the image against known sources
- detectLabels: when you want scene classification and object identification

Workflow:
1. Study the photograph carefully — note what you observe (people, setting, objects, text, architecture, clothing, technology).
2. Call the Vision API tools that are relevant to what you see. Call multiple tools in parallel when appropriate. Skip tools that won't help.
3. Combine your expert historical knowledge with the tool results to produce a comprehensive archival record.

Your expertise covers: historical period dating from visual clues (clothing, technology, photo quality), identifying notable public figures, geographic identification from architecture and signage (using Getty TGN terminology), document and text analysis, and cultural/social context analysis using Getty AAT subject classifications.
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
        });
        return result.structuredResponse;
    } catch (error) {
        console.error('Photo analysis failed:', error);
        throw new Error(`Failed to analyze photo: ${error.message}`);
    }
}
