const axios = require("axios");
const cheerio = require("cheerio");

/**
 * Basic scraper to fetch some health-related context from Wikipedia.
 * Note: Real medical sites often block scrapers (Cloudflare, etc.).
 */
async function scrapeHealthData(query) {
    if (!query) return "No data provided.";
    
    try {
        // We'll search Wikipedia to get a quick summary
        const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            },
            timeout: 5000 // 5 seconds max
        });
        
        const $ = cheerio.load(data);
        // Get the first real paragraph of content
        const firstParagraph = $('#mw-content-text .mw-parser-output > p')
            .not('.mw-empty-elt')
            .first()
            .text();
            
        return firstParagraph.trim() || "No detailed information found.";
    } catch (err) {
        console.error("Scraper error for query:", query, "->", err.message);
        return "Could not retrieve additional health context at this time.";
    }
}

module.exports = scrapeHealthData;