const { GoogleGenerativeAI } = require("@google/generative-ai");

async function testKey() {
    const key = "AIzaSyDjCdjVFnlbgMWSnpMDdGjA_NOmuyaVnV8";
    console.log(`Testing Key: ${key}`);

    const genAI = new GoogleGenerativeAI(key);
    const models = ["gemini-1.5-flash", "gemini-pro"];

    for (const modelName of models) {
        process.stdout.write(`Testing ${modelName}... `);
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent("Hello");
            const response = result.response.text();
            console.log(`✅ WORKING!`);
            return;
        } catch (e) {
            console.log(`❌ FAILED: ${e.message.split('[')[0]}`);
        }
    }
}

testKey();
