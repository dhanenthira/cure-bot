const axios = require("axios");

async function getAIResponse(userMsg, researchData, imageBase64) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error("GEMINI_API_KEY is not set in .env!");
            return "Server configuration error: Gemini API key missing. Please add it to your .env file.";
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        // Build parts array
        let parts = [];

        // If image is provided, add it as inline data
        if (imageBase64) {
            // Extract mime type and base64 data from data URL
            const matches = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
            if (matches) {
                const mimeType = matches[1];
                const base64Data = matches[2];
                parts.push({
                    inline_data: {
                        mime_type: mimeType,
                        data: base64Data
                    }
                });
            } else {
                // If not a data URL, treat as raw base64? Assume jpeg
                parts.push({
                    inline_data: {
                        mime_type: "image/jpeg",
                        data: imageBase64
                    }
                });
            }
        }

        // Add text prompt
        const textPrompt = `Symptoms: ${userMsg || "No text provided"}\nResearch: ${researchData}\nGive simple answer.`;
        parts.push({ text: textPrompt });

        const requestBody = {
            system_instruction: {
                parts: [{ text: "You are a helpful medical assistant. Give safe, short advice with disclaimer." }]
            },
            contents: [{
                parts: parts
            }]
        };

        const response = await axios.post(url, requestBody, {
            headers: { "Content-Type": "application/json" }
        });

        const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
        return text || "No response generated.";

    } catch (err) {
        const errorData = err.response?.data?.error;
        console.error("AI ERROR 👉", errorData || err.message);
        return "AI service not working. Please try later.";
    }
}

module.exports = getAIResponse;