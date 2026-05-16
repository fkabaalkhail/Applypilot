import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { motion } from "framer-motion";
import TypewriterText from "../components/ui/typewriter-text";
import AnimatedSection, {
  StaggerContainer,
  StaggerItem,
  FloatingElement,
  AnimatedCounter,
} from "../components/ui/animated-section";
import AutoApplyShowcase from "../components/ui/AutoApplyShowcase";
import { TiltCard } from "../components/ui/tilt-card";
import "./Landing.css";

const TESTIMONIALS = [
  {
    stars: 5,
    text: "I went from applying to 5 jobs a day to 50+. Got 3 interviews in my first week. This tool is a game changer.",
    name: "Sarah K.",
    role: "Software Engineer → Google",
    avatar: "S",
    photo: "",
  },
  {
    stars: 5,
    text: "The AI-tailored resume feature alone is worth it. My response rate went from 2% to 15% overnight.",
    name: "Marcus T.",
    role: "Data Analyst → Amazon",
    avatar: "M",
    photo: "",
  },
  {
    stars: 5,
    text: "Saved me hours every day. The screening question answers are surprisingly accurate and personalized.",
    name: "Wissam E.",
    role: "Software Developer → Ottawa",
    avatar: "W",
    photo: "/Wissam_Elmasry_testimonial.jpg",
  },
  {
    stars: 5,
    text: "Applied to 200+ jobs in a week without lifting a finger. Landed two offers. Absolutely worth it.",
    name: "James L.",
    role: "Frontend Developer → Meta",
    avatar: "J",
    photo: "",
  },
  {
    stars: 5,
    text: "The cover letter generation is scarily good. Recruiters actually commented on how tailored my applications were.",
    name: "Priya N.",
    role: "UX Designer → Airbnb",
    avatar: "P",
    photo: "",
  },
];

