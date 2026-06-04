const LABELED_RULE_RE = /(?:Project convention|项目(?:约定|规范|规则)|项目中?的?规则|规则|约定)\s*[:：]\s*([^\n]+)/iu;
const ENGLISH_RULE_START_RE = /^(?:always|avoid|do not|don't|keep|never|prefer|use)\b/i;
const CHINESE_RULE_RE = /(?:以后|后续|本地|项目|仓库|代码|测试|reviewer|rules reviewer).*(?:需要|必须|应该|不要|不能|禁止|避免|保持|优先|使用|采用|统一|默认)/u;
const CHINESE_RULE_START_RE = /^(?:以后|后续|需要|必须|应该|不要|不能|禁止|避免|保持|优先|使用|采用|统一|默认)/u;

export function hasReusableProjectConvention(text) {
  return extractReusableProjectConvention(text).length > 0;
}

export function extractReusableProjectConvention(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return '';
  }

  const labeled = normalized.match(LABELED_RULE_RE);
  if (labeled) {
    const rule = cleanRuleSentence(labeled[1]);
    if (isLabeledReusableRule(rule)) {
      return formatConvention(rule);
    }
  }

  const usefulSentence = splitSentences(normalized)
    .map(cleanRuleSentence)
    .find(isReusableRuleSentence);
  return usefulSentence ? formatConvention(usefulSentence) : '';
}

function splitSentences(text) {
  return text
    .split(/\r?\n|(?<=[.!?。！？；;])\s*/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function cleanRuleSentence(sentence) {
  return sentence
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)、]\s*/, '')
    .trim();
}

function isReusableRuleSentence(sentence) {
  if (!sentence || sentence.length < 4) {
    return false;
  }
  if (ENGLISH_RULE_START_RE.test(sentence)) {
    return true;
  }
  return CHINESE_RULE_START_RE.test(sentence) || CHINESE_RULE_RE.test(sentence);
}

function isLabeledReusableRule(sentence) {
  return sentence.length >= 4 && !/no reusable rule|没有可复用规则|无可复用规则/i.test(sentence);
}

function formatConvention(rule) {
  return `Project convention: ${rule}`;
}
