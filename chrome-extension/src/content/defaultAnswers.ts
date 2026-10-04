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
import { placeOf } from "./placeMatch";
import type { QuestionContext, QuestionInput, QuestionResult } from "./questionResolver";

const answer = (value: string, rule: string): QuestionResult => ({ status: "answer", value, confidence: "high", rule });
/** A government body in the history: "a current or former government
 *  employee?" is the applicant's to judge (is the Army one? the employer test
 *  is broad on purpose), and the AI, with the same history, could only guess
 *  (a veteran on ActioNet's Jobvite form, live 2026-10-03). */
const GOVERNMENT_HISTORY: QuestionResult = { status: "abstain", rule: "default:government-history", blockBackend: true };
const RECORDING_CONSENT: QuestionResult = { status: "abstain", rule: "default:recording-consent", blockBackend: true };

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
  /\b(marketing|newsletters?|subscribe|promotional|sms|text messages?|texts? (me|messages)|(via|by) text|text (communications?|updates|alerts)|whats ?app|job alerts?|mailing list|keep (me )?(in touch|informed)|stay (in touch|informed)|receive (news|emails?|communications?|updates?|information|messages|notifications?))\b/;

/** Being kept on file for other roles: harmless and in the applicant's interest. */
const FUTURE_ROLES = /\b(future (job |career |employment )?(opportunities|openings|roles|positions|vacancies)|other (opportunities|roles|positions|openings)|talent (community|network|pool|pipeline)|consider(ed)? (me )?for (other|future))\b/;

/** Consent / certification an application cannot be submitted without. */
const CONSENT_VERB =
  /\b(consent|agree|accept|acknowledge|understand|confirm|certify|attest|declare|authori[sz]e)\b|\bi have read\b|\bby (checking|selecting|clicking|submitting)\b/;
const CONSENT_OBJECT =
  /\b(privacy|personal (data|information)|data (protection|processing|privacy)|gdpr|ccpa|processing|terms|conditions|polic(y|ies)|notice|statement|disclosure|disclaimers?|accurate|true|truthful|complete|correct|falsif\w*|misrepresent\w*|omission|retain|retention|stor(e|ing)|collect(ion|ing)?|candidate (data|information)|applicant (data|information))\b/;
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
const OBSTACLE = /\b(challenges?|issues?|problems?|concerns?|difficult(y|ies)?|prevent you|preclude|disqualif\w*|impediments?|barriers?|obstacles?|restrictions?|limitations?)\b/;

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
  /\b(government|public|foreign) officials?\b|\bprocurement officials?\b|\bpolitically exposed\b|\b(current|former|currently|formerly)\b[^?]{0,30}\b(government|federal|state|public sector) officials?\b/;
const GOV_EMPLOYEE = /\b(current|former|currently|formerly)\b[^?]{0,30}\b(government|federal|state|public sector) employees?\b/;
/** An employer that is a government body ("Public Services and Procurement
 *  Canada", "City of Ottawa", "U.S. Department of Energy"). Broad on purpose: a
 *  false hit only leaves the question to the applicant. */
const GOV_EMPLOYER =
  /\b(government|gouvernement|ministry|ministere|department of|dept of|federal|provincial|municipal|municipality|city of|town of|county of|region of|province of|state of|public services?|public sector|procurement|parliament|senate|house of commons|legislative|legislature|treasury|revenue agency|border services|armed forces|army|navy|air force|marine corps|coast guard|national guard|police|rcmp|crown corporation)\b|\b(health|transport|statistics|service|parks|environment|justice|finance|heritage|agriculture|immigration|fisheries|infrastructure|natural resources|global affairs|veterans affairs|public safety|indigenous services|shared services|library and archives|elections) canada\b|\bcanada (revenue|border|post)\b|\b(nasa|noaa|usps|fbi|cia|nsa)\b|\b(u s|united states) (department|army|navy|air force|government)\b/;
