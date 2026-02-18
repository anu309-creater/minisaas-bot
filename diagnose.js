const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

console.log("--- DIAGNOSTIC START ---");

// 1. Check Settings File
if (!fs.existsSync('settings.json')) {
    console.log("❌ settings.json NOT FOUND!");
} else {
    try {
        const content = fs.readFileSync('settings.json', 'utf8');
        const settings = JSON.parse(content);

        if (settings.apiKey) {
            console.log(`✅ settings.json loaded.`);
            // Show start and end of key to verify update without showing full key
            const key = settings.apiKey;
            console.log(`🔑 Key in file: ${key.substring(0, 10)}...${key.substring(key.length - 5)}`);

            // 2. Test Key
            testGenAI(key);
        } else {
            console.log("❌ 'apiKey' is missing or empty in settings.json");
        }
    } catch (e) {
        console.log("❌ settings.json is Invalid JSON:", e.message);
    }
}

async function testGenAI(key) {
    const genAI = new GoogleGenerativeAI(key);
    console.log("\nTesting Model: gemini-1.5-flash");
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("Say 'Hello'");
        console.log(`✅ SUCCESS! Response: ${result.response.text()}`);
    } catch (e) {
        console.log(`❌ FAIL: ${e.message.split('[')[0]}`);
        if (e.message.includes('404')) console.log("   -> Model not enabled or Project issue.");
        if (e.message.includes('400')) console.log("   -> Key Invalid/Expired.");
    }
}
