# Brand Collaboration Finder - Requirements & Execution Plan

## Project Overview
An AI-powered tool that discovers complementary brands and products for collaboration opportunities. Users input a merchant URL, and the system identifies potential bundle partners across direct competitors, adjacent categories, and non-obvious complementary services.

---

## Core Features

### 1. URL Input & Analysis
- Large, centered AI search input box (Shop.app inspired)
- Accept any merchant/brand website URL
- Validate URL format before submission
- Retain entered URL after submission for easy modification
- Loading state with engaging animation during AI analysis
- **Search history dropdown** appears when input is focused (pre-search)

### 2. AI-Powered Discovery Engine

#### Model Selection: Research-Focused AI
**Primary consideration**: Gemini or Claude models optimized for web research and search.

| Model | Strengths | Consideration |
|-------|-----------|---------------|
| **Gemini 2.0 Flash** | Built-in Google Search grounding, fast, cost-effective | Best for real-time web research |
| **Gemini 1.5 Pro** | Larger context, deeper reasoning | Better for complex analysis |
| **Claude 3.5 Sonnet** | Strong reasoning, nuanced understanding | Needs external search integration |
| **Claude + Web Search** | Claude reasoning + real-time data | Hybrid approach |

**Recommendation**: Start with **Gemini 2.0 Flash** with Google Search grounding for real-time brand discovery, with Claude as fallback for deeper analysis if needed.

#### Discovery Categories
The system should identify **10-15 complementary results** split into two groups:

**Group 1: Brands (5-8 results)**
- Direct competitors sharing target audience
- Adjacent lifestyle brands
- Non-obvious complementary brands (including digital/services)

**Group 2: Specific Products (5-7 results)**
- Specific bestselling products from complementary brands
- Include product name, brand, and product page URL
- Mix of physical products and digital offerings

### 3. Results Display

#### Two-Section Layout
```
┌─────────────────────────────────────────┐
│  🏢 Complementary Brands                │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│  │Brand│ │Brand│ │Brand│ │Brand│  ...  │
│  └─────┘ └─────┘ └─────┘ └─────┘       │
├─────────────────────────────────────────┤
│  📦 Complementary Products              │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│  │Prod │ │Prod │ │Prod │ │Prod │  ...  │
│  └─────┘ └─────┘ └─────┘ └─────┘       │
└─────────────────────────────────────────┘
```

#### Card Components

**Brand Card:**
```
┌──────────────────────────────────┐
│ [Favicon]  Brand Name      [···] │
│            brandurl.com          │
│ "Brief reason for fit"           │
└──────────────────────────────────┘
```

**Product Card:**
```
┌──────────────────────────────────┐
│ [Favicon]  Product Name    [···] │
│            by Brand Name         │
│            producturl.com        │
└──────────────────────────────────┘
```

#### Card Interactions
- **Click card**: Opens URL in new browser tab
- **Click ··· menu**: Opens popover with social media links

### 4. Three-Dot Menu (···) Popover
When user clicks ··· on any result card:
```
┌─────────────────────┐
│ 📱 TikTok          │ → opens tiktok.com/@brand
│ 📸 Instagram       │ → opens instagram.com/brand
│ 📘 Facebook        │ → opens facebook.com/brand
└─────────────────────┘
```
- Only show social links that exist for that brand
- Gracefully handle missing social profiles
- AI should attempt to find social handles during discovery

### 5. Search History Dropdown
When user focuses on the search input (before typing/searching):
```
┌────────────────────────────────────────┐
│ Enter brand URL...                     │
├────────────────────────────────────────┤
│ 🕐 Recent Searches                     │
│    lululemon.com                       │
│    nike.com                            │
│    glossier.com                        │
│    allbirds.com                        │
└────────────────────────────────────────┘
```
- Store in Cloudflare D1, shared by everyone on the team
- Show last 5-10 searches
- Click to auto-fill and search
- Clear history option

### 6. Feedback System
After results load, show feedback prompt:
```
┌─────────────────────────────────────────┐
│  How relevant were these results?       │
│                                         │
│     [👍]     [👎]                       │
│                                         │
└─────────────────────────────────────────┘
```

**Feedback Loop Integration:**
- Store feedback with: URL searched, results returned, rating, timestamp
- Send feedback data to AI context for future queries
- Build a feedback corpus that improves prompt engineering
- Track patterns: which brand types get 👍 vs 👎
- Use aggregated feedback to refine discovery prompts

**Feedback Data Structure:**
```json
{
  "searchId": "uuid",
  "inputUrl": "lululemon.com",
  "timestamp": "2024-01-15T10:30:00Z",
  "results": [...],
  "rating": "positive|negative",
  "feedbackNote": "optional user comment"
}
```

### 7. Empty State
- Playful, modern "no results" UI
- Friendly messaging encouraging URL modification
- Animated illustration or icon
- Clear CTA to try again

### 8. Ambient Brand Showcase (Landing Page)
- Floating brand tiles with real brand logos/product imagery
- Organic right-to-left drift animation
- Modern box shadows with hover transitions
- Creates aspirational mood while idle

