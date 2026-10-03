/**
 * DEFAULT ANSWERS: screening questions no profile fact settles, but that a
 * typical applicant answers the same way, answered on-device so they never
 * wait for the AI (which is for prose and judgement, and may be unavailable).
 *
 * The working assumption is an applicant who ACCEPTS the posting's standard
 * terms (they are applying to it) and is UNENCUMBERED (no prior application,
 * no relative inside, no conflict, no non-compete). Every rule names that
 * assumption in its `rule` id, so telemetry and the review panel show which
 * answer came from a default rather than from the profile.
 *
 * What is deliberately NOT defaulted, because a wrong answer there is a false
 * statement with consequences: work authorization, sponsorship, citizenship
 * and export-control status (profile facts only, see questionResolver),
 * criminal history, and anything asking for a fact (dates, numbers, names).
 * Marketing / SMS / newsletter opt-ins are answered NO.
 *
 * Runs LAST in resolveQuestion: a profile fact always wins over a default.
 */
import type { UserApplicationProfile } from "../shared/types";
import { optionPolarity } from "./answerKind";
import { isHigh, type ProfileFacts } from "./profileFacts";
import type { QuestionContext, QuestionInput, QuestionResult } from "./questionResolver";

const answer = (value: string, rule: string): QuestionResult => ({ status: "answer", value, confidence: "high", rule });

