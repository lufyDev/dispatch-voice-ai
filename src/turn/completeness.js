/**
 * Does this look like a finished thought?
 *
 * The problem, observed on the first real mic test. We told Deepgram "300ms of
 * quiet means they are done", so a caller who drew breath mid-sentence got cut
 * in half:
 *
 *   USER:  "Hi. My"                      <- the breath after "my"
 *   AGENT: "I didn't catch that."
 *   USER:  "basement is flooding."
 *
 * Synthetic speech never did this: `say` produces one smooth stream with no
 * breaths. Every real human pauses to think.
 *
 * Raising the silence threshold to 700ms would fix it by making EVERY turn
 * 400ms slower, which is the lazy default the foundations doc warns about. The
 * better move is dynamic: reply instantly when the utterance is clearly
 * finished, wait longer when it clearly is not.
 *
 * WHY RULES AND NOT AN LLM. Asking a model "is this complete?" is the obvious
 * design and it is a non-starter here: our measured round trip to OpenAI is
 * ~1000ms, so the classifier would cost more than the endpointing wait it is
 * meant to save. Rules run in microseconds. They are cruder, and M4's notes
 * record what they miss.
 */

/** Words that cannot end a finished sentence: something has to follow. */
const DANGLING = new Set([
  // fillers — the caller is visibly still thinking
  'um', 'uh', 'er', 'erm', 'ah', 'hmm', 'like', 'well',
  // conjunctions — a clause is coming
  'and', 'but', 'or', 'so', 'because', 'cause', 'if', 'when', 'while', 'since',
  'though', 'although', 'unless', 'until', 'whether', 'that', 'which', 'who',
  // determiners and possessives — a noun is coming ("Hi, my" -> "my basement")
  'a', 'an', 'the', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this',
  'these', 'those', 'some', 'any', 'every', 'no',
  // prepositions — an object is coming
  'to', 'at', 'in', 'on', 'of', 'for', 'with', 'from', 'by', 'into', 'onto',
  'about', 'over', 'under', 'near', 'between', 'through', 'during',
  // auxiliaries and copulas — a predicate is coming ("my address is" -> "42")
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must', 'get', 'got', 'going',
  // comparatives that expect a continuation
  'than', 'as', 'very', 'really', 'quite', 'just',
]);

/**
 * Short utterances that ARE complete. Without this list, every one-word answer
 * to a yes/no question would be held back -- which is most of a booking call.
 */
const COMPLETE_SHORT = new Set([
  'yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'nah', 'okay', 'ok', 'sure',
  'correct', 'right', 'wrong', 'hello', 'hi', 'hey', 'thanks', 'bye',
  'please', 'stop', 'wait', 'what', 'sorry', 'maybe', 'nothing', 'none',
]);

/**
 * @param {string} text the accumulated utterance
 * @returns {{ complete: boolean, reason: string }}
 */
export function looksComplete(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { complete: false, reason: 'empty' };

  // NOTE: an earlier version treated a trailing comma as "continues". Measured
  // cost: "My address is 42 Oak Street," is a COMPLETE address that Deepgram
  // happened to punctuate with a comma, and the rule bought it an extra 900ms
  // hold for nothing. It was also never load-bearing -- the cases it was meant
  // to catch ("so the heater, uh,") end on a dangling word anyway. Removed.

  const words = trimmed.split(/\s+/);
  const bare = (w) => w.toLowerCase().replace(/[^a-z']/g, '');
  const last = bare(words.at(-1));

  // Terminal punctuation is a real signal: smart_format adds it only where
  // Deepgram believes a sentence ended. Note "Hi. My" got none, while
  // "basement is flooding." did.
  const punctuated = /[.!?]$/.test(trimmed);

  // This check must precede DANGLING, because some words are both. "no" is a
  // complete answer ("No.") and a determiner ("there is no hot water"), and
  // punctuation is the only thing that separates them. Same for "that", "this".
  if (punctuated && COMPLETE_SHORT.has(last)) {
    return { complete: true, reason: 'punctuated stock answer' };
  }

  if (DANGLING.has(last)) {
    return { complete: false, reason: `ends on "${last}", which needs a continuation` };
  }

  if (words.length === 1) {
    if (COMPLETE_SHORT.has(last)) return { complete: true, reason: 'complete short answer' };
    // A lone word that is not a stock answer is usually the start of something
    // ("basement", "forty"), even when Deepgram punctuated it.
    return { complete: false, reason: 'single word, not a stock answer' };
  }

  if (!punctuated && words.length <= 3) {
    return { complete: false, reason: 'very short and unpunctuated' };
  }

  return { complete: true, reason: punctuated ? 'punctuated' : 'no dangling word' };
}