/** A title naming an official's role, not just a job at a government body. */
const OFFICIAL_TITLE = /\b(official|officer|minister|commissioner|contracting|procurement|purchasing|buyer|director general)\b/;

/**
 * The applicant's history with government: an employer that is one, and a
 * title there that names an official's role. "Are you a current or former
 * government employee?" was answered No for a profile whose last job was a
 * federal internship (ActioNet on Jobvite, a real profile, 2026-10-03).
 */
function governmentHistory(profile: UserApplicationProfile): { employer: boolean; official: boolean } {
  const isGov = (company: string): boolean => {
    const c = qn(company);
    return Boolean(c) && GOV_EMPLOYER.test(c) && !/\b(university|college|hospital)\b/.test(c);
  };
  const rows = (profile.experience ?? []).filter((r) => r && isGov(r.company ?? ""));
  return {
    employer: rows.length > 0 || isGov(profile.currentCompany ?? ""),
    official: rows.some((r) => OFFICIAL_TITLE.test(qn(r.title ?? ""))),
  };
}

/** The "never a government employee / official" default, unless the history says otherwise. */
function notGovernment(n: string, profile: UserApplicationProfile): boolean | null {
  const employee = GOV_EMPLOYEE.test(n);
  if (!employee && !GOV_OFFICIAL.test(n)) return null;
  const gov = governmentHistory(profile);
  // An OFFICIAL is a role, not an employer: a developer intern at a
  // department is a government employee, and still no procurement official.
  return !(employee ? gov.employer : gov.official);
}
const CRIMINAL = /\b(criminal|convicted|conviction|felony|misdemeanou?r|arrested|charged with|pending charges)\b/;

const HOW_HEARD =
  /\bhow (did )?you (first |originally )?(hear|heard|find|found|learn|learned|come across|came across|discover|discovered|connect|connected)\b|\bwhere did you (hear|see|find|learn)\b|\bhow were you (referred|introduced)\b|\b(referral|application|candidate|job) source\b|\bsource of (application|referral)\b|\bhow did you get to know\b/;

/** Channels a "how did you hear" list offers; three or more in an unlabeled
 *  question ("Select One", Hermeus on Lever) make it that question. */
const CHANNEL = /\b(linked ?in|indeed|glassdoor|company (website|site)|careers? (page|site|website)|referral|career (fair|services)|job board|facebook|twitter|instagram|youtube|built ?in|handshake|recruiter|google)\b/;
const UNLABELED = /^(select|choose|pick)( one| an option| all that apply)?$|^$/;

/** An acknowledgement option: the only thing a form lets you answer. */
const ACK_OPTION = /^(i (will|understand|agree|acknowledge|confirm|accept|have read|consent)|acknowledged|agree|agreed|understood|confirmed)\b/;
/** A titled policy / agreement with a Yes/No ("AI Policy for Application", Anthropic). */
const TITLED_TERMS = /\b(polic(y|ies)|agreement|terms|notice|acknowledg\w*|attestation|arbitration)\b/;

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

/** Working in a place in person (an office, on site, a hybrid schedule). */
const IN_PERSON =
  /\b(in ?office|on ?site|in ?person|hybrid|report to (the|our) office)\b|\b(work|commute|report)\b[^?]{0,60}\b(from|at|in|to)\b[^?]{0,40}\boffices?\b/;

/** Research or outside funding that could claim the work (Zoox on Lever). */
const RESEARCH_OR_FUNDING =
  /^(are|do) you (currently )?(conducting|doing|performing|engaged in) (any )?research\b|^do you (currently )?(receive|have|hold) (any )?(active )?(funding|grants?|sponsorships?)\b/;

/** The place a question names ("out of Pleasant Grove, Utah", "in Austin, TX"). */
function placeInLabel(label: string): ReturnType<typeof placeOf> | null {
  const m = /\b(?:out of|in|at|from|based in|located in)\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3},\s*[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,2})/.exec(label);
  if (!m) return null;
  const place = placeOf(m[1]);
  return place.city && (place.region || place.country) ? place : null;
}

