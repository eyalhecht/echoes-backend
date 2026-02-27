import vision from '@google-cloud/vision';
import OpenAI from 'openai';
import { defineSecret } from 'firebase-functions/params';
import { AI_CONFIG } from './constants.js';

export const openaiApiKey = defineSecret('OPENAI_API_KEY');


// --- Vision context formatting ---

function buildVisionContextSummary(visionContext) {
    const parts = [];
    if (visionContext.landmarks?.length > 0) {
        parts.push(`Landmarks detected: ${visionContext.landmarks.map(l => `${l.name} (${(l.confidence * 100).toFixed(0)}% confidence)`).join(', ')}`);
    }
    if (visionContext.text) {
        parts.push(`Text visible in image: "${visionContext.text.substring(0, 500)}"`);
    }
    if (visionContext.webEntities?.length > 0) {
        parts.push(`Web entities matched: ${visionContext.webEntities.map(e => e.description).join(', ')}`);
    }
    if (visionContext.webMatchingImages?.length > 0) {
        parts.push(`Similar images found online: ${visionContext.webMatchingImages.length} match(es)`);
    }
    if (visionContext.labels?.length > 0) {
        parts.push(`Scene labels: ${visionContext.labels.map(l => l.description).join(', ')}`);
    }
    return parts.length > 0 ? parts.join('\n') : 'No additional context from Vision API';
}

// --- Specialist tool definitions ---

const SPECIALIST_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'analyzeHistoricalContext',
            description: 'Perform deep historical and cultural analysis of the photograph — time period, era indicators, social context, and historical significance. Always worth calling.',
            parameters: {
                type: 'object',
                properties: {
                    focus: {
                        type: 'string',
                        description: 'Specific aspect to focus on based on what you see (e.g. "military uniforms", "architectural style", "social gathering context")'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'identifyPeople',
            description: 'Identify specific people visible in the photograph. Call this when faces are clearly visible or when web entities suggest specific known individuals.',
            parameters: {
                type: 'object',
                properties: {
                    candidates: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Names suggested by web detection to verify (can be empty if none)'
                    }
                },
                required: ['candidates']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'analyzeGeography',
            description: 'Perform detailed geographic and location analysis. Call this when landmarks are detected, recognizable locations are visible, or web entities suggest specific places.',
            parameters: {
                type: 'object',
                properties: {
                    locationClues: {
                        type: 'string',
                        description: 'Specific location clues to investigate (e.g. landmark names, architectural styles, vegetation, road signs)'
                    }
                },
                required: ['locationClues']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'analyzeDocument',
            description: 'Extract and analyze text content from the photograph. Call this when text, signs, newspapers, documents, captions, or stamped dates are visible in the image.',
            parameters: {
                type: 'object',
                properties: {
                    extractedText: {
                        type: 'string',
                        description: 'Text already extracted from Vision OCR to cross-reference and analyze'
                    }
                },
                required: ['extractedText']
            }
        }
    }
];

// --- Specialist executor functions ---

async function executeHistoricalAnalysis(openai, photoUrl, visionContext, args) {
    const response = await openai.chat.completions.create({
        model: AI_CONFIG.MODEL,
        messages: [
            {
                role: 'system',
                content: `You are an expert historian and archivist specializing in visual history. Analyze photographs for historical period, cultural context, and social significance using visual clues like clothing, technology, architecture, and photo quality.${args.focus ? ` Focus especially on: ${args.focus}.` : ''}`
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Analyze this photograph for historical context.\n\nVision API context:\n${buildVisionContextSummary(visionContext)}\n\nReturn JSON:\n{\n  "historical_period": "e.g. World War II era, 1960s counterculture",\n  "date_estimate": "e.g. 1940s, early 1960s",\n  "date_confidence": "definite|probable|possible|unknown",\n  "cultural_context": "what this scene represents culturally",\n  "historical_significance": "why this matters historically",\n  "era_indicators": ["specific visual clues that date this photo"],\n  "tags": ["~10 historical tags"]\n}`
                    },
                    { type: 'image_url', image_url: { url: photoUrl, detail: 'high' } }
                ]
            }
        ],
        temperature: AI_CONFIG.TEMPERATURE,
        max_tokens: 800,
        response_format: { type: 'json_object' }
    });
    return JSON.parse(response.choices[0].message.content);
}

async function executeIdentifyPeople(openai, photoUrl, visionContext, args) {
    const candidateHint = args.candidates?.length > 0
        ? `Web detection suggests these individuals may be present: ${args.candidates.join(', ')}. Verify carefully.`
        : 'No specific candidates suggested — identify anyone clearly recognizable.';

    const response = await openai.chat.completions.create({
        model: AI_CONFIG.MODEL,
        messages: [
            {
                role: 'system',
                content: 'You are an expert at identifying historical figures, politicians, celebrities, athletes, and notable public figures in photographs. Only identify people you are genuinely confident about — never guess.'
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Identify any specific people in this photograph.\n\n${candidateHint}\n\nVision context:\n${buildVisionContextSummary(visionContext)}\n\nReturn JSON:\n{\n  "people_identified": [\n    { "name": "Full Name", "confidence": "definite|probable|possible", "role": "e.g. US President, musician" }\n  ],\n  "tags": ["identified people names as tags"]\n}`
                    },
                    { type: 'image_url', image_url: { url: photoUrl, detail: 'high' } }
                ]
            }
        ],
        temperature: AI_CONFIG.TEMPERATURE,
        max_tokens: 500,
        response_format: { type: 'json_object' }
    });
    return JSON.parse(response.choices[0].message.content);
}

