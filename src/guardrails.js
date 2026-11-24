export const REFUSAL_MESSAGE =
  'I can only explain how this application’s features, workflows, and business rules work in everyday language. ' +
  'I can’t write or generate code, scripts, or database queries, make edits or changes to the application, reveal source code, or answer unrelated requests.\n\n' +
  'If you’d like, ask how a specific feature or workflow in this application works for users.';

const codeArtifactTerms =
  '(?:code|source\\s*code|script|snippet|program|function|class|method|module|query|sql|regex|regular\\s+expression|command|cli|curl|api\\s+call|endpoint\\s+code|migration|dockerfile|yaml|json\\s+schema|html|css|python|javascript|typescript|node\\.?js|php|ruby|java|go|golang|rust|c\\+\\+|c#|bash|shell|powershell|react|vue|laravel)';

const inputRules = [
  {
    reason: 'code_generation',
    pattern: new RegExp(
      `\\b(?:write|generate|create|build|make|give|show|provide|produce|draft|code|implement|output|return)\\b(?:\\s+(?:me|us|a|an|some|the|simple|quick|short|working|example|sample)){0,4}\\s+(?:\\w+\\s+){0,2}${codeArtifactTerms}\\b`,
      'i',
    ),
  },
  {
    reason: 'code_generation_lang_first',
    pattern: /\b(?:python|javascript|typescript|php|sql|bash|shell|curl|node\.?js|ruby|java|golang|rust|html|css)\s+(?:code|script|snippet|query|command|example|function|program)\b/i,
  },
  {
    reason: 'code_generation_in_lang',
    pattern: /\b(?:write|generate|code|implement|give\s+me|show\s+me|provide)\b.{0,50}\b(?:in|using|with)\s+(?:python|javascript|typescript|php|sql|bash|shell|curl|node\.?js|ruby|java|golang|rust|html|css)\b/i,
  },
  {
    reason: 'code_editing',
    pattern: /\b(?:please\s+|can\s+you\s+|could\s+you\s+|help\s+me\s+)?(?:edit|modify|change|update|fix|patch|refactor|rewrite|delete|remove|add\s+(?:a\s+)?(?:feature|button|field|column|route|endpoint|page|script))\b.{0,45}\b(?:code|codebase|file|files|repo|repository|source|script|function|class|component|database|table|schema|query|sql|bug|css|html|javascript|python|php)\b/i,
  },
  {
    reason: 'source_or_secret_extraction',
    pattern: /\b(?:show|print|dump|paste|reveal|give|output|display|extract|list)\b.{0,40}\b(?:source\s*code|raw\s+code|full\s+code|file\s+contents?|entire\s+file|system\s+prompt|hidden\s+instructions?|developer\s+instructions?|\.env|api\s*keys?|secrets?|credentials?|password\s*hash(?:es)?|database\s+credentials?)\b/i,
  },
  {
    reason: 'prompt_injection',
    pattern: /\b(?:ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?|disregard\s+(?:your\s+)?(?:rules|instructions|system\s+prompt)|pretend\s+you\s+are|act\s+as\s+(?:a\s+)?(?:developer|programmer|coder|dba|hacker|dan)|jailbreak|developer\s+mode)\b/i,
  },
  {
    reason: 'off_topic_creative',
    pattern: /\b(?:write|compose|generate|tell)\s+(?:me\s+)?(?:a\s+)?(?:poem|haiku|story|joke|song|lyrics|essay|cover\s+letter|resume|recipe|marketing\s+email)\b/i,
  },
];

const outputCodePatterns = [
  /```[\s\S]*?```/,
  /^\s*(?:import\s+[\w.{}\s,*]+(?:from\s+['"][^'"]+['"])?|from\s+[\w.]+\s+import\s+\w+|def\s+\w+\s*\(|class\s+\w+\s*[:({]|function\s+\w+\s*\(|const\s+\w+\s*=\s*(?:async\s+)?\(|<\?php|#!\/(?:usr\/bin\/env|bin\/))/m,
  /\bSELECT\b[\s\S]{1,160}\bFROM\b[\s\S]{0,120}\b(?:WHERE|JOIN|ORDER\s+BY|GROUP\s+BY|LIMIT|;)/i,
  /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE)\b/i,
  /^\s*(?:curl\s+-[A-Za-z]|pip\s+install|npm\s+install|sudo\s+\w+)/m,
];

export function checkInputGuardrail(question) {
  const text = typeof question === 'string' ? question.trim() : '';
  if (!text) return { allowed: true };
  for (const rule of inputRules) {
    if (rule.pattern.test(text)) {
      return { allowed: false, reason: rule.reason, refusal: REFUSAL_MESSAGE };
    }
  }
  return { allowed: true };
}

export function checkOutputGuardrail(responseText) {
  const text = typeof responseText === 'string' ? responseText.trim() : '';
  if (!text) return { allowed: true, text };
  for (const pattern of outputCodePatterns) {
    if (pattern.test(text)) {
      return { allowed: false, reason: 'generated_code_blocked', refusal: REFUSAL_MESSAGE };
    }
  }
  return { allowed: true, text };
}
