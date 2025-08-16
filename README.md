# 📸 Echoes Backend

> AI-Powered Historical Photo Sharing Platform Backend

[![Firebase Functions](https://img.shields.io/badge/Firebase-Functions-orange?logo=firebase)](https://firebase.google.com/docs/functions)
[![Node.js](https://img.shields.io/badge/Node.js-22-green?logo=node.js)](https://nodejs.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4%20Vision-blue?logo=openai)](https://openai.com/)
[![Firestore](https://img.shields.io/badge/Firestore-NoSQL-yellow?logo=firebase)](https://firebase.google.com/docs/firestore)

Echoes is a next-generation social media platform that transforms historical photo sharing through AI-powered analysis. Every uploaded photo is analyzed by GPT-4 Vision acting as an expert historian, extracting rich metadata including date estimates, location identification, cultural context, and historical significance.

## 🌟 Key Features

- **🤖 AI Historian**: GPT-4 Vision analyzes photos like a professional archivist
- **📅 Historical Dating**: Automatic period estimation using visual clues
- **🗺️ Smart Geolocation**: Landmark and location identification
- **🔍 Intelligent Search**: Multi-dimensional search across content and AI metadata
- **👥 Social Discovery**: Community-driven historical content curation
- **⚡ Real-time Interactions**: Likes, comments, bookmarks with live updates

## 🏗️ Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   📱 Client     │────│   🌐 Firebase   │────│   🤖 OpenAI     │
│   React App     │    │   Cloud Func    │    │   GPT-4 Vision  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                       ┌─────────────────┐
                       │   🗄️ Firestore  │
                       │   Database      │
                       └─────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Runtime** | Node.js 22 | Modern ES modules, performance |
| **Platform** | Firebase Functions | Serverless compute, auto-scaling |
| **Database** | Firestore | NoSQL, real-time, scalable |
| **Authentication** | Firebase Auth | Secure user management |
| **AI Engine** | OpenAI GPT-4 Vision | Photo analysis, metadata generation |

## 🚀 Getting Started

### Prerequisites

- Node.js 22+
- Firebase CLI
- OpenAI API Key
- Google Cloud Project with Firebase enabled

### Local Development Setup

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd echoes-backend
   npm install
   cd functions && npm install
   ```

2. **Environment Configuration**
   ```bash
   # Create functions/.env
   OPENAI_API_KEY=your_openai_api_key_here
   ```

3. **Firebase Setup**
   ```bash
   firebase login
   firebase use echoes-677  # or your project ID
   ```

4. **Start Local Development**
   ```bash
   firebase emulators:start
   ```
   
   Emulators will be available at:
   - Functions: http://localhost:5001
   - Firestore: http://localhost:8080
   - Auth: http://localhost:9099
   - UI: http://localhost:4000

### Deployment

```bash
# Deploy to production
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:apiGateway
```

## 📡 API Reference

### Base URL
- **Production**: `https://us-central1-echoes-677.cloudfunctions.net/apiGateway`
- **Local**: `http://localhost:5001/echoes-677/us-central1/apiGateway`

### Authentication
All requests require Firebase Auth token in the Authorization header:
```
Authorization: Bearer <firebase-auth-token>
```

### Request Format
```javascript
{
  "action": "actionName",
  "payload": {
    // action-specific parameters
  }
}
```

### Core Actions

#### Content Management
```javascript
// Create a new post
{
  "action": "createPost",
  "payload": {
    "description": "Amazing historical photo",
    "type": "photo",
    "fileUrls": ["https://..."],
    "location": { "_lat": 40.7128, "_long": -74.0060 },
    "year": [1960]
  }
}

// Get user's posts
{
  "action": "getUserPosts",
  "payload": {
    "profileUserId": "userId", // optional, defaults to current user
    "limit": 10,
    "lastPostId": null
  }
}

// Delete a post
{
  "action": "deletePost",
  "payload": {
    "postId": "postId"
  }
}
```

#### Social Features
```javascript
// Follow/Unfollow user
{
  "action": "followUser", // or "unfollowUser"
  "payload": {
    "targetUserId": "userId"
  }
}

// Get user profile
{
  "action": "getProfile",
  "payload": {
    "profileUserId": "userId" // optional
  }
}

// Get followers list
{
  "action": "getFollowersList",
  "payload": {
    "profileUserId": "userId",
    "limit": 50,
    "lastUserId": null
  }
}
```

#### Content Discovery
```javascript
// Search posts
{
  "action": "searchPosts",
  "payload": {
    "query": "vintage cars 1950s",
    "limit": 20,
    "lastPostId": null
  }
}

// Search users
{
  "action": "searchUsers",
  "payload": {
    "query": "john",
    "limit": 10
  }
}

// Get posts by location
{
  "action": "getPostsByLocation",
  "payload": {
    "center": { "lat": 40.7128, "lng": -74.0060 },
    "radiusKm": 10,
    "limit": 50
  }
}
```

#### Engagement
```javascript
// Like/Unlike post
{
  "action": "likePost",
  "payload": {
    "postId": "postId"
  }
}

// Bookmark/Unbookmark post
{
  "action": "toggleBookmark",
  "payload": {
    "postId": "postId"
  }
}

// Add comment
{
  "action": "addComment",
  "payload": {
    "postId": "postId",
    "text": "Great historical insight!"
  }
}
```

## 🤖 AI Analysis System

### Photo Analysis Pipeline

When users upload photos, the system automatically:

1. **Content Type Detection**: Identifies photo, video, document, or item
2. **GPT-4 Vision Analysis**: Sends image to OpenAI with historian prompt
3. **Metadata Extraction**: Processes AI response into structured data
4. **Keyword Generation**: Creates searchable terms from all metadata
5. **Search Indexing**: Stores keywords for efficient discovery

### AI Metadata Structure

```javascript
{
  "AiMetadata": {
    // Core Analysis
    "description": "Family gathering from the 1970s based on clothing and photo quality...",
    "date_estimate": "1970s",
    "date_confidence": "probable",
    "location": "Suburban home, United States",
    "location_confidence": "possible",
    
    // Historical Context
    "historical_period": "Post-Vietnam War Era",
    "cultural_context": "American suburban family life",
    
    // Controlled Vocabularies
    "geographic_terms": ["United States", "Suburban"],
    "subject_terms": ["Family photography", "Domestic life", "Color photography"],
    
    // Identification
    "people_identified": [], // Only for recognizable historical figures
    
    // Search Optimization
    "tags": ["1970s", "family", "color", "suburban", "domestic", "gathering", ...]
  }
}
```

### Search Capabilities

The AI-enhanced search system enables queries like:
- `"vintage cars 1950s"` → Finds cars from the 1950s
- `"New York street photography"` → Urban scenes from NYC
- `"World War II uniforms"` → Military content from WWII era
- `"Victorian architecture London"` → Building styles and locations

## 🗄️ Database Schema

### Collections Structure

```
firestore/
├── users/
│   ├── {userId}/
│   │   ├── displayName: string
│   │   ├── profilePictureUrl: string
│   │   ├── followersCount: number
│   │   ├── followingCount: number
│   │   ├── postsCount: number
│   │   └── subcollections/
│   │       ├── followers/
│   │       ├── following/
│   │       └── bookmarks/
│   └── ...
└── posts/
    ├── {postId}/
    │   ├── userId: string
    │   ├── description: string
    │   ├── type: enum
    │   ├── files: string[]
    │   ├── location: GeoPoint
    │   ├── year: number[]
    │   ├── AiMetadata: object
    │   ├── searchKeywords: string[]
    │   └── subcollections/
    │       ├── likes/
    │       └── comments/
    └── ...
```

### Key Design Decisions

- **Denormalization**: User data stored with posts for efficient feed rendering
- **Subcollections**: Scalable relationships and interactions
- **Pre-computed Fields**: Search keywords and counts cached for performance
- **GeoPoints**: Native geographic querying support

## ⚡ Performance & Scalability

### Rate Limiting

| Action Type | Limit | Window | Purpose |
|-------------|-------|---------|---------|
| Content Creation | 5/hour | Prevent spam |
| Social Actions | 50-100/hour | Normal usage |
| Read Operations | 200-500/hour | High throughput |
| Search Queries | 50-100/hour | Resource management |

### Optimization Strategies

- **Firestore Transactions**: Atomic operations for consistency
- **Cursor Pagination**: Efficient large dataset handling
- **Query Optimization**: Strategic indexing and denormalization
- **Memory Management**: Automatic cleanup of rate limit data

## 🔐 Security

### Authentication & Authorization
- **Firebase Auth**: JWT token validation on every request
- **Resource Ownership**: Users can only modify their own content
- **Privacy Controls**: Followers/following lists are private
- **Input Validation**: Comprehensive parameter checking

### Data Protection
- **Rate Limiting**: Prevents abuse and DoS attacks
- **Error Sanitization**: No sensitive data in error messages
- **Content Validation**: File type and size restrictions
- **Geographic Bounds**: Location coordinate validation

## 📊 Monitoring & Analytics

### Key Metrics
- **API Response Times**: Target <200ms for read operations
- **AI Processing Success**: Photo analysis completion rates
- **Search Relevance**: User engagement with search results
- **Error Rates**: Target <1% across all operations

### Logging Strategy
```javascript
{
  timestamp: "2025-01-XX",
  userId: "user123",
  action: "searchPosts",
  query: "vintage cars",
  resultsCount: 25,
  executionTime: "150ms",
  success: true
}
```

## 🛠️ Development

### Project Structure
```
echoes-backend/
├── functions/
│   ├── index.js              # Main API Gateway
│   ├── middleware/
│   │   └── rateLimiter.js    # Rate limiting system
│   ├── utils/
│   │   └── constants.js      # Configuration constants
│   └── package.json          # Function dependencies
├── firebase.json             # Firebase configuration
├── .firebaserc              # Project settings
└── README.md                # This file
```

### Code Style
- **ES Modules**: Modern JavaScript imports/exports
- **Async/Await**: Promise-based asynchronous programming
- **Error Handling**: Structured Firebase Functions errors
- **Transaction Safety**: Firestore transactions for critical operations

### Testing
```bash
# Run local tests
cd functions
npm test

# Integration testing with emulators
firebase emulators:exec "npm test" --only functions,firestore
```

## 🚨 Error Handling

### Error Types
- `unauthenticated`: User not logged in
- `permission-denied`: Access forbidden
- `invalid-argument`: Bad request parameters
- `not-found`: Resource doesn't exist
- `resource-exhausted`: Rate limit exceeded
- `internal`: Server error

### Example Error Response
```javascript
{
  "error": {
    "code": "invalid-argument",
    "message": "Post description cannot exceed 5000 characters"
  }
}
```

## 🔮 Roadmap

### Planned Features
- **Video Analysis**: Historical video content processing
- **Real-time Notifications**: Live updates for social interactions
- **Content Moderation**: AI-powered safety and quality checks
- **Multi-language Support**: Global historical content
- **Advanced Analytics**: User behavior and content insights

### Scalability Improvements
- **Caching Layer**: Redis for frequently accessed data
- **Database Sharding**: Geographic and temporal data distribution
- **CDN Integration**: Global content delivery
- **Background Processing**: Queue system for heavy AI operations

## 📞 Support

### Resources
- **Firebase Documentation**: https://firebase.google.com/docs
- **OpenAI API Reference**: https://platform.openai.com/docs
- **Firestore Best Practices**: https://firebase.google.com/docs/firestore/best-practices

### Contributing
1. Fork the repository
2. Create a feature branch
3. Implement changes with tests
4. Submit a pull request

### Issues
For bug reports and feature requests, please use the GitHub issue tracker.

---

**Built with ❤️ for preserving and sharing historical moments**

*Echoes Backend - Where AI meets history*