async function executeAnalyzeGeography(openai, photoUrl, visionContext, args) {
    const response = await openai.chat.completions.create({
        model: AI_CONFIG.MODEL,
        messages: [
            {
                role: 'system',
                content: 'You are an expert geographer and urban historian specializing in identifying locations from visual clues — architecture, signage, vegetation, topography, and street layouts. Use Getty TGN terminology for standardized geographic names.'
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Identify the location shown in this photograph.\n\nLocation clues to investigate: ${args.locationClues}\n\nVision context:\n${buildVisionContextSummary(visionContext)}\n\nReturn JSON:\n{\n  "location": "Most specific to general, e.g. Times Square, New York City, United States",\n  "location_confidence": "definite|probable|possible|unknown",\n  "geographic_terms": ["array of locations from specific to general with TGN refs where known"],\n  "geographic_context": "description of this place and its significance",\n  "tags": ["~8 location tags"]\n}`
                    },
                    { type: 'image_url', image_url: { url: photoUrl, detail: 'high' } }
                ]
            }
        ],
        temperature: AI_CONFIG.TEMPERATURE,
        max_tokens: 600,
        response_format: { type: 'json_object' }
    });
    return JSON.parse(response.choices[0].message.content);
}

async function executeAnalyzeDocument(openai, photoUrl, visionContext, args) {
    const response = await openai.chat.completions.create({
        model: AI_CONFIG.MODEL,
        messages: [
            {
                role: 'system',
                content: 'You are an expert document analyst and archivist. Analyze text visible in photographs — newspapers, signs, captions, stamps, labels — to extract dates, sources, events, and context.'
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Analyze the text content visible in this photograph.\n\nOCR extracted text:\n"${args.extractedText}"\n\nVision context:\n${buildVisionContextSummary(visionContext)}\n\nReturn JSON:\n{\n  "document_type": "e.g. newspaper front page, street sign, photo caption, official document",\n  "document_content": "summary of what the text says",\n  "date_from_text": "any date found in the text, or null",\n  "source_from_text": "publication, institution, or source name if found, or null",\n  "key_facts": ["important facts extracted from the text"],\n  "tags": ["~8 tags from document content"]\n}`
                    },
                    { type: 'image_url', image_url: { url: photoUrl, detail: 'high' } }
                ]
            }
        ],
        temperature: AI_CONFIG.TEMPERATURE,
        max_tokens: 600,
        response_format: { type: 'json_object' }
    });
    return JSON.parse(response.choices[0].message.content);
}

// --- Tool executor dispatch map ---

const TOOL_EXECUTORS = {
    analyzeHistoricalContext: executeHistoricalAnalysis,
    identifyPeople: executeIdentifyPeople,
    analyzeGeography: executeAnalyzeGeography,
    analyzeDocument: executeAnalyzeDocument,
};

function validateAndCleanResult(result) {
    const cleaned = {
        description: result.description || 'Photograph',
        date_estimate: result.date_estimate || 'Unknown period',
        date_confidence: result.date_confidence || 'unknown',
        location: result.location || 'Unknown location',
        location_confidence: result.location_confidence || 'unknown',
        historical_period: result.historical_period || '',
        people_identified: Array.isArray(result.people_identified) ? result.people_identified : [],
        geographic_terms: Array.isArray(result.geographic_terms) ? result.geographic_terms : [],
        subject_terms: Array.isArray(result.subject_terms) ? result.subject_terms : [],
        tags: Array.isArray(result.tags) ? result.tags : []
    };
    return cleaned;
}

