// scripts/voice_qa_harness.js
/**
 * Voice QA & Pronunciation Harness
 *
 * Goal: Generate standardized MP3 recordings of available voices
 * reading CloseDesk-specific terminology, CRM names, and trade scenarios.
 *
 * Run via: node scripts/voice_qa_harness.js
 * Note: Requires OPENAI_API_KEY in your environment variables.
 */

const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// OpenAI Realtime/TTS available voices
const VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
];

const TEST_SCRIPTS = [
  {
    id: "intro",
    text: "Hi there! I am the AI Front Desk for CloseDesk, powered by Aicyro.",
  },
  {
    id: "crms",
    text: "We seamlessly integrate with GoHighLevel, HubSpot, Zapier, and Salesforce via Webhooks.",
  },
  {
    id: "trades",
    text: "Whether you need HVAC maintenance, plumbing repairs, or electrical work, I can get you scheduled.",
  },
  {
    id: "pricing",
    text: "The Starter plan is 97 dollars a month, and the Pro plan is 297 dollars a month.",
  },
];

async function generateVoiceSamples() {
  if (!OPENAI_API_KEY) {
    console.error("❌ ERROR: OPENAI_API_KEY environment variable is missing.");
    process.exit(1);
  }

  const outputDir = path.join(
    __dirname,
    "..",
    "evaluations",
    "voice_qa_recordings",
  );
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("🎙️ Starting Voice QA Generation...\n");

  for (const voice of VOICES) {
    console.log(`Processing voice: [${voice}]...`);

    for (const script of TEST_SCRIPTS) {
      try {
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "tts-1",
            voice: voice,
            input: script.text,
          }),
        });

        if (!response.ok) {
          throw new Error(
            `API Error: ${response.status} ${response.statusText}`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const filePath = path.join(outputDir, `${voice}_${script.id}.mp3`);

        fs.writeFileSync(filePath, buffer);
        console.log(`  ✅ Saved: ${voice}_${script.id}.mp3`);
      } catch (err) {
        console.error(
          `  ❌ Failed to generate ${script.id} for ${voice}:`,
          err.message,
        );
      }
    }
    console.log("---");
  }

  console.log(`\n🎉 QA generation complete. Recordings saved to: ${outputDir}`);
  console.log(
    "Please review the recordings for Aicyro/CloseDesk pronunciation and document the final choice.",
  );
}

generateVoiceSamples();
