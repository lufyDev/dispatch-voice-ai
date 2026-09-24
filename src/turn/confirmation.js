/**
 * Did the caller just agree?
 *
 * Needed because "read the details back and wait for confirmation" cannot be
 * enforced by asking the model to do it -- we tried, twice, and it booked in the
 * same breath as the read-back. So the pipeline decides whether consent was
 * given and the booking tool refuses without it.
 *
 * NEGATIVES AND CORRECTIONS WIN. "Yes, but the address is wrong" begins with
 * "yes" and is not consent; it is a correction. Scanning for "yes" first gets
 * this backwards and books a job to the wrong house, so corrections are checked
 * before agreement.
 *
 * Deliberately conservative: 'unclear' means ask again. A wasted question costs
 * two seconds, a wrongly-booked job costs a truck.
 */

const CORRECTION = /\b(wrong|incorrect|not right|mistake|change|different|actually|instead|no it'?s|it'?s not|that'?s not|hold on|wait)\b/i;
const NEGATIVE = /^(no|nope|nah|negative|not really|no thanks?)\b/i;
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|correct|right|exactly|perfect|that'?s it|that is correct|that'?s right|sounds good|go ahead|book it|please do|confirm|all good|sure)\b/i;

/**
 * A number in the utterance, digits or words.
 *
 * The hardest correction has no correction WORD in it at all: "yes, it is 8
 * Kestrel Way not 7". Keyword matching says yes and books the wrong house. The
 * signal that is actually present is the number -- a plain confirmation does not
 * contain one, a caller restating a detail does.
 *
 * Costs the occasional needless re-read ("yes, 4 p.m. works"). That is the right
 * direction to be wrong in: a wasted question versus a truck at number 7.
 */
const NUMBERISH = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|forty|fifty|sixty|hundred)\b/i;

/**
 * @param {string} text
 * @returns {'yes'|'no'|'unclear'}
 */
export function classifyConfirmation(text) {
  const t = (text ?? '').trim();
  if (!t) return 'unclear';

  // Order matters. See the note above.
  if (CORRECTION.test(t)) return 'no';
  if (NEGATIVE.test(t)) return 'no';
  if (AFFIRMATIVE.test(t)) {
    // Agreed AND told us a number: they are restating a detail, not confirming.
    // Read it back again rather than guessing which one they meant.
    return NUMBERISH.test(t) ? 'no' : 'yes';
  }
  return 'unclear';
}
