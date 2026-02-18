const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');

async function testAllModels() {
    let settings = {};
    if (fs.existsSync('settings.json')) {
        try {
            settings = JSON.parse(fs.readFileSync('settings.json'));
        } catch (e) {
            console.error("❌ settings.json is invalid JSON");
            return;
        }
    }

    if (!settings.apiKey) {
        console.log("❌ No API Key found");
        return;
    }

    console.log(`Checking API Key: ${settings.apiKey.substring(0, 5)}...`);
    const genAI = new GoogleGenerativeAI(settings.apiKey);

    const models = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro", "gemini-1.0-pro"];

    console.log("\n--- Testing Models ---");

    for (const modelName of models) {
        process.stdout.write(`Testing ${modelName}... `);
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent("Hello");
            const response = result.response.text();
            if (response) {
                console.log(`✅ WORKING!`);
                console.log(`   Response: ${response.substring(0, 20)}...`);
                return; // We found a working one!
            }
        } catch (e) {
            console.log(`❌ FAILED`);
            console.log(`   Reason: ${e.message.split('[')[0].trim()}`); // Clean error
            if (e.message.includes('404')) console.log("   (Model not found or not enabled)");
            if (e.message.includes('400')) console.log("   (Bad Request / Expired / Invalid)");
        }
    }

    console.log("\n❌ NO WORKING MODELS FOUND.");
    console.log("Please generate a new API Key from https://aistudio.google.com/");
}

testAllModels();