**Brand imagery source**: User to provide

---

## UI/UX Design Specifications

### Layout (Shop.app Inspired)
```
┌─────────────────────────────────────────────────────────┐
│  [Logo]                                                 │
│                                                         │
│         ┌──────────────────────────────────┐           │
│  [tile] │                                  │ [tile]    │
│         │      Brand Collab Finder         │           │
│ [tile]  │                                  │   [tile]  │
│         │  ┌────────────────────────────┐  │           │
│  [tile] │  │ Enter any brand URL...  🔍 │  │ [tile]   │
│         │  └────────────────────────────┘  │           │
│ [tile]  │      🕐 Recent searches...       │   [tile]  │
│         └──────────────────────────────────┘           │
│  [tile]                                        [tile]  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Results State Layout
```
┌─────────────────────────────────────────────────────────┐
│  [Logo]                              [New Search]       │
│                                                         │
│  ┌────────────────────────────────────────────────┐    │
│  │ lululemon.com                              🔍  │    │
│  └────────────────────────────────────────────────┘    │
│                                                         │
│  🏢 Complementary Brands                               │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │
│  │ Alo    │ │ Vuori  │ │Outdoor │ │ Hydro  │  →       │
│  │ Yoga   │ │        │ │ Voices │ │ Flask  │          │
│  │  [···] │ │  [···] │ │  [···] │ │  [···] │          │
│  └────────┘ └────────┘ └────────┘ └────────┘          │
│                                                         │
│  📦 Complementary Products                             │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │
│  │Manduka │ │Peloton │ │Athletic│ │Lululem │  →       │
│  │Pro Mat │ │ App+   │ │Greens  │ │ Mirror │          │
│  │  [···] │ │  [···] │ │  [···] │ │  [···] │          │
│  └────────┘ └────────┘ └────────┘ └────────┘          │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  How relevant were these results?  [👍]  [👎]  │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Color Palette
- Background: Light gray/off-white (#F5F5F7)
- Primary accent: Purple/violet (#5C5CFF or similar to Shop.app)
- Cards: White with subtle shadows
- Text: Dark gray (#1D1D1F)
- Success/Positive: Soft green
- Feedback highlight: Subtle pulse animation

### Typography
- Clean sans-serif (Inter, SF Pro, or similar)
- Large, bold heading for main title
- Medium weight for input placeholder
- Regular weight for results

### Animations
- **Floating tiles**: Slow, organic drift (CSS keyframes)
- **Box shadows**: Subtle transitions on hover
- **Loading state**: Pulsing dots or skeleton cards
- **Results appear**: Staggered fade-in animation
- **Feedback**: Subtle thank-you animation after rating

---

## Technical Architecture

### Frontend Stack
- **SvelteKit (Svelte 5)** on a Cloudflare Worker with static assets; see `DEPLOYMENT.md`
- **CSS3** - Modern animations, flexbox/grid, custom properties (`src/lib/styles/styles.css`)
- **Fetch API** - For AI service calls, through the Worker's `/api/*` proxies
- **Cloudflare D1** - Searches, crawled catalogs, search history & feedback persistence

### AI Integration

#### Primary: Gemini 2.0 Flash with Search Grounding
```javascript
// Gemini API with Google Search grounding
const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-goog-api-key': API_KEY
  },
  body: JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }]  // Enable search grounding
  })
});
```

#### Fallback: Claude with Web Search
- Use Claude 3.5 Sonnet for deeper analysis
- Integrate with external search API if needed

### Data Flow
```
User Input URL
     ↓
Validate & Normalize URL
     ↓
Add to Search History (D1)
     ↓
Send to Gemini API with Search Grounding
     ↓
Parse Response → Brands[] + Products[]
     ↓
Fetch Favicons + Social Links
     ↓
Render Results (2 sections)
     ↓
Collect Feedback → Store & Learn
```

### File Structure
```
brand-collab-finder/
├── index.html              # Main application
├── styles.css              # All styling
├── app.js                  # Application logic
├── modules/
│   ├── ai-service.js       # AI API integration
│   ├── search-history.js   # D1-backed history
│   ├── feedback.js         # Feedback collection & learning
│   └── social-links.js     # Social media URL discovery
├── assets/
│   ├── brands/             # Real brand images for floating tiles
│   └── icons/              # UI icons (social media, etc.)
├── data/
│   └── feedback-corpus.json # Aggregated feedback for learning
└── REQUIREMENTS.md         # This document
```

### Favicon Fetching Strategy
- Primary: `https://www.google.com/s2/favicons?domain=example.com&sz=64`
- Fallback: `https://icons.duckduckgo.com/ip3/example.com.ico`
- Default placeholder icon if both fail

### Social Media Link Discovery
AI should return social handles when available. Fallback strategies:
1. Common URL patterns: `instagram.com/{brand}`, `tiktok.com/@{brand}`
2. Scrape from brand's website footer (if accessible)
3. Use known database/API for brand social profiles

---

## AI Prompt Engineering

### Discovery Prompt (with Feedback Integration)
```
You are a brand collaboration expert. Given a merchant URL, identify complementary brands and products for potential bundle partnerships.

INPUT URL: {url}

HISTORICAL FEEDBACK (use to improve relevance):
{feedbackSummary}

Return results in two groups:

GROUP 1 - COMPLEMENTARY BRANDS (5-8):
For each brand provide:
- name: Brand name
- url: Website URL
- category: "direct" | "adjacent" | "non-obvious"
- reason: 1 sentence on why it's complementary
- social: { tiktok, instagram, facebook } (handles if known)

GROUP 2 - COMPLEMENTARY PRODUCTS (5-7):
For each product provide:
- productName: Specific product name
- brandName: Brand that makes it
- url: Direct product page URL
- reason: 1 sentence on fit
- social: Brand's social handles if known

Focus on:
- Shared target demographics
- Complementary use cases
- Lifestyle alignment
- Bundle appeal for consumers

Respond in valid JSON format.
```

### Feedback Learning Integration
```javascript
// Build feedback summary for prompt context
function buildFeedbackContext() {
  const feedback = getFeedbackHistory();
  const positive = feedback.filter(f => f.rating === 'positive');
  const negative = feedback.filter(f => f.rating === 'negative');

  return `
    Users responded positively to: ${summarizeBrands(positive)}
    Users responded negatively to: ${summarizeBrands(negative)}
    Optimize for brands similar to positive examples.
  `;
}
```

---

## User Flow

```
1. User lands on page
   └── Sees floating brand tiles animation (real brand logos)
   └── Centered search input prominently displayed

2. User clicks into search input
   └── Search history dropdown appears
   └── Shows recent searches (click to auto-fill)

3. User enters merchant URL (or selects from history)
   └── Input validates URL format
   └── Submit button activates

4. User submits URL
   └── URL added to search history
   └── Loading animation begins
   └── Floating tiles fade slightly
   └── AI processes URL with search grounding

5. Results load (Success)
   └── Two sections appear: Brands & Products
   └── Cards show favicon, name, URL, ··· menu
   └── Input retains URL for modification
   └── Feedback prompt appears at bottom

6. User interacts with results
   └── Click card → Opens URL in new tab
   └── Click ··· → Shows social media links popover
   └── Click social link → Opens in new tab

7. User provides feedback
   └── 👍 or 👎 recorded
   └── Thank you animation
   └── Feedback stored for AI learning

8. No results (Edge case)
   └── Friendly empty state appears
   └── Input still shows original URL
   └── User can modify and retry
```

---

## Execution Plan

### Phase 1: Foundation (Files 1-3)
1. **Create HTML structure**
   - Semantic layout with header, main, results sections
   - Input form with search box
   - Search history dropdown template
   - Results grid containers (brands + products)
   - Card templates with ··· menu
   - Feedback component
   - Empty state template

2. **Build CSS styling**
   - CSS custom properties for theming
   - Responsive layout (mobile-first)
   - Shop.app inspired input styling
   - Card component styles with ··· menu
   - Popover styling for social links
   - Search history dropdown styles
   - Feedback component styles
   - Animation keyframes

3. **Floating brand tiles**
   - Position absolute tiles around edges
   - CSS animation for drift effect
   - Box shadow transitions
   - **Real brand imagery** (awaiting source from user)

### Phase 2: Core Functionality (Steps 4-6)
4. **JavaScript application logic**
   - URL validation
   - Form submission handling
   - State management (loading, results, empty)
   - Results rendering (brands & products sections)
   - Card click → new tab
   - ··· menu popover toggle

5. **Search history module**
   - D1 read/write through store.js
   - Dropdown population
   - Click to search
   - Clear history

6. **AI integration (Gemini 2.0 Flash)**
   - API call with search grounding
   - Prompt construction
   - Response parsing
   - Error handling
   - Fallback to Claude if needed

### Phase 3: Enhanced Features (Steps 7-9)
7. **Social media links**
   - Parse AI response for social handles
   - Build popover content dynamically
   - Handle missing social profiles gracefully

8. **Feedback system**
   - 👍/👎 click handlers
   - D1 persistence
   - Feedback summary builder
   - Inject into AI prompt context
   - Thank you animation

9. **Polish & edge cases**
   - Empty state UI
   - Comprehensive error handling
   - Loading states
   - Mobile responsiveness
   - Performance optimization

---

## Dependencies & Setup

### API Keys Required
- **Gemini API Key**: For primary AI discovery
- **Claude API Key** (optional): For fallback/deeper analysis

### Assets Needed from User
- [ ] Real brand logos/images for floating tiles
- [ ] Any specific brands to feature

---

## Success Metrics
- Results load within 5 seconds
- 10-15 relevant results per query (split brands/products)
- Social links available for 70%+ of results
- All favicons load or show fallback
- Smooth 60fps animations
- Feedback captured for 30%+ of searches
- Works on mobile and desktop

---

## Ready to Build
**Awaiting:**
1. ✅ AI model decision → Gemini 2.0 Flash with search grounding
2. ⏳ Brand logo/image source for floating tiles
3. ✅ Feature scope confirmed

Once brand assets are provided, I'll proceed with Phase 1 implementation.
