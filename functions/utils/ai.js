import vision from '@google-cloud/vision';
import OpenAI from 'openai';
import { defineSecret } from 'firebase-functions/params';
import { AI_CONFIG } from './constants.js';

export const openaiApiKey = defineSecret('OPENAI_API_KEY');

// System prompt for consistent, professional analysis
const SYSTEM_PROMPT = `You are an expert historian and archivist analyzing photographs. You have deep knowledge of:
- Historical periods, events, and cultural movements (1850-present)
- Getty Vocabulary Program (AAT, TGN) for standardized terms
- Library of Congress Subject Headings (LCSH)
- Professional archival cataloging practices
- Historical figures, celebrities, and notable people
- Architecture, fashion, technology, and social history across different eras

You analyze photos like a detective-historian who pieces together stories from visual evidence. When someone brings you a photograph saying "I found this in my drawer, what am I looking at?", you:

1. Act as a knowledgeable tour guide explaining what they're seeing
2. Use visual clues (clothing, cars, architecture, photo quality) to determine time period and location
3. Explain the historical significance and cultural context of what's depicted
4. Provide both what's visible AND why it matters historically
5. Use controlled vocabularies and standardized geographic terms
6. Be specific about locations, dates, and historical context when identifiable
7. For ordinary scenes with no historical significance, focus on era indicators and social context`;

// User prompt template
const USER_PROMPT = `Analyze this photograph like a historian/archivist examining evidence. Someone brought this to you saying "I found this in my drawer, what am I looking at?"

Provide both what's visible AND its historical significance. Act like a tour guide explaining the scene.

Return a JSON object with this exact structure:

{
  "description": "Rich contextual analysis combining what's visible with historical significance. Use visual clues (clothing, architecture, technology, photo quality) to determine time/place. Explain what this scene represents historically and culturally. For monuments/landmarks, explain who built it, when, why, and its significance. For ordinary scenes, describe the era and social context. Be like a detective-historian piecing together the story from visual evidence.",
  "date_estimate": "Time period estimate based on visual clues (e.g., '1960s', '1980s', 'early 2000s')",
  "date_confidence": "definite|probable|possible|unknown",
  "location": "Most specific to general location (e.g., 'Times Square, New York City, United States')",
  "location_confidence": "definite|probable|possible|unknown",
  "historical_period": "Historical period or era this represents",
  "people_identified": ["Array of specific people if clearly identifiable with confidence levels"],
  "geographic_terms": ["Array of locations with TGN IDs when available, from specific to general"],
  "subject_terms": ["Array of subject classifications with AAT IDs when available"],
  "tags": ["Array of ~20 searchable tags covering objects, people, activities, time, place, style, mood, etc."]
}

DESCRIPTION GUIDELINES:
- Act like a knowledgeable tour guide or historian
- Use visual evidence to determine context (clothing styles, car models, architecture, photo quality)
- For landmarks/monuments: explain who built it, when, why, and its historical significance
- For ordinary scenes: describe the era, social context, and what this represents culturally
- Combine what you see with why it matters historically
- Be specific about identifiable locations, time periods, and cultural significance
- For family photos or scenes with no historical significance, focus on era indicators and social context

EXAMPLES:
- Menorah sculpture → Identify it as the Knesset Menorah, explain Benno Elkan created it, British Parliament gifted it in 1956, describe its location and significance
- Family photo → "Family gathering from the 1970s based on clothing and photo quality, representing the era when color photography became accessible to middle-class families"
- Street scene → Use cars, architecture, clothing to date it and explain what this area/era represents historically

Guidelines:
- Use standardized geographic names (Getty TGN preferred)
- Include all location levels in both location field and tags
- Use professional subject terms (Getty AAT preferred)
- Generate ~20 tags for optimal search coverage
- Tags should include: specific objects/brands, general subjects, activities, time period, locations, style/mood
- **People identification**: If you can clearly identify specific historical figures, celebrities, politicians, or notable people, include them in both people_identified field and tags
- Use format like "Nelson Mandela (definite)" or "Elvis Presley (probable)" for people_identified
- Include identified people's names directly in tags (e.g., "Nelson Mandela", "John F. Kennedy")
- Use consistent capitalization and spelling`;

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

export async function analyzePhoto(photoUrl) {
    const openai = new OpenAI({
        apiKey: openaiApiKey.value(),
    });

    try {
        const response = await openai.chat.completions.create({
            model: AI_CONFIG.MODEL,
            messages: [
                {
                    role: "system",
                    content: SYSTEM_PROMPT
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: USER_PROMPT
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: photoUrl,
                                detail: AI_CONFIG.DETAIL
                            }
                        }
                    ]
                }
            ],
            temperature: AI_CONFIG.TEMPERATURE,
            max_tokens: AI_CONFIG.MAX_TOKENS,
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(response.choices[0].message.content);
        return validateAndCleanResult(result);

    } catch (error) {
        console.error('Photo analysis failed:', error);
        throw new Error(`Failed to analyze photo: ${error.message}`);
    }
}

export async function moderateImage(imageUrl) {
    const client = new vision.ImageAnnotatorClient();
    console.log(imageUrl);

    try {
        const [result] = await client.safeSearchDetection({
            image: { source: { imageUri: imageUrl } }
        });

        const safeSearch = result.safeSearchAnnotation;

        const likelihoodToScore = {
            'VERY_UNLIKELY': 1,
            'UNLIKELY': 2,
            'POSSIBLE': 3,
            'LIKELY': 4,
            'VERY_LIKELY': 5
        };

        const moderationResult = {
            adult: safeSearch.adult,
            violence: safeSearch.violence,
            racy: safeSearch.racy,
            medical: safeSearch.medical,
            spoof: safeSearch.spoof,
            adultScore: likelihoodToScore[safeSearch.adult] || 1,
            violenceScore: likelihoodToScore[safeSearch.violence] || 1,
            racyScore: likelihoodToScore[safeSearch.racy] || 1,
            isAppropriate: (
                likelihoodToScore[safeSearch.adult] <= 2 &&
                likelihoodToScore[safeSearch.violence] <= 2 &&
                likelihoodToScore[safeSearch.racy] <= 3
            )
        };

        console.log('Image moderation result:', moderationResult);
        return moderationResult;

    } catch (error) {
        console.error('Image moderation failed:', error);
        return {
            adult: 'UNKNOWN',
            violence: 'UNKNOWN',
            racy: 'UNKNOWN',
            medical: 'UNKNOWN',
            spoof: 'UNKNOWN',
            adultScore: 1,
            violenceScore: 1,
            racyScore: 1,
            isAppropriate: false,
            error: error.message
        };
    }
}
