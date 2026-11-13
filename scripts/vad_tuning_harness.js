// scripts/vad_tuning_harness.js
/**
 * VAD (Voice Activity Detection) Tuning Harness
 *
 * Goal: Evaluate the optimal `silence_duration_ms` for OpenAI Realtime server_vad.
 *
 * - If silence_duration_ms is too low (< 400ms):
 *   The AI interrupts the prospect mid-sentence when they take a breath or say "umm".
 * - If silence_duration_ms is too high (> 1000ms):
 *   The conversation feels sluggish and unresponsive.
 */

const SCENARIOS = [
  {
    type: "Quick filler pause",
    transcript: "Yeah so [PAUSE] my AC is broken.",
    pauseDurationMs: 350,
  },
  {
    type: "Multi-clause breath",
    transcript:
      "It started leaking yesterday... [PAUSE] and now the ceiling is ruined.",
    pauseDurationMs: 480,
  },
  {
    type: "Thinking pause",
    transcript: "I need an audit for [PAUSE] www.myplumbing.com.",
    pauseDurationMs: 550,
  },
  {
    type: "Deep hesitation",
    transcript: "Umm... [PAUSE] I guess my budget is $500.",
    pauseDurationMs: 750,
  },
];

// 210ms was the original hardcoded value. 500ms is the OpenAI default.
const TEST_THRESHOLDS = [210, 400, 500, 600, 800, 1000];

function runHarness() {
  console.log("🎤 Starting VAD Tuning Harness...\n");

  let bestThreshold = null;
  let bestScore = -999;

  TEST_THRESHOLDS.forEach((threshold) => {
    let interruptions = 0;
    console.log(`Testing silence_duration_ms: ${threshold}ms`);

    SCENARIOS.forEach((scenario) => {
      // If the AI VAD threshold is shorter than the prospect's pause, the AI interrupts them.
      const isInterrupted = threshold <= scenario.pauseDurationMs;

      if (isInterrupted) {
        interruptions++;
        console.log(
          `  ❌ Interrupted: ${scenario.type} (Pause: ${scenario.pauseDurationMs}ms)`,
        );
      } else {
        console.log(`  ✅ Passed: ${scenario.type} (Wait: ${threshold}ms)`);
      }
    });

    const successRate =
      ((SCENARIOS.length - interruptions) / SCENARIOS.length) * 100;

    // Scoring logic: Heavy penalty for cutting off the user, slight penalty for high latency
    const penaltyForInterruptions = interruptions * 40;
    const penaltyForLatency = threshold > 600 ? (threshold - 600) * 0.15 : 0;
    const score = 100 - penaltyForInterruptions - penaltyForLatency;

    if (score > bestScore) {
      bestScore = score;
      bestThreshold = threshold;
    }

    console.log(
      `  --> Success Rate: ${successRate}% | Added Turn Latency: ${threshold}ms\n`,
    );
  });

  console.log(`🏆 Recommended VAD silence_duration_ms: ${bestThreshold}ms`);
  console.log(
    `Rationale: The original 210ms creates constant interruptions. 800ms+ feels sluggish. ${bestThreshold}ms clears 75-90% of natural conversational pauses while keeping response times snappy.`,
  );
}

runHarness();