// --- Coordinator ---

async function runCoordinator(openai, photoUrl, visionContext, userContext) {
    const visionSummary = buildVisionContextSummary(visionContext);

    const userContextLines = [];
    if (userContext.description) userContextLines.push(`User description: "${userContext.description}"`);
    if (userContext.year?.length > 0) userContextLines.push(`User-provided year(s): ${userContext.year.join(', ')}`);
    if (userContext.location) userContextLines.push(`User-provided location coordinates: ${JSON.stringify(userContext.location)}`);
    const userContextText = userContextLines.length > 0
        ? `\n\nUser-provided metadata:\n${userContextLines.join('\n')}`
        : '';

    const response = await openai.chat.completions.create({
        model: AI_CONFIG.MODEL,
        messages: [
            {
                role: 'system',
                content: `You are an orchestrator deciding which specialist analysis tools to apply to a historical photograph.

Rules:
- Call analyzeHistoricalContext for almost every photo — it provides core historical dating and cultural context
- Call identifyPeople if faces are clearly visible OR web entities suggest specific named individuals
- Call analyzeGeography if landmarks are detected, a recognizable location is visible, or notable location clues exist
- Call analyzeDocument if readable text, signs, newspapers, dates, or captions are visible

You may call multiple tools simultaneously. Use the Vision API context to make smart decisions about what is worth analyzing.`
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Select the appropriate specialist tools for this photograph.\n\nVision API context:\n${visionSummary}${userContextText}`
                    },
                    { type: 'image_url', image_url: { url: photoUrl, detail: 'high' } }
                ]
            }
        ],
        tools: SPECIALIST_TOOLS,
        tool_choice: 'auto',
        temperature: AI_CONFIG.TEMPERATURE,
        max_tokens: 300
    });

    const toolCalls = response.choices[0].message.tool_calls || [];

    if (toolCalls.length === 0) {
        console.warn('Coordinator made no tool calls — falling back to historical analysis');
        toolCalls.push({ function: { name: 'analyzeHistoricalContext', arguments: '{}' } });
    }

    console.log(`Coordinator selected ${toolCalls.length} specialist(s):`, toolCalls.map(tc => tc.function.name));

    const results = await Promise.all(
        toolCalls.map(async (toolCall) => {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            const executor = TOOL_EXECUTORS[toolName];

            if (!executor) {
                console.warn(`Unknown tool requested: ${toolName}`);
                return null;
            }

            try {
                const result = await executor(openai, photoUrl, visionContext, toolArgs);
                console.log(`Specialist "${toolName}" completed`);
                return { toolName, result };
            } catch (error) {
                console.error(`Specialist "${toolName}" failed:`, error.message);
                return null;
            }
        })
    );

    return results.filter(Boolean);
}

// --- Synthesis ---

async function runSynthesis(openai, photoUrl, visionContext, specialistResults, userContext) {
    const visionSummary = buildVisionContextSummary(visionContext);

    const specialistReports = specialistResults
        .map(({ toolName, result }) => `### ${toolName}\n${JSON.stringify(result, null, 2)}`)
        .join('\n\n');

    const userContextLines = [];
    if (userContext.description) userContextLines.push(`Uploader description: "${userContext.description}"`);
    if (userContext.year?.length > 0) userContextLines.push(`Uploader-provided year(s): ${userContext.year.join(', ')}`);
    const userContextText = userContextLines.length > 0
        ? `\n\nUploader-provided metadata:\n${userContextLines.join('\n')}`
        : '';

    const response = await openai.chat.completions.create({
        model: AI_CONFIG.MODEL,
        messages: [
            {
                role: 'system',
                content: `You are a senior archivist synthesizing expert specialist reports into a final authoritative archival record for a historical photograph. Your responsibilities:
- Combine all specialist insights into a single coherent, rich narrative
- Resolve conflicts between specialists using your own visual judgment — trust higher-confidence findings
- Elevate the most specific and certain information (a definite landmark beats a probable one)
- Write the description like a knowledgeable tour guide explaining the scene to someone who found it in a drawer
- Merge all specialist tags into a comprehensive, deduplicated tag list`
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Synthesize the specialist reports below into a final archival record for this photograph.

Vision API context:
${visionSummary}${userContextText}

Specialist reports:
${specialistReports}

Return a JSON object with this exact structure:
{
  "description": "Rich authoritative narrative — lead with what is visible, follow with historical significance and cultural context. Combine all specialist insights. Be specific and compelling.",
  "date_estimate": "Most specific time period supported by the evidence (e.g. '1943', '1960s', 'early 1970s')",
  "date_confidence": "definite|probable|possible|unknown",
  "location": "Most specific to general location (e.g. 'Eiffel Tower, Paris, France')",
  "location_confidence": "definite|probable|possible|unknown",
  "historical_period": "Named historical period or era (e.g. 'World War II', 'Space Age', 'Cold War era')",
  "people_identified": ["Name (confidence)" for each identified person],
  "geographic_terms": ["Locations from specific to general with Getty TGN refs where known"],
  "subject_terms": ["Getty AAT subject classifications"],
  "tags": ["~20 searchable tags merging all specialist outputs — people, objects, activities, time period, location, style, mood, themes"]
}`
                    },
                    { type: 'image_url', image_url: { url: photoUrl, detail: 'high' } }
                ]
            }
        ],
        temperature: AI_CONFIG.TEMPERATURE,
        max_tokens: AI_CONFIG.MAX_TOKENS,
        response_format: { type: 'json_object' }
    });

    return JSON.parse(response.choices[0].message.content);
}

export async function analyzePhoto(photoUrl, visionContext = {}, userContext = {}) {
    const openai = new OpenAI({
        apiKey: openaiApiKey.value(),
    });

    try {
        const specialistResults = await runCoordinator(openai, photoUrl, visionContext, userContext);
        console.log(`Collected ${specialistResults.length} specialist result(s):`, specialistResults.map(r => r.toolName));

        const result = await runSynthesis(openai, photoUrl, visionContext, specialistResults, userContext);
        return validateAndCleanResult(result);

    } catch (error) {
        console.error('Photo analysis failed:', error);
        throw new Error(`Failed to analyze photo: ${error.message}`);
    }
}

export async function runVisionAnalysis(imageUrl) {
    const client = new vision.ImageAnnotatorClient();

    try {
        const [result] = await client.annotateImage({
            image: { source: { imageUri: imageUrl } },
            features: [
                { type: 'SAFE_SEARCH_DETECTION' },
                { type: 'LANDMARK_DETECTION', maxResults: 5 },
                { type: 'TEXT_DETECTION' },
                { type: 'WEB_DETECTION', maxResults: 10 },
                { type: 'LABEL_DETECTION', maxResults: 10 }
            ]
        });

        const likelihoodToScore = {
            'VERY_UNLIKELY': 1,
            'UNLIKELY': 2,
            'POSSIBLE': 3,
            'LIKELY': 4,
            'VERY_LIKELY': 5
        };

        const ss = result.safeSearchAnnotation;
        const safeSearch = {
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
            )
        };

        const landmarks = (result.landmarkAnnotations || []).map(l => ({
            name: l.description,
            confidence: l.score,
            location: l.locations?.[0]?.latLng || null
        }));

        const text = result.textAnnotations?.[0]?.description || '';

        const webDetection = result.webDetection || {};
        const webEntities = (webDetection.webEntities || [])
            .filter(e => e.description && e.score > 0.5)
            .map(e => ({ description: e.description, score: e.score }));
        const webMatchingImages = [
            ...(webDetection.fullMatchingImages || []),
            ...(webDetection.partialMatchingImages || [])
        ].slice(0, 5).map(i => ({ url: i.url }));

        const labels = (result.labelAnnotations || [])
            .filter(l => l.score > 0.7)
            .map(l => ({ description: l.description, score: l.score }));

        console.log('Vision analysis complete:', {
            landmarksFound: landmarks.length,
            textLength: text.length,
            webEntitiesFound: webEntities.length,
            labelsFound: labels.length,
            isAppropriate: safeSearch.isAppropriate
        });

        return { safeSearch, landmarks, text, webEntities, webMatchingImages, labels };

    } catch (error) {
        console.error('Vision analysis failed:', error);
        return {
            safeSearch: {
                adult: 'UNKNOWN', violence: 'UNKNOWN', racy: 'UNKNOWN',
                medical: 'UNKNOWN', spoof: 'UNKNOWN',
                adultScore: 1, violenceScore: 1, racyScore: 1,
                isAppropriate: false, error: error.message
            },
            landmarks: [],
            text: '',
            webEntities: [],
            webMatchingImages: [],
            labels: []
        };
    }
}