/** Lowercase words (mirrors questionResolver.qnorm, kept local to avoid an import cycle). */
const qn = (text: string): string =>
  (text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();

const realOptions = (q: QuestionInput): string[] =>
  (q.options ?? []).filter((o) => o.trim() && !/^(select|choose|please select|select an option|select one|--)/i.test(o.trim()));

/**
 * A computed yes/no, rendered into what the field takes. Options known: the ONE
 * option of that polarity (or a bare Yes/No among several). Options unknown (a
 * react-select before it opens): "Yes"/"No", snapped when the options arrive.
 */
function polar(value: boolean, q: QuestionInput, rule: string): QuestionResult {
  const opts = realOptions(q);
  if (opts.length > 0) {
    const same = opts.filter((o) => optionPolarity(o) === value);
    if (same.length === 1) return answer(same[0], rule);
    const bare = same.filter((o) => /^(yes|no)$/i.test(o.trim()));
    if (bare.length === 1) return answer(bare[0], rule);
    return null; // several options share the polarity: a chooser below may know which
  }
  if (q.controlType === "checkbox") return answer(value ? "yes" : "no", rule);
  if (q.kind === "boolean" || q.controlType === "combobox" || q.controlType === "customDropdown" || q.controlType === "select" || q.controlType === "radioGroup" || q.controlType === "ariaRadioGroup") {
    return answer(value ? "Yes" : "No", rule);
  }
  return null; // free text: a bare Yes would not read as an answer to most of these
}

// ---------------------------------------------------------------------------
// The families. Order matters: opt-outs before consents ("I agree to receive
// marketing emails" is marketing), conditions before acknowledgements.
// ---------------------------------------------------------------------------

/** Opt-ins nobody needs to apply: answered NO. */
const MARKETING =
  /\b(marketing|newsletters?|subscribe|promotional|sms|text messages?|texts? (me|messages)|whats ?app|job alerts?|mailing list|keep (me )?(in touch|informed)|stay (in touch|informed)|receive (news|emails?|communications?|updates?|information|messages|notifications?))\b/;

/** Being kept on file for other roles: harmless and in the applicant's interest. */
const FUTURE_ROLES = /\b(future (opportunities|openings|roles|positions|vacancies)|other (opportunities|roles|positions|openings)|talent (community|network|pool|pipeline)|consider(ed)? (me )?for (other|future))\b/;

/** Consent / certification an application cannot be submitted without. */
const CONSENT_VERB =
  /\b(consent|agree|accept|acknowledge|understand|confirm|certify|attest|declare|authori[sz]e)\b|\bi have read\b|\bby (checking|selecting|clicking|submitting)\b/;
const CONSENT_OBJECT =
  /\b(privacy|personal (data|information)|data (protection|processing|privacy)|gdpr|ccpa|processing|terms|conditions|polic(y|ies)|notice|statement|disclosure|accurate|true|truthful|complete|correct|falsif\w*|misrepresent\w*|omission|retain|retention|stor(e|ing)|collect(ion|ing)?|candidate (data|information)|applicant (data|information))\b/;
/** Demographic-data consent belongs to the EEO path (sensitive), never defaulted. */
const DEMOGRAPHIC = /\b(demographic|self ?identif\w*|eeo|equal employment|voluntary (self|disclosure))\b/;
/** Recording / AI notetaking consent: a preference, not a requirement. */
const RECORDING = /\b(record(ed|ing)?|transcri\w*|notetak\w*|note tak\w*)\b/;

/** A requirement of the posting the applicant accepts by applying. */
const ACK_VERB =
  /\b(acknowledge|agree|understand|confirm|accept|comfortable|okay|ok|willing|able|open|prepared|available|can you|will you be able|are you able)\b/;
const REQUIREMENT =
  /\b(in ?office|on ?site|in ?person|hybrid|office|commut\w*|travel\w*|relocat\w*|shifts?|weekends?|overtime|nights?|evenings?|holidays?|background (check|screen\w*|investigation)s?|drug (test\w*|screen\w*)|essential (functions|duties)|lift\w*|schedule|days (per|a|each) week|requirement|requirements)\b/;
/** A request rather than a requirement ("Will you require relocation
 *  assistance?"): the applicant's to make, never defaulted. */
const ASSISTANCE = /\b(assistance|package|support|expenses?|benefits?|allowance|reimburs\w*|stipend|bonus|housing)\b/;
/** "…challenges clearing a background check?": the clean answer is NO. */
const OBSTACLE = /\b(challenges?|issues?|problems?|concerns?|difficult(y|ies)?|prevent you|preclude|disqualif\w*)\b/;

const PRIOR_APPLICATION =
  /\b(have|did) you (ever |previously |already )?(applied|interviewed|submitted (an )?application)\b|\bpreviously (applied|interviewed)\b|\bapplied (here|before|previously)\b|\binterviewed (here|before|with us)\b/;
/** "Were you referred by an employee?" (a yes/no; WHO referred stays unanswerable). */
const REFERRED = /\b(were|was) you referred\b|\bwere you referred by\b|\breferred by (a|an|any) (current )?(employee|staff|team member|friend)\b|\bemployee referral\b/;
const RELATIVES =
  /\b(relatives?|family members?|related to|spouse|domestic partner|immediate family|household members?|familial|personal relationships?)\b/;
const CONFLICTS = /\bconflicts? of interest\b|\boutside (business|employment) (activit|interest)\w*/;
const NON_COMPETE =
  /\bnon ?compet\w*|\bnon ?solicit\w*|\brestrictive covenants?\b|\b(agreements?|contracts?) that (would |may |might )?(restrict|prevent|limit|prohibit)\b/;
const GOV_OFFICIAL =
  /\b(government|public|foreign) officials?\b|\bprocurement officials?\b|\bpolitically exposed\b|\b(current|former|currently|formerly)\b[^?]{0,30}\b(government|federal|state|public sector) (employee|official)s?\b/;
const CRIMINAL = /\b(criminal|convicted|conviction|felony|misdemeanou?r|arrested|charged with|pending charges)\b/;

const HOW_HEARD =
  /\bhow did you (hear|find|learn|come across|discover)\b|\bwhere did you (hear|see|find|learn)\b|\bhow were you (referred|introduced)\b|\b(referral|application|candidate|job) source\b|\bsource of (application|referral)\b|\bhow did you get to know\b/;

/** Options a "how did you hear" answer may take, most truthful first for a
 *  Tailrd user (who found the posting through a job aggregator). */
const SOURCE_PREFERENCE: RegExp[] = [
  /\bjob (board|site|search|posting|aggregator)s?\b|\bonline (job|posting|ad|listing)s?\b|\bjob search (engine|site|website)\b/,
  /\b(company|corporate|our) (website|site|careers? (page|site))\b|\bcareers? (page|site|website)\b|\bwebsite\b/,
  /\b(internet|online|web|search engine|google)\b/,
  /\blinked ?in\b/,
  // A named job board is still "found it on a job board".
  /\b(indeed|glassdoor|zip ?recruiter|monster|simply ?hired|dice|built ?in|wellfound|angel ?list|handshake|job ?bank|workopolis|eluta|talent com|jobillico|levels fyi)\b/,
  /\bother\b/,
];

/** Map the applicant's stated source (profile.howDidYouHear) onto option words. */
const SOURCE_SYNONYMS: Array<[RegExp, RegExp]> = [
  [/\blinked ?in\b/, /\blinked ?in\b/],
  [/\bjob (board|site)\b|\bindeed\b|\bglassdoor\b|\bonline\b/, /\bjob (board|site|search|posting)s?\b|\bonline\b|\bindeed\b|\bglassdoor\b|\binternet\b/],
  [/\b(company|careers?) (website|site|page)\b|\bwebsite\b/, /\b(company|corporate|careers?|our) (website|site|page)\b|\bwebsite\b/],
  [/\breferr\w*|\bemployee\b|\bfriend\b/, /\breferr\w*|\bemployee\b|\bfriend\b/],
  [/\b(career|job) fair\b|\buniversity\b|\bcampus\b|\bschool\b|\bcollege\b/, /\b(career|job) fair\b|\buniversity\b|\bcampus\b|\bschool\b|\bcollege\b|\bco ?op\b/],
  [/\bsocial\b|\btwitter\b|\bx\b|\bfacebook\b|\binstagram\b|\btik ?tok\b/, /\bsocial\b|\btwitter\b|\bfacebook\b|\binstagram\b|\btik ?tok\b/],
  [/\bother\b/, /\bother\b/],
];

function chooseSource(q: QuestionInput, profile: UserApplicationProfile): QuestionResult {
  const opts = realOptions(q);
  const stated = qn(profile.howDidYouHear ?? "");
  if (opts.length === 0) {
    // Free text, or a dropdown whose options arrive later (snapped then).
    if (stated) return answer(profile.howDidYouHear!.trim(), "source:stated");
    return answer(q.controlType === "text" || q.controlType === "textarea" ? "Online job board" : "Job board", "source:default");
  }
  const unique = (re: RegExp): string | null => {
    const hits = opts.filter((o) => re.test(qn(o)));
    return hits.length === 1 ? hits[0] : null;
  };
  if (stated) {
    const exact = opts.find((o) => qn(o) === stated);
    if (exact) return answer(exact, "source:stated");
    for (const [said, offered] of SOURCE_SYNONYMS) {
      if (!said.test(stated)) continue;
      const hit = unique(offered);
      if (hit) return answer(hit, "source:stated");
    }
  }
  for (const re of SOURCE_PREFERENCE) {
    const hit = unique(re);
    if (hit) return answer(hit, "source:default");
  }
  return null;
}

/**
 * A requirement acknowledged through location options ("Yes, I'm currently
 * located here" | "Yes, I'd relocate prior to the start of the role" | "No,
 * I'm not located nearby", Brex 2026-10-03): located here when the applicant
 * lives in the job's city, else relocate unless they said they would not.
 */
function chooseLocated(q: QuestionInput, profile: UserApplicationProfile, facts: ProfileFacts, ctx: QuestionContext): QuestionResult {
  const opts = realOptions(q);
  // "No, I'm not located nearby" also says "located nearby": polarity first.
  const here = opts.filter(
    (o) => optionPolarity(o) !== false && /\b(currently (located|live|living|based|reside|residing)|located (here|nearby|in the area|locally)|live (here|nearby|locally|in the area)|already (live|located|based))\b/.test(qn(o))
  );
  const move = opts.filter((o) => /\b(relocat\w*|move|moving)\b/.test(qn(o)) && optionPolarity(o) !== false);
  const no = opts.filter((o) => optionPolarity(o) === false);
  if (here.length !== 1 || move.length !== 1) return null;
  const city = isHigh(facts.location.city) ? qn(facts.location.city.value) : "";
  const local = Boolean(city && ctx.jobCity && qn(ctx.jobCity) === city);
  if (local) return answer(here[0], "located:here");
  const refuses = /^no\b/i.test((profile.willingToRelocate ?? "").trim());
  if (refuses) return no.length === 1 ? answer(no[0], "located:not-relocating") : null;
  return answer(move[0], profile.willingToRelocate ? "located:relocate-stated" : "located:relocate-default");
}

/**
 * The default answer for `q`, or null when no family applies. `n` is the
 * normalized label (label + help text when the label is a bare stem).
 */
export function resolveDefault(
  q: QuestionInput,
  n: string,
  profile: UserApplicationProfile,
  facts: ProfileFacts,
  ctx: QuestionContext
): QuestionResult {
  const kind = q.kind;
  const choiceLike =
    kind === "boolean" || kind === "choice" || q.controlType === "checkbox" || realOptions(q).length > 0 ||
    q.controlType === "combobox" || q.controlType === "customDropdown";

  if (HOW_HEARD.test(n) && !/\bif\b.*\b(referr|other)\b/.test(n)) return chooseSource(q, profile);
  if (!choiceLike) return null; // the rest are yes/no families
  if (CRIMINAL.test(n)) return null;

  if (MARKETING.test(n) && !FUTURE_ROLES.test(n)) return polar(false, q, "default:marketing-opt-out");
  if (FUTURE_ROLES.test(n) && /\b(consider|keep|retain|share|contact|notify|would you like|interested)\b/.test(n)) {
    return polar(true, q, "default:future-roles");
  }

  if (PRIOR_APPLICATION.test(n)) return polar(false, q, "default:no-prior-application");
  if (REFERRED.test(n)) return polar(false, q, "default:not-referred");
  if (RELATIVES.test(n) && /\b(work|employ|empl|staff|board|director|officer|relationship)\w*/.test(n)) {
    return polar(false, q, "default:no-relatives-inside");
  }
  if (CONFLICTS.test(n)) return polar(false, q, "default:no-conflict");
  if (NON_COMPETE.test(n)) return polar(false, q, "default:no-non-compete");
  if (GOV_OFFICIAL.test(n)) return polar(false, q, "default:not-government-official");

  if (DEMOGRAPHIC.test(n)) return null;
  if (CONSENT_VERB.test(n) && CONSENT_OBJECT.test(n) && !RECORDING.test(n)) {
    return polar(true, q, "default:consent");
  }
  if (/\bessential (functions|duties)\b/.test(n)) return polar(true, q, "default:essential-functions");
  if (REQUIREMENT.test(n) && !ASSISTANCE.test(n) && (ACK_VERB.test(n) || /^(do|are|will|can|would) you\b/.test(n))) {
    if (/\bbackground (check|screen)/.test(n) && OBSTACLE.test(n)) return polar(false, q, "default:no-background-obstacle");
    // Options that answer through location ("currently located here" vs
    // "I'd relocate") need the choice, not a bare yes.
    const located = chooseLocated(q, profile, facts, ctx);
    if (located) return located;
    const refusesMove = /\brelocat/.test(n) && /^no\b/i.test((profile.willingToRelocate ?? "").trim());
    if (refusesMove) return polar(false, q, "relocation:stated");
    const remoteOnly = /\b(in ?office|on ?site|in ?person|hybrid)\b/.test(n) && /^remote$/i.test((profile.workPreference ?? "").trim());
    if (remoteOnly) return null; // they said remote: the applicant must decide
    return polar(true, q, "default:accepts-requirement");
  }
  return null;
}