/** A channel named for a brand ("LinkedIn Job Search", "Glassdoor Article"). */
const NAMED_SOURCE =
  /\b(linked ?in|indeed|glassdoor|zip ?recruiter|monster|simply ?hired|dice|built ?in|wellfound|angel ?list|handshake|otta|facebook|instagram|twitter|tiktok|youtube|reddit|career ?builder)\b/;

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

/**
 * The unencumbered applicant's "No" typed into a text box: "*Were you referred
 * to this job by a Mindex employee? If so, who?" (Workable), "Do you have a
 * family member/relative that currently works at ActioNet?" (Jobvite).
 */
function unencumberedText(q: QuestionInput, n: string, profile: UserApplicationProfile): QuestionResult {
  if (q.kind !== "text" && q.kind !== "longText") return null;
  if (!/^(are|were|was|have|has|had|do|did|is) you\b|^(are|were|have|do|did) (any|you)\b/.test(n)) return null;
  if (PRIOR_APPLICATION.test(n)) return answer("No", "default:no-prior-application");
  if (REFERRED.test(n) || /^were you referred\b/.test(n)) return answer("No", "default:not-referred");
  if (RELATIVES.test(n) && /\b(work|employ|empl|staff|board|director|officer|relationship)\w*/.test(n)) return answer("No", "default:no-relatives-inside");
  if (CONFLICTS.test(n)) return answer("No", "default:no-conflict");
  if (NON_COMPETE.test(n)) return answer("No", "default:no-non-compete");
  const notGov = notGovernment(n, profile);
  if (notGov !== null) return notGov ? answer("No", "default:not-government-official") : GOVERNMENT_HISTORY;
  return null;
}

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
    if (hits.length === 1) return hits[0];
    // "Job Board (Indeed, Monster, etc.)" over "University Job Board"
    // (Palantir on Lever): the general channel, when one is general.
    const general = hits.filter((o) => !/\b(university|campus|school|college|internal)\b/.test(qn(o)));
    return general.length === 1 ? general[0] : null;
  };
  if (stated) {
    const exact = opts.find((o) => qn(o) === stated);
    if (exact) return answer(exact, "source:stated");
    for (const [said, offered] of SOURCE_SYNONYMS) {
      if (!said.test(stated)) continue;
      const hit = unique(offered);
      if (hit) return answer(hit, "source:stated");
      // Several of that channel ("LinkedIn Company Post" | "LinkedIn Employee
      // Post" | "LinkedIn Job Search", Planet on Greenhouse): a posting found
      // through Tailrd was found through a job search.
      const viaSearch = opts.filter((o) => offered.test(qn(o)) && /\bjob (search|post|posting|board|listing|ad)s?\b/.test(qn(o)));
      if (viaSearch.length === 1) return answer(viaSearch[0], "source:stated");
    }
    // A stated channel the list does not offer. A job site is still a job
    // board ("LinkedIn" -> "Online Job Board", below); anything else is
    // "Other", never the default job board ("Career fair" got "Online Job
    // Board" on Paylocity, live 2026-10-03).
    if (!/\b(linked ?in|indeed|glassdoor|monster|zip ?recruiter|job (board|site|search)s?|online)\b/.test(stated)) {
      const other = opts.filter((o) => /^other\b/.test(qn(o)));
      return other.length === 1 ? answer(other[0], "source:stated-other") : null;
    }
  }
  // No stated channel: never a campus one, even as the only careers-site
  // option ("Campus Career Site", Enova on Greenhouse, a real profile
  // 2026-10-03), and among several job searches the one no brand names
  // ("Other - Job Site" beside "LinkedIn Job Search", Planet: left blank).
  const general = opts.filter((o) => !/\b(university|campus|school|college|internal)\b/.test(qn(o)));
  for (const re of SOURCE_PREFERENCE) {
    const hits = general.filter((o) => re.test(qn(o)));
    if (hits.length === 1) return answer(hits[0], "source:default");
    const unbranded = hits.filter((o) => !NAMED_SOURCE.test(qn(o)));
    if (hits.length > 1 && unbranded.length === 1) return answer(unbranded[0], "source:default");
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

  // A follow-up STARTING with "if" ("If you heard about us through a referral,
  // please state…") is not the channel question; an "If referred, by who?"
  // add-on after it is (Kenect on Breezy, live 2026-10-03).
  if (HOW_HEARD.test(n) && !/^\s*if\b/.test(n)) return chooseSource(q, profile);
  const opts = realOptions(q);
  if ((UNLABELED.test(n) || /\b(find|found|hear|heard|learn|learned|discover)\w* (us|about us|this (role|job|position))\b/.test(n)) && opts.filter((o) => CHANNEL.test(qn(o))).length >= 3) {
    return chooseSource(q, profile);
  }
  if (!choiceLike) return unencumberedText(q, n, profile);
  if (CRIMINAL.test(n)) return null;
  // "Will you need an accommodation for your interview?" (Netlify, left blank
  // 2026-10-03): No for an applicant who stated no disability. Anyone else
  // answers it themselves. Read on the device; only the No leaves it.
  if (/\baccommodations?\b/.test(n) && /\b(need|require|request)\w*\b/.test(n) && /\b(interview|hiring|application|recruit\w*)\b/.test(n)) {
    return /^no\b|\bdo not have\b|\bdont have\b/.test(qn(profile.eeo?.disabilityStatus ?? "")) ? polar(false, q, "default:no-accommodation") : null;
  }
  // A required list whose ONLY option is an acknowledgement ("I will read the
  // arbitration agreement below.", Anthropic; "Summer 2027" under "Please
  // confirm the season…", Astranis; live 2026-10-03): there is nothing else
  // to answer.
  if (opts.length === 1 && (ACK_OPTION.test(qn(opts[0])) || /\b(confirm|acknowledge|please read)\b/.test(n)) && !MARKETING.test(qn(opts[0]))) {
    return answer(opts[0], "default:only-option");
  }
  // SMS consent asked by its options under a field-name label ("Phone": "Yes -
  // I consent to receiving text messages", Ramp on Ashby).
  if (n.split(" ").length <= 3 && opts.length > 0 && MARKETING.test(qn(opts.join(" "))) && /\b(consent|opt|receive|receiving|subscribe)\b/.test(qn(opts.join(" ")))) {
    return polar(false, q, "default:marketing-opt-out");
  }

  if (MARKETING.test(n) && !FUTURE_ROLES.test(n)) return polar(false, q, "default:marketing-opt-out");
  if (FUTURE_ROLES.test(n) && /\b(consider|keep|retain|share|contact|notify|would you like|interested)\b/.test(n)) {
    return polar(true, q, "default:future-roles");
  }

  if (PRIOR_APPLICATION.test(n)) return polar(false, q, "default:no-prior-application");
  // "Have you previously worked for this organization" (Commvault): when the
  // company's name is not on the page to check against the profile.
  if (/\b(previously|ever|formerly|before) (worked|been employed) (for|at|with|by) (us|this (company|organi[sz]ation|employer|firm)|our (company|organi[sz]ation))\b/.test(n)) {
    return polar(false, q, "default:not-former-employee");
  }
  if (REFERRED.test(n)) return polar(false, q, "default:not-referred");
  if (RELATIVES.test(n) && /\b(work|employ|empl|staff|board|director|officer|relationship)\w*/.test(n)) {
    return polar(false, q, "default:no-relatives-inside");
  }
  if (CONFLICTS.test(n)) return polar(false, q, "default:no-conflict");
  if (NON_COMPETE.test(n)) return polar(false, q, "default:no-non-compete");
  const notGov = notGovernment(n, profile);
  if (notGov !== null) return notGov ? polar(false, q, "default:not-government-official") : GOVERNMENT_HISTORY;
  // "Are you currently conducting research related to…", "Do you currently
  // receive any active funding (grants, sponsorships)?" (Zoox on Lever, live
  // 2026-10-03): No for someone out of school; a student's lab or grant is theirs.
  if (RESEARCH_OR_FUNDING.test(n)) {
    const entries = facts.education.entries;
    return entries.length > 0 && entries.every((e) => e.completed === true) ? polar(false, q, "default:no-research-or-funding") : null;
  }

  if (DEMOGRAPHIC.test(n)) return null;
  // Being recorded or transcribed (AI notetakers, Palantir on Lever, live
  // 2026-10-03) is the applicant's own choice: never defaulted, nor the AI's.
  if (RECORDING.test(n) && (/\b(consent|opt (in|out)|agree)\b/.test(n) || opts.some((o) => /\bconsent\b/i.test(o)))) {
    return RECORDING_CONSENT;
  }
  if (CONSENT_VERB.test(n) && CONSENT_OBJECT.test(n) && !RECORDING.test(n)) {
    return polar(true, q, "default:consent");
  }
  // A titled policy or agreement with a bare Yes / No and no question in it.
  if (!/\?/.test(q.label) && TITLED_TERMS.test(n) && !RECORDING.test(n) && n.split(" ").length <= 8 && opts.length === 2 && opts.every((o) => /^(yes|no)$/i.test(o.trim()))) {
    return polar(true, q, "default:consent");
  }
  if (/\bessential (functions|duties)\b/.test(n)) return polar(true, q, "default:essential-functions");
  // Working in person somewhere named, for an applicant who will not relocate:
  // "Are you able to work a Hybrid schedule out of Pleasant Grove, Utah?" got
  // Yes for an Austin applicant (Kenect on Breezy, live 2026-10-03). Their own
  // city: Yes; another state or country: No; another city at home: theirs.
  // A question naming no full place ("in one of our offices", "at Mindex's
  // Rochester office") means the posting's own places: Anthropic's San
  // Francisco | New York City | Washington, DC got Yes for an Austin applicant,
  // and so did Mindex's Rochester, New York (live 2026-10-03).
  if (IN_PERSON.test(n) && /^no\b/i.test((profile.willingToRelocate ?? "").trim())) {
    const named = placeInLabel(q.label);
    const posted = (ctx.jobPlaces ?? []).map((p) => placeOf(p)).filter((p) => p.city && (p.region || p.country));
    const places = named ? [named] : posted;
    if (places.length > 0) {
      const home = facts.location;
      const homeCity = isHigh(home.city) ? qn(home.city.value) : null;
      if (homeCity && places.some((p) => p.city === homeCity)) return polar(true, q, "default:in-person-local");
      const homeRegion = isHigh(home.region) ? `${home.region.value.country}:${home.region.value.code}` : null;
      const homeCountry = isHigh(home.country) ? home.country.value.code : null;
      const elsewhere = (p: ReturnType<typeof placeOf>) =>
        Boolean((p.country && homeCountry && p.country !== homeCountry) || (p.region && homeRegion && p.region !== homeRegion));
      return places.every(elsewhere) ? polar(false, q, "default:in-person-not-relocating") : null;
    }
  }
  if (REQUIREMENT.test(n) && !ASSISTANCE.test(n) && (ACK_VERB.test(n) || /^(do|are|will|can|would) you\b/.test(n))) {
    // "Do you have any impediments to traveling internationally?" (Veeva on
    // Lever, live 2026-10-03, answered Yes): an obstacle question's clean answer is No.
    // An obstacle ASKED about ("any impediments", "anticipate challenges"), not
    // one ruled out in the question ("travel with no restrictions").
    if (OBSTACLE.test(n) && /\b(any|anticipate|foresee|are there)\b/.test(n)) return polar(false, q, "default:no-obstacle");
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

