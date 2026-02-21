export function generateSearchKeywords(postData) {
    const keywords = new Set();

    const cleanAndSplit = (text) => {
        if (!text || typeof text !== 'string') return [];
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 1);
    };

    const addArrayTerms = (arr) => {
        if (Array.isArray(arr)) {
            arr.forEach(item => {
                if (typeof item === 'string') {
                    cleanAndSplit(item).forEach(word => keywords.add(word));
                }
            });
        }
    };

    if (postData.description) {
        cleanAndSplit(postData.description).forEach(word => keywords.add(word));
    }

    addArrayTerms(postData.tags);

    if (Array.isArray(postData.year)) {
        postData.year.forEach(y => {
            if (typeof y === 'number') {
                keywords.add(y.toString());
            }
        });
    }

    if (postData.AiMetadata && typeof postData.AiMetadata === 'object') {
        const ai = postData.AiMetadata;

        if (ai.description) {
            cleanAndSplit(ai.description).forEach(word => keywords.add(word));
        }

        if (ai.cultural_context) {
            cleanAndSplit(ai.cultural_context).forEach(word => keywords.add(word));
        }

        if (ai.historical_period) {
            cleanAndSplit(ai.historical_period).forEach(word => keywords.add(word));
        }

        addArrayTerms(ai.geographic_terms);
        addArrayTerms(ai.subject_terms);
        addArrayTerms(ai.tags);

        if (Array.isArray(ai.people_identified)) {
            ai.people_identified.forEach(person => {
                if (typeof person === 'string') {
                    const cleanName = person.replace(/\s*\([^)]*\)\s*/g, '');
                    cleanAndSplit(cleanName).forEach(word => keywords.add(word));
                }
            });
        }

        if (ai.date_estimate) {
            cleanAndSplit(ai.date_estimate).forEach(word => keywords.add(word));
        }

        if (ai.location) {
            cleanAndSplit(ai.location).forEach(word => keywords.add(word));
        }
    }

    return Array.from(keywords).sort();
}

export function calculateRelevanceScore(postData, searchTerms) {
    let score = 0;
    const keywords = postData.searchKeywords || [];

    searchTerms.forEach(term => {
        if (postData.description && postData.description.toLowerCase().includes(term)) {
            score += 10;
        }

        if (postData.tags && postData.tags.some(tag => tag.toLowerCase().includes(term))) {
            score += 8;
        }

        if (postData.AiMetadata?.tags && postData.AiMetadata.tags.some(tag => tag.toLowerCase().includes(term))) {
            score += 7;
        }

        if (postData.AiMetadata?.subject_terms && postData.AiMetadata.subject_terms.some(subject => subject.toLowerCase().includes(term))) {
            score += 6;
        }

        if (postData.AiMetadata?.geographic_terms && postData.AiMetadata.geographic_terms.some(geo => geo.toLowerCase().includes(term))) {
            score += 5;
        }

        if (keywords.some(keyword => keyword.includes(term))) {
            score += 1;
        }
    });

    score += (postData.likesCount || 0) * 0.1;
    score += (postData.commentsCount || 0) * 0.2;

    return score;
}