function TestimonialsCarousel() {
  const [current, setCurrent] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [direction, setDirection] = useState<"left" | "right">("right");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentRef = useRef(current);
  const animatingRef = useRef(animating);

  // Keep refs in sync so the interval always sees latest values
  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => { animatingRef.current = animating; }, [animating]);

  const goTo = (index: number, dir: "left" | "right" = "right") => {
    if (animatingRef.current) return;
    setDirection(dir);
    setAnimating(true);
    setTimeout(() => {
      setCurrent(index);
      setAnimating(false);
    }, 350);
  };

  const prev = () => {
    const idx = (currentRef.current - 1 + TESTIMONIALS.length) % TESTIMONIALS.length;
    goTo(idx, "left");
  };

  const next = () => {
    const idx = (currentRef.current + 1) % TESTIMONIALS.length;
    goTo(idx, "right");
  };

  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const idx = (currentRef.current + 1) % TESTIMONIALS.length;
      goTo(idx, "right");
    }, 3000);
  };

  useEffect(() => {
    startTimer();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const resetTimer = () => startTimer();

  const t = TESTIMONIALS[current];

  return (
    <section className="testimonials-section">
      <div className="testimonials-carousel-inner">
        {/* Left: heading + controls */}
        <div className="testimonials-left">
          <span className="testimonials-badge">★ Trusted by job seekers</span>
          <h2 className="testimonials-heading">Loved by the community</h2>
          <p className="testimonials-sub">
            Don't just take our word for it. See what job seekers have to say about ApplyPilot.
          </p>
          <div className="testimonials-controls">
            <button
              className="testimonials-arrow"
              onClick={() => { prev(); resetTimer(); }}
              aria-label="Previous"
            >
              ‹
            </button>
            <div className="testimonials-dots">
              {TESTIMONIALS.map((_, i) => (
                <button
                  key={i}
                  className={`testimonials-dot${i === current ? " active" : ""}`}
                  onClick={() => { goTo(i, i > current ? "right" : "left"); resetTimer(); }}
                  aria-label={`Go to testimonial ${i + 1}`}
                />
              ))}
            </div>
            <button
              className="testimonials-arrow"
              onClick={() => { next(); resetTimer(); }}
              aria-label="Next"
            >
              ›
            </button>
          </div>
        </div>

        {/* Right: card stack */}
        <div className="testimonials-right">
          {/* Ghost cards behind for depth */}
          <div className="testimonial-ghost testimonial-ghost-2" />
          <div className="testimonial-ghost testimonial-ghost-1" />

          {/* Active card */}
          <div
            className={`testimonial-card-carousel${animating ? ` slide-out-${direction}` : " slide-in"}`}
          >
            <div className="testimonial-stars">
              {Array.from({ length: t.stars }).map((_, i) => (
                <span key={i}>★</span>
              ))}
            </div>
            <p className="testimonial-text">"{t.text}"</p>
            <div className="testimonial-author">
              <div className="testimonial-avatar">
                {t.photo ? (
                  <img
                    src={t.photo}
                    alt={t.name}
                    onError={(e) => {
                      const el = e.currentTarget as HTMLImageElement;
                      el.style.display = "none";
                      const fallback = el.nextElementSibling as HTMLElement;
                      if (fallback) fallback.style.display = "flex";
                    }}
                  />
                ) : null}
                <span
                  className="testimonial-avatar-fallback"
                  style={{ display: t.photo ? "none" : "flex" }}
                >
                  {t.avatar}
                </span>
              </div>
              <div>
                <div className="testimonial-name">{t.name}</div>
                <div className="testimonial-role">{t.role}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const SUCCESS_STORIES = [
  {
    img: "/interview_offer.png",
    alt: "Interview invitation letter",
    badge: "Interview Secured ✓",
    initials: "FA",
    name: "Ahmed A. — Applied for Software Engineer role in Ottawa",
    quote: '"Tailrd helped me land this interview in under a week."',
  },
  {
    img: "/interview_offer_2.png",
    alt: "Second interview offer letter",
    badge: "Offer Received ✓",
    initials: "TR",
    name: "Tristan R. — Applied for Software Developer role in Ottawa",
    quote: '"Got two offers in 10 days. The AI tailoring made all the difference."',
  },
];

function SuccessStoryCarousel() {
  const [current, setCurrent] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [dir, setDir] = useState<"left" | "right">("right");

  function goTo(index: number, direction: "left" | "right") {
    if (animating || index === current) return;
    setDir(direction);
    setAnimating(true);
    setTimeout(() => {
      setCurrent(index);
      setAnimating(false);
    }, 320);
  }

  const prev = () => goTo((current - 1 + SUCCESS_STORIES.length) % SUCCESS_STORIES.length, "left");
  const next = () => goTo((current + 1) % SUCCESS_STORIES.length, "right");

  const story = SUCCESS_STORIES[current];

  return (
    <div className="success-story-card-wrapper">
      <TiltCard className="success-story-card">
        <div className="success-story-badge">{story.badge}</div>
        <div
          className={`success-story-letter-scroll story-slide${animating ? ` story-slide-out-${dir}` : " story-slide-in"}`}
        >
          <img
            src={story.img}
            alt={story.alt}
            className="success-story-letter-img"
          />
        </div>
      </TiltCard>

      {/* Navigation */}
      <div className="success-story-nav">
        <button
          className="story-nav-btn"
          onClick={prev}
          aria-label="Previous letter"
        >
          ‹
        </button>
        <div className="story-nav-dots">
          {SUCCESS_STORIES.map((_, i) => (
            <button
              key={i}
              className={`story-nav-dot${i === current ? " active" : ""}`}
              onClick={() => goTo(i, i > current ? "right" : "left")}
              aria-label={`Go to letter ${i + 1}`}
            />
          ))}
        </div>
        <button
          className="story-nav-btn"
          onClick={next}
          aria-label="Next letter"
        >
          ›
        </button>
      </div>

      <div className="success-story-caption">
        <div className="success-story-avatar">
          <span className="success-story-initials">{story.initials}</span>
        </div>
        <div className="success-story-meta">
          <span className="success-story-name">{story.name}</span>
          <div className="success-story-stars">★★★★★</div>
          <span className="success-story-quote">{story.quote}</span>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const faqs = [
    { q: "How is Tailrd different from other job platforms like LinkedIn?", a: "Tailrd uses AI to automatically fill out applications for you, match you with jobs based on your real skills, and tailor your resume for each role — all running locally on your machine for maximum privacy." },
    { q: "Will Tailrd share my personal information?", a: "Never. Your data stays on your machine. We don't upload your resume, credentials, or personal info to any cloud server. Everything runs locally." },
    { q: "Is Tailrd free to use?", a: "Yes! You can start with our free tier which includes 10 auto-applies per day. Upgrade to Pro for unlimited applications and advanced AI features." },
    { q: "How does the auto-apply feature work?", a: "Tailrd uses your Chrome browser with AI to fill out LinkedIn Easy Apply forms automatically — answering screening questions, uploading your resume, and submitting applications while you focus on other things." },
    { q: "What job platforms does Tailrd support?", a: "Currently we support LinkedIn Easy Apply jobs. Support for Greenhouse, Lever, and other ATS platforms is coming soon." },
    { q: "I have more questions!", a: "Reach out to us at support@tailrd.app and we'll get back to you within 24 hours." },
  ];

  return (
    <div className="landing">
      {/* Nav */}
      <nav className="landing-nav">
        <div className="landing-nav-inner">
          <div className="landing-brand">
            <img src="/logo-icon.png" alt="Tailrd" className="landing-logo-img" />
            <span className="landing-logo-text">Tailrd</span>
          </div>
          <div className="landing-nav-links">
            <a href="#features" className="nav-link-item">Features</a>
            <a href="#pricing" className="nav-link-item">Pricing</a>
            <a href="#success-story" className="nav-link-item">Results</a>
            <a href="#faq" className="nav-link-item">FAQ</a>
          </div>
          <div className="landing-nav-actions">
            {isAuthenticated ? (
              <button className="btn-cta nav-cta" onClick={() => navigate("/app")}>Dashboard</button>
            ) : (
              <>
                <button className="btn-ghost nav-login" onClick={() => navigate("/sign-in")}>Log in</button>
                <button className="btn-cta nav-cta" onClick={() => navigate("/sign-up")}>Sign up</button>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Hero — Full viewport height */}
      <section className="hero">
        <div className="hero-bg"></div>
        {/* Floating decorative orbs */}
        <FloatingElement className="hero-orb hero-orb-1" duration={4} distance={15} />
        <FloatingElement className="hero-orb hero-orb-2" duration={5} distance={12} />
        <FloatingElement className="hero-orb hero-orb-3" duration={6} distance={8} />
        <div className="hero-content">
          <motion.div
            className="hero-left"
            initial={{ opacity: 0, x: -80 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.9, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="hero-mockup">
              <div className="mockup-window">
                <div className="mockup-dots">
                  <span></span><span></span><span></span>
                </div>
                <div className="mockup-body">
                  <div className="mockup-sidebar">
                    <div className="mockup-sidebar-item active">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B5BFF" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
                    </div>
                    <div className="mockup-sidebar-item">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </div>
                    <div className="mockup-sidebar-item">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    </div>
                    <div className="mockup-sidebar-item">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    </div>
                  </div>
                  <div className="mockup-main">
                    <div className="mockup-header">
                      <div className="mockup-header-top">
                        
                      </div>
                      <div className="mockup-search">
                        <span className="mockup-search-icon">🔍</span>
                        <span className="mockup-search-text">Search jobs, companies...</span>
                      </div>
                      <div className="mockup-filter-row">
                        <span className="mockup-filter-chip active">All Jobs</span>
                        <span className="mockup-filter-chip">Remote</span>
                        <span className="mockup-filter-chip">Canada</span>
                        <span className="mockup-filter-chip">Full-time</span>
                      </div>
                    </div>
                    <motion.div
                      className="mockup-card"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.6, duration: 0.5 }}
                    >
                      <div className="mockup-card-icon">
                        <img src="https://www.google.com/s2/favicons?domain=google.com&sz=32" alt="Google" />
                      </div>
                      <div className="mockup-card-content">
                        <div className="mockup-card-title">Senior Software Engineer</div>
                        <div className="mockup-card-sub">Google • Mountain View, CA</div>
                        <div className="mockup-tags">
                          <span className="mockup-tag">Python</span>
                          <span className="mockup-tag">React</span>
                          <span className="mockup-tag">AWS</span>
                        </div>
                      </div>
                      <div className="mockup-match">95%</div>
                    </motion.div>
                    <motion.div
                      className="mockup-card"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.9, duration: 0.5 }}
                    >
                      <div className="mockup-card-icon mini">
                        <img src="https://www.google.com/s2/favicons?domain=meta.com&sz=32" alt="Meta" />
                      </div>
                      <div className="mockup-card-content">
                        <div className="mockup-card-title">Backend Engineer</div>
                        <div className="mockup-card-sub">Meta • Remote</div>
                        <div className="mockup-tags">
                          <span className="mockup-tag">Java</span>
                          <span className="mockup-tag">Microservices</span>
                        </div>
                      </div>
                      <div className="mockup-match">88%</div>
                    </motion.div>
                    <motion.div
                      className="mockup-card"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 1.2, duration: 0.5 }}
                    >
                      <div className="mockup-card-icon mini">
                        <img src="https://www.google.com/s2/favicons?domain=shopify.com&sz=32" alt="Shopify" />
                      </div>
                      <div className="mockup-card-content">
                        <div className="mockup-card-title">Full Stack Developer</div>
                        <div className="mockup-card-sub">Shopify • Ottawa, ON</div>
                        <div className="mockup-tags">
                          <span className="mockup-tag">TypeScript</span>
                          <span className="mockup-tag">Node.js</span>
                        </div>
                      </div>
                      <div className="mockup-match">91%</div>
                    </motion.div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
          <motion.div
            className="hero-right"
            initial={{ opacity: 0, x: 80 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.9, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            <motion.p
              className="hero-eyebrow"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.6 }}
            >
              No More Solo Job Hunting
            </motion.p>
            <h1 className="hero-headline">
              <TypewriterText
                text="Do it with AI"
                speed={90}
                delay={800}
                showCursor={true}
                className="hero-headline-typed"
              />
            </h1>
            <motion.p
              className="hero-sub"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 2.2, duration: 0.6 }}
            >
              Get matched jobs, autofill applications, tailored resume, and
              AI-powered answers to screening questions — in less than 1 min!
            </motion.p>
            <motion.div
              className="hero-actions"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 2.6, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            >
              <button className="btn-cta-hero" onClick={() => navigate("/app")}>
                TRY FOR FREE
              </button>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Live Auto-Apply Demo — Top Showcase */}
      <section className="showcase-section showcase-demo-section">
        <div className="showcase-demo-wrapper">
          <motion.div
            className="showcase-demo-header"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 2.8, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className="showcase-demo-eyebrow">SEE IT IN ACTION</span>
            <h2 className="showcase-title">Watch Tailrd Work For You</h2>
            <p className="showcase-desc">
              While you relax, our AI scans job postings, extracts keywords,
              tailors your resume, and fills applications — all in seconds.
            </p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 3.0, ease: [0.16, 1, 0.3, 1] }}
          >
            <AutoApplyShowcase />
          </motion.div>
        </div>
      </section>

      {/* Stats Section */}
      <AnimatedSection animation="fadeUp">
        <section className="stats-section-light" id="stats">
          <div className="stats-content-light">
            <AnimatedSection className="stats-left-light" animation="fadeLeft" delay={0.1}>
              <span className="stats-eyebrow-light">OUR TRACK RECORD</span>
              <h2 className="stats-headline-light">
                <TypewriterText
                  text="Real results, not just promises."
                  speed={50}
                  triggerOnView={true}
                  showCursor={false}
                  className=""
                />
              </h2>
              <p className="stats-sub-light">
                Trusted by over a million job seekers to land interviews faster
                and cut the time spent searching.
              </p>
              <button className="btn-dark" onClick={() => navigate("#features")}>
                See how it works ↗
              </button>
            </AnimatedSection>
            <StaggerContainer className="stats-right-light" staggerDelay={0.15}>
              <StaggerItem>
                <div className="stat-card-light">
                  <div className="stat-icon-light">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                      <circle cx="9" cy="7" r="4"/>
                      <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
                      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                  </div>
                  <div className="stat-info-light">
                    <span className="stat-number-light"><AnimatedCounter value={3} suffix="× more interviews" /></span>
                    <span className="stat-label-light">compared to manual applications</span>
                  </div>
                </div>
              </StaggerItem>
              <StaggerItem>
                <div className="stat-card-light">
                  <div className="stat-icon-light">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#14b8a6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                  </div>
                  <div className="stat-info-light">
                    <span className="stat-number-light"><AnimatedCounter value={80} suffix="% time saved" /></span>
                    <span className="stat-label-light">on the average job search</span>
                  </div>
                </div>
              </StaggerItem>
              <StaggerItem>
                <div className="stat-card-light">
                  <div className="stat-icon-light">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5B5BFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                  </div>
                  <div className="stat-info-light">
                    <span className="stat-number-light">No. 1 choice</span>
                    <span className="stat-label-light">for <AnimatedCounter value={80} suffix="%" /> of users after first use</span>
                  </div>
                </div>
              </StaggerItem>
            </StaggerContainer>
          </div>
        </section>
      </AnimatedSection>

      {/* Feature Showcase 1: AI Job Matches */}
      <AnimatedSection animation="fadeUp">
        <section className="showcase-section" id="features">
          <div className="showcase-content">
            <AnimatedSection className="showcase-text" animation="fadeLeft" delay={0.2}>
              <h2 className="showcase-title">
                <TypewriterText
                  text="Your Skills, Ranked & Matched"
                  speed={45}
                  triggerOnView={true}
                  showCursor={false}
                  className=""
                />
              </h2>
              <p className="showcase-desc">
                Our AI reads the job description and your resume side by side,
                then scores how well you fit — so you only spend time on roles
                where you actually have a shot.
              </p>
              <button className="btn-dark" onClick={() => navigate("/app")}>See My Fit Score</button>
            </AnimatedSection>
            <AnimatedSection className="showcase-visual" animation="fadeRight" delay={0.3}>
              <div className="showcase-card match-card">
                <div className="match-card-header">
                  <span className="match-time">1 hour ago</span>
                  <div className="match-score-circle big">
                    <span className="match-score-num">95</span>
                    <span className="match-score-pct">%</span>
                    <span className="match-score-label">Overall</span>
                  </div>
                </div>
                <div className="match-card-job">
                  <div className="match-job-icon">
                    <img src="https://www.google.com/s2/favicons?domain=runway.com&sz=32" alt="Runway" style={{ width: '24px', height: '24px', borderRadius: '4px' }} />
                  </div>
                  <div>
                    <div className="match-job-title">Senior Data Analyst</div>
                    <div className="match-job-company">Runway • New York, NY</div>
                  </div>
                </div>
                <div className="match-scores-row">
                  <div className="match-mini-score">
                    <div className="mini-score-circle">95<span>%</span></div>
                    <span>Exp. Level</span>
                  </div>
                  <div className="match-mini-score">
                    <div className="mini-score-circle">93<span>%</span></div>
                    <span>Skill</span>
                  </div>
                  <div className="match-mini-score">
                    <div className="mini-score-circle">96<span>%</span></div>
                    <span>Industry Exp.</span>
                  </div>
                </div>
                <div className="match-fit">
                  <div className="match-fit-title">Why You Are A Good Fit</div>
                  <div className="match-fit-tag good">✓ Experience Level</div>
                  <div className="match-fit-tag good">✓ Technical Skills</div>
                  <div className="match-fit-tag warn">✕ Education</div>
                </div>
              </div>
            </AnimatedSection>
          </div>
        </section>
      </AnimatedSection>

      {/* Feature Showcase 2: 1-Click Autofill */}
      <AnimatedSection animation="fadeUp">
        <section className="showcase-section showcase-reverse">
          <div className="showcase-content">
            <AnimatedSection className="showcase-text" animation="fadeRight" delay={0.2}>
              <h2 className="showcase-title">
                <TypewriterText
                  text="Hands-Free Application Engine"
                  speed={45}
                  triggerOnView={true}
                  showCursor={false}
                  className=""
                />
              </h2>
              <p className="showcase-desc">
                Point it at a job posting and walk away. Tailrd fills every field,
                answers screening questions, and submits — you just review the
                confirmation email.
              </p>
              <button className="btn-dark" onClick={() => navigate("/app")}>Let It Apply For Me</button>
            </AnimatedSection>
            <AnimatedSection className="showcase-visual" animation="fadeLeft" delay={0.3}>
              <div className="showcase-card autofill-card">
                <div className="autofill-header">
                  <img src="/logo-icon.png" alt="Tailrd" className="autofill-logo" />
                  <span className="autofill-brand">Tailrd</span>
                </div>
                <div className="autofill-job">
                  <div className="autofill-job-icon">
                    <img src="https://www.google.com/s2/favicons?domain=runway.com&sz=32" alt="Runway" style={{ width: '24px', height: '24px', borderRadius: '4px' }} />
                  </div>
                  <div className="autofill-job-info">
                    <div className="autofill-company">Runway • Artificial Intelligence(AI)</div>
                    <div className="autofill-title">Product Manager, Analytics</div>
                    <div className="autofill-meta">11hr ago · 49 applicants</div>
                  </div>
                  <div className="autofill-score">80%</div>
                </div>
                <button className="autofill-btn">Autofill</button>
                <div className="autofill-credits">8 Remaining Credits</div>
                <div className="autofill-progress">
                  <div className="autofill-progress-label">
                    <strong>Completion</strong> <span>83%</span>
                  </div>
                  <div className="autofill-progress-bar">
                    <div className="autofill-progress-fill"></div>
                  </div>
                </div>
                <div className="autofill-fields">
                  <div className="autofill-field-title">Required (10/12 filled)</div>
                  <div className="autofill-field"><span className="field-check">✓</span> Name</div>
                  <div className="autofill-field"><span className="field-check">✓</span> Phone</div>
                  <div className="autofill-field"><span className="field-check">✓</span> Email</div>
                  <div className="autofill-field"><span className="field-check">✓</span> LinkedIn URL</div>
                  <div className="autofill-field"><span className="field-dash">—</span> Experience</div>
                  <div className="autofill-field"><span className="field-dash">—</span> Cover Letter</div>
                </div>
              </div>
            </AnimatedSection>
          </div>
        </section>
      </AnimatedSection>

      {/* Feature Showcase 3: Resume Tailoring */}
      <AnimatedSection animation="fadeUp">
        <section className="showcase-section">
          <div className="showcase-content">
            <AnimatedSection className="showcase-text" animation="fadeLeft" delay={0.2}>
              <h2 className="showcase-title">
                <TypewriterText
                  text="A New Resume for Every Role"
                  speed={45}
                  triggerOnView={true}
                  showCursor={false}
                  className=""
                />
              </h2>
              <p className="showcase-desc">
                Each application gets its own version of your resume — rewritten
                to mirror the job's language, highlight relevant wins, and sail
                through ATS filters.
              </p>
              <ul className="showcase-bullets">
                <li>✓ Mirrors keywords from the posting</li>
                <li>✓ Reorders sections by relevance</li>
                <li>✓ Adds metrics the recruiter cares about</li>
                <li>✓ Passes automated screening tools</li>
              </ul>
              <button className="btn-dark" onClick={() => navigate("/app")}>Build My Resume</button>
            </AnimatedSection>
            <AnimatedSection className="showcase-visual" animation="fadeRight" delay={0.3}>
              <div className="showcase-card resume-card">
                <div className="resume-header">
                  <div className="resume-star">✦</div>
                  <div className="resume-name">Jamie Parker</div>
                  <div className="resume-score-badge">
                    <span className="resume-score-num">9.0</span>
                    <span className="resume-score-label">EXCELLENT</span>
                  </div>
                </div>
                <div className="resume-target-job">
                  <span className="resume-target-label">Tailored for:</span>
                  <span className="resume-target-value">Senior Software Engineer at Google</span>
                </div>
                <div className="resume-section">
                  <div className="resume-section-title">PROFESSIONAL SUMMARY</div>
                  <div className="resume-lines">
                    <div className="resume-line"></div>
                    <div className="resume-line short"></div>
                  </div>
                </div>
                <div className="resume-section">
                  <div className="resume-section-title">SKILLS</div>
                  <div className="resume-skill-tags">
                    <span className="resume-skill-tag highlighted">Python</span>
                    <span className="resume-skill-tag highlighted">React</span>
                    <span className="resume-skill-tag highlighted">AWS</span>
                    <span className="resume-skill-tag">Docker</span>
                    <span className="resume-skill-tag">TypeScript</span>
                    <span className="resume-skill-tag highlighted">System Design</span>
                  </div>
                </div>
                <div className="resume-section">
                  <div className="resume-section-title">EXPERIENCE</div>
                  <div className="resume-exp-item">
                    <div className="resume-exp-header">
                      <span className="resume-exp-role">Lead Engineer</span>
                      <span className="resume-exp-date">2022 - Present</span>
                    </div>
                    <div className="resume-exp-company">TechCorp Inc.</div>
                    <div className="resume-lines">
                      <div className="resume-line"></div>
                      <div className="resume-line short"></div>
                    </div>
                  </div>
                  <div className="resume-exp-item">
                    <div className="resume-exp-header">
                      <span className="resume-exp-role">Software Engineer</span>
                      <span className="resume-exp-date">2019 - 2022</span>
                    </div>
                    <div className="resume-exp-company">StartupXYZ</div>
                    <div className="resume-lines">
                      <div className="resume-line"></div>
                      <div className="resume-line short"></div>
                    </div>
                  </div>
                </div>
                <div className="resume-section">
                  <div className="resume-section-title">EDUCATION</div>
                  <div className="resume-lines">
                    <div className="resume-line"></div>
                  </div>
                </div>
                <div className="resume-enhancements">
                  <span className="enhancement-tag">✦ Summary Enhanced</span>
                  <span className="enhancement-tag">✦ Relevant Skills Highlighted</span>
                  <span className="enhancement-tag">✦ Keywords Optimized</span>
                  <span className="enhancement-tag">✦ Recent Work Experience Enhanced</span>
                </div>
              </div>
            </AnimatedSection>
          </div>
        </section>
      </AnimatedSection>

      {/* Trusted By Companies — Continuous Carousel */}
      <AnimatedSection animation="fadeUp">
        <section className="companies-section">
          <p className="companies-label">Trusted by job seekers applying to</p>
          <div className="companies-carousel-wrapper">
            <div className="companies-carousel-track">
              {/* First set */}
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=google.com&sz=32" alt="Google" className="company-favicon" />
                <span className="company-name">Google</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=meta.com&sz=32" alt="Meta" className="company-favicon" />
                <span className="company-name">Meta</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=amazon.com&sz=32" alt="Amazon" className="company-favicon" />
                <span className="company-name">Amazon</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=microsoft.com&sz=32" alt="Microsoft" className="company-favicon" />
                <span className="company-name">Microsoft</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=apple.com&sz=32" alt="Apple" className="company-favicon" />
                <span className="company-name">Apple</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=netflix.com&sz=32" alt="Netflix" className="company-favicon" />
                <span className="company-name">Netflix</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=shopify.com&sz=32" alt="Shopify" className="company-favicon" />
                <span className="company-name">Shopify</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=stripe.com&sz=32" alt="Stripe" className="company-favicon" />
                <span className="company-name">Stripe</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=airbnb.com&sz=32" alt="Airbnb" className="company-favicon" />
                <span className="company-name">Airbnb</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=uber.com&sz=32" alt="Uber" className="company-favicon" />
                <span className="company-name">Uber</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=salesforce.com&sz=32" alt="Salesforce" className="company-favicon" />
                <span className="company-name">Salesforce</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=spotify.com&sz=32" alt="Spotify" className="company-favicon" />
                <span className="company-name">Spotify</span>
              </span>
              {/* Duplicate set for seamless loop */}
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=google.com&sz=32" alt="Google" className="company-favicon" />
                <span className="company-name">Google</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=meta.com&sz=32" alt="Meta" className="company-favicon" />
                <span className="company-name">Meta</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=amazon.com&sz=32" alt="Amazon" className="company-favicon" />
                <span className="company-name">Amazon</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=microsoft.com&sz=32" alt="Microsoft" className="company-favicon" />
                <span className="company-name">Microsoft</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=apple.com&sz=32" alt="Apple" className="company-favicon" />
                <span className="company-name">Apple</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=netflix.com&sz=32" alt="Netflix" className="company-favicon" />
                <span className="company-name">Netflix</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=shopify.com&sz=32" alt="Shopify" className="company-favicon" />
                <span className="company-name">Shopify</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=stripe.com&sz=32" alt="Stripe" className="company-favicon" />
                <span className="company-name">Stripe</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=airbnb.com&sz=32" alt="Airbnb" className="company-favicon" />
                <span className="company-name">Airbnb</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=uber.com&sz=32" alt="Uber" className="company-favicon" />
                <span className="company-name">Uber</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=salesforce.com&sz=32" alt="Salesforce" className="company-favicon" />
                <span className="company-name">Salesforce</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=spotify.com&sz=32" alt="Spotify" className="company-favicon" />
                <span className="company-name">Spotify</span>
              </span>
              {/* Third set for seamless loop */}
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=google.com&sz=32" alt="Google" className="company-favicon" />
                <span className="company-name">Google</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=meta.com&sz=32" alt="Meta" className="company-favicon" />
                <span className="company-name">Meta</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=amazon.com&sz=32" alt="Amazon" className="company-favicon" />
                <span className="company-name">Amazon</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=microsoft.com&sz=32" alt="Microsoft" className="company-favicon" />
                <span className="company-name">Microsoft</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=apple.com&sz=32" alt="Apple" className="company-favicon" />
                <span className="company-name">Apple</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=netflix.com&sz=32" alt="Netflix" className="company-favicon" />
                <span className="company-name">Netflix</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=shopify.com&sz=32" alt="Shopify" className="company-favicon" />
                <span className="company-name">Shopify</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=stripe.com&sz=32" alt="Stripe" className="company-favicon" />
                <span className="company-name">Stripe</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=airbnb.com&sz=32" alt="Airbnb" className="company-favicon" />
                <span className="company-name">Airbnb</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=uber.com&sz=32" alt="Uber" className="company-favicon" />
                <span className="company-name">Uber</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=salesforce.com&sz=32" alt="Salesforce" className="company-favicon" />
                <span className="company-name">Salesforce</span>
              </span>
              <span className="company-logo">
                <img src="https://www.google.com/s2/favicons?domain=spotify.com&sz=32" alt="Spotify" className="company-favicon" />
                <span className="company-name">Spotify</span>
              </span>
            </div>
          </div>
        </section>
      </AnimatedSection>

      {/* Testimonials */}
      <TestimonialsCarousel />

      {/* Success Story */}
      <AnimatedSection animation="fadeUp">
        <section className="success-story-section" id="success-story">
          <div className="success-story-inner">
            <div className="success-story-headline">
              <span className="success-story-eyebrow">PROOF, NOT PROMISES</span>
              <h2 className="success-story-title">Real Results from Real Users</h2>
              <p className="success-story-sub">Our users don't just apply — they get invited to interview.</p>
            </div>

            <SuccessStoryCarousel />
          </div>
        </section>
      </AnimatedSection>

      {/* Pricing */}
      <AnimatedSection animation="fadeUp">
        <section className="section" id="pricing">
          <h2 className="section-title">Simple Pricing</h2>
          <p className="section-sub">Start free, upgrade when you're ready</p>
          <StaggerContainer className="pricing-grid" staggerDelay={0.15}>
            <StaggerItem animation="fadeUp">
              <div className="pricing-card">
                <h3>Free</h3>
                <div className="pricing-price">$0<span>/month</span></div>
                <ul className="pricing-features">
                  <li>✓ 10 auto-applies per day</li>
                  <li>✓ Basic job matching</li>
                  <li>✓ Application tracker</li>
                  <li>✓ 1 resume profile</li>
                </ul>
                <button className="btn-outline-lg w-full" onClick={() => navigate("/app")}>Get Started</button>
              </div>
            </StaggerItem>
            <StaggerItem animation="fadeUp">
              <div className="pricing-card pricing-featured">
                <div className="pricing-badge">Most Popular</div>
                <h3>Pro</h3>
                <div className="pricing-price">$29<span>/month</span></div>
                <ul className="pricing-features">
                  <li>✓ Unlimited auto-applies</li>
                  <li>✓ AI screening answers</li>
                  <li>✓ Resume tailoring per job</li>
                  <li>✓ Cover letter generation</li>
                  <li>✓ Priority AI processing</li>
                  <li>✓ Advanced match scoring</li>
                </ul>
                <button className="btn-cta btn-lg w-full" onClick={() => navigate("/app")}>Start Pro Trial</button>
              </div>
            </StaggerItem>
            <StaggerItem animation="fadeUp">
              <div className="pricing-card">
                <h3>Lifetime</h3>
                <div className="pricing-price">$149<span>one-time</span></div>
                <ul className="pricing-features">
                  <li>✓ Everything in Pro</li>
                  <li>✓ Lifetime updates</li>
                  <li>✓ Priority support</li>
                  <li>✓ Early access to features</li>
                  <li>✓ No recurring fees</li>
                </ul>
                <button className="btn-outline-lg w-full" onClick={() => navigate("/app")}>Get Lifetime</button>
              </div>
            </StaggerItem>
          </StaggerContainer>
        </section>
      </AnimatedSection>

      {/* FAQ */}
      <AnimatedSection animation="fadeUp">
        <section className="faq-section" id="faq">
          <h2 className="faq-title">
            <TypewriterText
              text="Frequently Asked Questions"
              speed={40}
              triggerOnView={true}
              showCursor={false}
              className=""
            />
          </h2>
          <StaggerContainer className="faq-list" staggerDelay={0.1}>
            {faqs.map((faq, i) => (
              <StaggerItem key={i}>
                <div className={`faq-item ${openFaq === i ? "open" : ""}`}>
                  <button className="faq-question" onClick={() => setOpenFaq(openFaq === i ? null : i)}>
                    <span>{faq.q}</span>
                    <span className="faq-toggle">{openFaq === i ? "−" : "+"}</span>
                  </button>
                  {openFaq === i && (
                    <motion.div
                      className="faq-answer"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                    >
                      {faq.a}
                    </motion.div>
                  )}
                </div>
              </StaggerItem>
            ))}
          </StaggerContainer>
        </section>
      </AnimatedSection>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-inner">
          <div className="footer-col">
            <div className="footer-brand">
              <img src="/logo-icon.png" alt="Tailrd" className="landing-logo-img" />
              <span className="landing-logo-text">Tailrd</span>
            </div>
            <p className="footer-tagline">AI-powered job applications.<br />Apply smarter, not harder.</p>
          </div>
          <div className="footer-col">
            <h4>Product</h4>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="footer-col">
            <h4>Company</h4>
            <a href="#">About</a>
            <a href="#">Blog</a>
            <a href="#">Careers</a>
          </div>
          <div className="footer-col">
            <h4>Legal</h4>
            <a href="#">Privacy Policy</a>
            <a href="#">Terms of Service</a>
            <a href="#">Cookie Policy</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© 2026 Tailrd. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
