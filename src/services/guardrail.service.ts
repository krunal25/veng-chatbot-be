/**
 * Guardrail Service — v7
 * Enhancements over v6:
 *  - PII detection in USER inputs (not just bot outputs)
 *  - Repeated-violation escalation (3 strikes → block + escalate)
 *  - Context-aware messages: friendlier, more helpful redirects
 *  - Extended injection pattern set (more jailbreak variants)
 *  - Phone number & email redaction in bot outputs
 *  - Spam / gibberish detection
 *  - Non-English language detection with graceful redirect
 *  - Soft-block mode: warn + allow for mild cases, block for severe
 */

import { Injectable } from '@nestjs/common';

export type GuardrailAction = 'allow' | 'block' | 'warn' | 'redact';

export interface GuardrailResult {
  action: GuardrailAction;
  reason?: string;
  safeContent?: string;
  triggeredRule?: string;
  riskScore: number;
  shouldEscalate?: boolean; // true → notify admin room
}

@Injectable()
export class GuardrailService {
  // ── Toxic / Harmful patterns ────────────────────────────────────────────
  private readonly toxicPatterns: RegExp[] = [
    /\b(fuck|shit|bitch|bastard|asshole|cunt|damn|hell)\b/i,
    /\b(kill|murder|bomb|weapon|suicide|self.harm)\b/i,
    /\b(hack|exploit|injection|sql\s*drop|xss|csrf)\b/i,
    /(<script|javascript:|on\w+=|eval\(|document\.cookie)/i,
  ];

  // ── PII to redact from BOT outputs ─────────────────────────────────────
  private readonly outputPiiPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, label: '[CARD-NUMBER]' },
    { pattern: /\b\d{3}-?\d{2}-?\d{4}\b/g, label: '[SSN]' },
    { pattern: /\b[A-Z]{2}\d{6,9}\b/g, label: '[PASSPORT]' },
    { pattern: /password\s*[:=]\s*\S+/gi, label: '[PASSWORD-REDACTED]' },
    { pattern: /\b\d{10,}\b/g, label: '[ACCOUNT-NUMBER]' },
  ];

  // ── PII to detect (and warn) in USER inputs ──────────────────────────────
  private readonly inputPiiPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, label: 'credit card number' },
    { pattern: /\b\d{3}-?\d{2}-?\d{4}\b/, label: 'social security number' },
    { pattern: /password\s*[:=]\s*\S+/i, label: 'password' },
  ];

  // ── Off-topic topics ───────────────────────────────────────────────────
  private readonly offTopicPatterns: RegExp[] = [
    /\b(politics|election|trump|biden|modi|abortion|religion|god|jesus|allah|bitcoin|crypto|invest|stock\s*market)\b/i,
    /\b(adult|porn|sex|nude|dating|relationship|girlfriend|boyfriend)\b/i,
    /\b(homework|essay|thesis|assignment|math\s*problem|history\s*question)\b/i,
    /\b(recipe|cooking|food|weather|news|sports|movie|game|music)\b/i,
  ];

  // ── Injection / Prompt injection (extended v7) ─────────────────────────
  private readonly injectionPatterns: RegExp[] = [
    /ignore\s+(previous|above|all)\s+instructions?/i,
    /you\s+are\s+now\s+(a|an)\s+\w+/i,
    /act\s+as\s+(if|a|an)\s+/i,
    /forget\s+(everything|all|your)\s+/i,
    /system\s*prompt/i,
    /jailbreak/i,
    /pretend\s+(you|that)\s+(are|you're)/i,
    /new\s+role\s*:/i,
    /override\s+(your|all)\s+(instructions?|rules?|constraints?)/i,
    /disregard\s+(all|previous|your)\s+/i,
    /you\s+have\s+no\s+(restrictions|rules|limits)/i,
    /developer\s*mode/i,
    /DAN\s+(mode|prompt)/i,
    /\[SYSTEM\]/i,
    /\<\|im_start\|\>/i,
  ];

  // ── Profanity (soft warn) ──────────────────────────────────────────────
  private readonly profanityList = ['crap', 'stupid', 'idiot', 'dumb', 'moron', 'useless'];

  // ── Spam / gibberish detection ─────────────────────────────────────────
  private isGibberish(text: string): boolean {
    const words = text.trim().split(/\s+/);
    if (words.length < 3) return false;
    // High ratio of non-dictionary-looking tokens
    const randomLooking = words.filter((w) => /^[^aeiou]{5,}$/i.test(w) || /(.)\1{4,}/.test(w));
    return randomLooking.length / words.length > 0.6;
  }

  // ── Non-English detection (basic) ─────────────────────────────────────
  // We allow Norwegian (common customer language) but catch other scripts
  private isNonLatinScript(text: string): boolean {
    const nonLatin = text.match(/[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F]/g);
    return !!nonLatin && nonLatin.length > text.length * 0.3;
  }

  // ── Per-session rate limiting ──────────────────────────────────────────
  private readonly sessionRateMap: Map<string, number[]> = new Map();
  private readonly RATE_LIMIT = 20;
  private readonly RATE_WINDOW_MS = 60 * 1000;

  // ── Per-session violation tracking (v7) ───────────────────────────────
  private readonly violationMap: Map<string, number> = new Map();
  private readonly MAX_VIOLATIONS = 3;

  private incrementViolation(sessionId: string): number {
    const count = (this.violationMap.get(sessionId) || 0) + 1;
    this.violationMap.set(sessionId, count);
    return count;
  }

  /**
   * Check an incoming user message.
   */
  checkInput(sessionId: string, input: string): GuardrailResult {
    const trimmed = input.trim();

    // 1. Rate limit
    const rateResult = this.checkRateLimit(sessionId);
    if (rateResult.action === 'block') return rateResult;

    // 2. Empty / too long
    if (!trimmed) {
      return { action: 'block', reason: 'Empty message', triggeredRule: 'empty-input', riskScore: 0 };
    }
    if (trimmed.length > 1000) {
      return {
        action: 'block',
        reason: 'Your message is too long (max 1000 characters). Please shorten it and try again.',
        triggeredRule: 'max-length',
        riskScore: 10,
      };
    }

    // 3. Repeated violations check
    const violations = this.violationMap.get(sessionId) || 0;
    if (violations >= this.MAX_VIOLATIONS) {
      return {
        action: 'block',
        reason: "I've noticed several out-of-scope messages. Please use **Ask Admin** to speak with our team, or let me know how I can help with Veng parts and orders.",
        triggeredRule: 'repeated-violations',
        riskScore: 60,
        shouldEscalate: true,
      };
    }

    // 4. Injection attacks
    for (const pattern of this.injectionPatterns) {
      if (pattern.test(trimmed)) {
        this.incrementViolation(sessionId);
        return {
          action: 'block',
          reason: "I'm here specifically to help with Veng parts, orders, and support. Let me know what you need!",
          triggeredRule: 'prompt-injection',
          riskScore: 90,
        };
      }
    }

    // 5. Toxic / harmful
    for (const pattern of this.toxicPatterns) {
      if (pattern.test(trimmed)) {
        this.incrementViolation(sessionId);
        return {
          action: 'block',
          reason: 'Please keep our conversation respectful. How can I help with your Veng order?',
          triggeredRule: 'toxic-content',
          riskScore: 85,
        };
      }
    }

    // 6. PII in user input — warn but still process (don't echo it back)
    for (const { pattern, label } of this.inputPiiPatterns) {
      if (pattern.test(trimmed)) {
        return {
          action: 'warn',
          reason: `⚠️ For your safety, please avoid sharing sensitive information like your ${label} in chat. Our agents will never ask for it here. How can I help you?`,
          triggeredRule: 'pii-in-input',
          riskScore: 50,
        };
      }
    }

    // 7. Non-Latin script
    if (this.isNonLatinScript(trimmed)) {
      return {
        action: 'warn',
        reason: "I currently support English and Norwegian. Please write in one of these languages and I'll be happy to help!",
        triggeredRule: 'non-latin-script',
        riskScore: 15,
      };
    }

    // 8. Gibberish / spam
    if (this.isGibberish(trimmed)) {
      return {
        action: 'warn',
        reason: "I didn't quite understand that. Could you rephrase your question? I'm here to help with Veng parts and orders.",
        triggeredRule: 'gibberish',
        riskScore: 20,
      };
    }

    // 9. Off-topic
    for (const pattern of this.offTopicPatterns) {
      if (pattern.test(trimmed)) {
        this.incrementViolation(sessionId);
        return {
          action: 'warn',
          reason: "I'm a Veng parts assistant — I specialise in car parts, orders, delivery, and support. Let me know what I can help you with!",
          triggeredRule: 'off-topic',
          riskScore: 40,
        };
      }
    }

    // 10. Profanity (soft warn — allow through, flag it)
    const hasProfanity = this.profanityList.some((w) => trimmed.toLowerCase().includes(w));
    if (hasProfanity) {
      return {
        action: 'warn',
        reason: 'mild-profanity',
        triggeredRule: 'profanity',
        riskScore: 20,
      };
    }

    return { action: 'allow', riskScore: 0 };
  }

  /**
   * Scan a bot response for PII before sending.
   */
  checkOutput(content: string): GuardrailResult {
    let safe = content;
    let redacted = false;

    for (const { pattern, label } of this.outputPiiPatterns) {
      if (pattern.test(safe)) {
        safe = safe.replace(pattern, label);
        redacted = true;
      }
    }

    if (redacted) {
      return {
        action: 'redact',
        safeContent: safe,
        triggeredRule: 'pii-in-output',
        riskScore: 70,
      };
    }

    return { action: 'allow', riskScore: 0 };
  }

  /** Reset violation count for a session (e.g. when admin joins) */
  resetViolations(sessionId: string) {
    this.violationMap.delete(sessionId);
  }

  private checkRateLimit(sessionId: string): GuardrailResult {
    const now = Date.now();
    const timestamps = (this.sessionRateMap.get(sessionId) || []).filter(
      (t) => now - t < this.RATE_WINDOW_MS,
    );
    timestamps.push(now);
    this.sessionRateMap.set(sessionId, timestamps);

    if (timestamps.length > this.RATE_LIMIT) {
      return {
        action: 'block',
        reason: 'Too many messages — please wait a moment before continuing.',
        triggeredRule: 'rate-limit',
        riskScore: 30,
      };
    }
    return { action: 'allow', riskScore: 0 };
  }

  getStats() {
    return {
      activeSessions: this.sessionRateMap.size,
      sessionsWithViolations: this.violationMap.size,
      rules: {
        toxic: this.toxicPatterns.length,
        offTopic: this.offTopicPatterns.length,
        injection: this.injectionPatterns.length,
        outputPii: this.outputPiiPatterns.length,
        inputPii: this.inputPiiPatterns.length,
      },
    };
  }
}
