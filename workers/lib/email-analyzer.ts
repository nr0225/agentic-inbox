// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email classification — a planning step that runs before the agent drafts.
 *
 * By classifying intent, urgency, and required key points upfront, the
 * drafting model gets a structured brief rather than a raw email dump.
 * This is a two-phase plan→execute pattern: classify first, act with context.
 */

export type EmailType =
	| "question"        // sender is asking something, expects an answer
	| "action_required" // sender needs the reader to do something specific
	| "request"         // asking for something (info, access, help)
	| "notification"    // FYI, no reply strictly needed
	| "complaint"       // negative sentiment, requires careful handling
	| "introduction"    // first contact / cold outreach
	| "follow_up"       // chasing a prior request or conversation
	| "other";

export type Urgency = "high" | "medium" | "low";

export type ResponseTone = "formal" | "friendly" | "neutral" | "apologetic";

export interface EmailClassification {
	emailType: EmailType;
	urgency: Urgency;
	suggestedTone: ResponseTone;
	responseStrategy: string;
	keyPoints: string[];
}

const CLASSIFY_PROMPT = `Analyze this email and return a JSON object with exactly these fields:
- emailType: one of "question" | "action_required" | "request" | "notification" | "complaint" | "introduction" | "follow_up" | "other"
- urgency: one of "high" | "medium" | "low"
- suggestedTone: one of "formal" | "friendly" | "neutral" | "apologetic"
- responseStrategy: ONE sentence on what the reply should focus on
- keyPoints: array of 2-4 strings, each a concrete point the reply must address

Return ONLY valid JSON. No explanation, no markdown, no wrapper.`;

/**
 * Classify an email to produce a structured brief for drafting.
 * Returns null on any failure so callers can proceed without it.
 */
export async function classifyEmail(
	ai: Ai,
	emailText: string,
	threadContext?: string,
): Promise<EmailClassification | null> {
	const input = threadContext
		? `Thread context:\n${threadContext.slice(0, 1500)}\n\nLatest email:\n${emailText.slice(0, 1500)}`
		: emailText.slice(0, 2000);

	try {
		const res = (await ai.run(
			// @ts-expect-error — model string not in generated union
			"@cf/meta/llama-4-scout-17b-16e-instruct",
			{
				messages: [
					{ role: "system", content: CLASSIFY_PROMPT },
					{ role: "user", content: input },
				],
				max_tokens: 512,
				temperature: 0,
			},
		)) as { response?: string };

		const raw = (res?.response ?? "").trim();
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;

		const parsed = JSON.parse(jsonMatch[0]) as EmailClassification;
		if (!parsed.emailType || !parsed.urgency || !parsed.responseStrategy) return null;

		return parsed;
	} catch {
		return null;
	}
}

/**
 * Format a classification into a prompt-ready brief for the drafting model.
 */
export function formatClassification(c: EmailClassification): string {
	const lines = [`[Email Analysis]`];
	lines.push(`Type: ${c.emailType} | Urgency: ${c.urgency} | Tone: ${c.suggestedTone}`);
	lines.push(`Strategy: ${c.responseStrategy}`);
	if (c.keyPoints?.length) {
		lines.push(`Key points to address:`);
		c.keyPoints.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
	}
	return lines.join("\n");
}
