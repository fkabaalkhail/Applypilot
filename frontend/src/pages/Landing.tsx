import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "./Landing.css";

function useScrollReveal() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return { ref, visible };
}

export default function Landing() {
  const navigate = useNavigate();
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const revealStats = useScrollReveal();
  const reveal1 = useScrollReveal();
  const reveal2 = useScrollReveal();
  const reveal3 = useScrollReveal();
  const revealCompanies = useScrollReveal();
  const revealPricing = useScrollReveal();
  const revealFaq = useScrollReveal();
  const revealBanner = useScrollReveal();

  const faqs = [
    { q: "How is Resumate different from other job platforms like LinkedIn?", a: "Resumate uses AI to automatically fill out applications for you, match you with jobs based on your real skills, and tailor your resume for each role — all running locally on your machine for maximum privacy." },
    { q: "Will Resumate share my personal information?", a: "Never. Your data stays on your machine. We don't upload your resume, credentials, or personal info to any cloud server. Everything runs locally." },
    { q: "Is Resumate free to use?", a: "Yes! You can start with our free tier which includes 10 auto-applies per day. Upgrade to Pro for unlimited applications and advanced AI features." },
    { q: "How does the auto-apply feature work?", a: "Resumate uses your Chrome browser with AI to fill out LinkedIn Easy Apply forms automatically — answering screening questions, uploading your resume, and submitting applications while you focus on other things." },
    { q: "What job platforms does Resumate support?", a: "Currently we support LinkedIn Easy Apply jobs. Support for Greenhouse, Lever, and other ATS platforms is coming soon." },
    { q: "I have more questions!", a: "Reach out to us at support@resumate.app and we'll get back to you within 24 hours." },
  ];

  return (
    <div className="landing">
      {/* Nav */}
      <nav className="landing-nav">
        <div className="landing-nav-inner">
          <div className="landing-brand">
            <img src="/logo-icon.png" alt="Resumate" className="landing-logo-img" />
            <span className="landing-logo-text">Resumate</span>
          </div>
          <div className="landing-nav-links">
            <a href="#features">Features</a>
            <a href="#stats">Results</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="landing-nav-actions">
            <button className="btn-ghost" onClick={() => navigate("/app")}>Sign In</button>
            <button className="btn-cta" onClick={() => navigate("/app")}>Get Started</button>
          </div>
        </div>
      </nav>

      {/* Hero — Full viewport height */}
      <section className="hero">
        <div className="hero-bg"></div>
        <div className="hero-content">
          <div className="hero-left">
            <div className="hero-mockup">
              <div className="mockup-window">
                <div className="mockup-dots">
                  <span></span><span></span><span></span>
                </div>
                <div className="mockup-body">
                  <div className="mockup-sidebar">
                    <div className="mockup-sidebar-item active"></div>
                    <div className="mockup-sidebar-item"></div>
                    <div className="mockup-sidebar-item"></div>
                    <div className="mockup-sidebar-item"></div>
                  </div>
                  <div className="mockup-main">
                    <div className="mockup-header">
                      <div className="mockup-search"></div>
                    </div>
                    <div className="mockup-card">
                      <div className="mockup-card-icon">
                        <img src="/logo-icon.png" alt="" />
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
                    </div>
                    <div className="mockup-card">
                      <div className="mockup-card-icon mini">
                        <div className="mockup-icon-placeholder"></div>
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
                    </div>
                    <div className="mockup-card">
                      <div className="mockup-card-icon mini">
                        <div className="mockup-icon-placeholder green"></div>
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
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="hero-right">
            <p className="hero-eyebrow">No More Solo Job Hunting</p>
            <h1 className="hero-headline">Do it with <span className="hero-accent">AI</span></h1>
            <p className="hero-sub">
              Get matched jobs, autofill applications, tailored resume, and
              AI-powered answers to screening questions — in less than 1 min!
            </p>
            <div className="hero-actions">
              <button className="btn-cta-hero" onClick={() => navigate("/app")}>
                TRY FOR FREE
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Social Proof Bar */}
      <section className="social-proof">
        <div className="social-proof-inner">
          <div className="proof-badge">
            <div className="proof-laurel">🏆</div>
            <span className="proof-label">Product of the Month</span>
            <strong>1st</strong>
          </div>
          <div className="proof-divider"></div>
          <div className="proof-badge">
            <div className="proof-laurel">⭐</div>
            <span className="proof-label">Featured by</span>
            <strong>TOP PICK</strong>
          </div>
          <div className="proof-divider"></div>
          <div className="proof-badge">
            <div className="proof-laurel">★★★★★</div>
            <span className="proof-label">Trustpilot Reviews</span>
            <strong>4.8/5.0</strong>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <div ref={revealStats.ref} className={`reveal ${revealStats.visible ? "revealed" : ""}`}>
        <section className="section stats-section" id="stats">
          <div className="stats-content">
            <div className="stats-left">
              <h2 className="stats-headline">REAL RESULTS, NOT<br />JUST PROMISES</h2>
            </div>
            <div className="stats-right">
              <div className="stat-row">
                <div className="stat-info">
                  <span className="stat-number">1,250,000</span>
                  <span className="stat-label">trusted users</span>
                </div>
                <div className="stat-icon">😊</div>
              </div>
              <div className="stat-row">
                <div className="stat-info">
                  <span className="stat-number">3x</span>
                  <span className="stat-label">interviews landed</span>
                </div>
                <div className="stat-icon">�</div>
              </div>
              <div className="stat-row">
                <div className="stat-info">
                  <span className="stat-number">80%</span>
                  <span className="stat-label">time saved on job search</span>
                </div>
                <div className="stat-icon">⏱️</div>
              </div>
              <div className="stat-row">
                <div className="stat-info">
                  <span className="stat-number">No.1 Choice</span>
                  <span className="stat-label">for 80% of job seekers after their first use</span>
                </div>
                <div className="stat-icon">✓</div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Feature Showcase 1: AI Job Matches */}
      <div ref={reveal1.ref} className={`reveal ${reveal1.visible ? "revealed" : ""}`}>
        <section className="showcase-section" id="features">
          <div className="showcase-content">
            <div className="showcase-text">
              <h2 className="showcase-title">Personalized AI<br />Job Matches</h2>
              <p className="showcase-desc">
                See jobs you're truly qualified for, matched to your real skills,
                with no fake listings and early alerts.
              </p>
              <button className="btn-dark" onClick={() => navigate("/app")}>Find My Matches</button>
            </div>
            <div className="showcase-visual">
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
                  <div className="match-job-icon"></div>
                  <div>
                    <div className="match-job-title">Senior Data Analyst</div>
                    <div className="match-job-company">Runway</div>
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
            </div>
          </div>
        </section>
      </div>

      {/* Feature Showcase 2: 1-Click Autofill */}
      <div ref={reveal2.ref} className={`reveal ${reveal2.visible ? "revealed" : ""}`}>
        <section className="showcase-section showcase-reverse">
          <div className="showcase-content">
            <div className="showcase-text">
              <h2 className="showcase-title">1-Click Application<br />Autofill</h2>
              <p className="showcase-desc">
                Apply to hundreds of jobs daily across all major ATS platforms.
                Skip repetitive data entry and save 80% of your time.
              </p>
              <button className="btn-dark" onClick={() => navigate("/app")}>Start Autofilling</button>
            </div>
            <div className="showcase-visual">
              <div className="showcase-card autofill-card">
                <div className="autofill-header">
                  <img src="/logo-icon.png" alt="Resumate" className="autofill-logo" />
                  <span className="autofill-brand">Resumate</span>
                </div>
                <div className="autofill-job">
                  <div className="autofill-job-icon"></div>
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
            </div>
          </div>
        </section>
      </div>

      {/* Feature Showcase 3: Resume Tailoring */}
      <div ref={reveal3.ref} className={`reveal ${reveal3.visible ? "revealed" : ""}`}>
        <section className="showcase-section">
          <div className="showcase-content">
            <div className="showcase-text">
              <h2 className="showcase-title">Job Specific<br />Tailored Resume</h2>
              <p className="showcase-desc">
                Get a perfectly tailored, professional resume that passes ATS
                and highlights your strengths in just 6 seconds.
              </p>
              <button className="btn-dark" onClick={() => navigate("/app")}>Upgrade My Resume</button>
            </div>
            <div className="showcase-visual">
              <div className="showcase-card resume-card">
                <div className="resume-header">
                  <div className="resume-star">✦</div>
                  <div className="resume-name">Jamie Parker</div>
                  <div className="resume-score-badge">
                    <span className="resume-score-num">9.0</span>
                    <span className="resume-score-label">EXCELLENT</span>
                  </div>
                </div>
                <div className="resume-section">
                  <div className="resume-section-title">PROFESSIONAL SUMMARY</div>
                  <div className="resume-lines">
                    <div className="resume-line"></div>
                    <div className="resume-line short"></div>
                  </div>
                </div>
                <div className="resume-section">
                  <div className="resume-section-title">SKILL</div>
                  <div className="resume-lines">
                    <div className="resume-line"></div>
                  </div>
                </div>
                <div className="resume-section">
                  <div className="resume-section-title">EXPERIENCE</div>
                  <div className="resume-lines">
                    <div className="resume-line"></div>
                    <div className="resume-line short"></div>
                    <div className="resume-line"></div>
                  </div>
                </div>
                <div className="resume-enhancements">
                  <span className="enhancement-tag">✦ Summary Enhanced</span>
                  <span className="enhancement-tag">✦ Relevant Skills Highlighted</span>
                  <span className="enhancement-tag">✦ Recent Work Experience Enhanced</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Trusted By Companies */}
      <div ref={revealCompanies.ref} className={`reveal ${revealCompanies.visible ? "revealed" : ""}`}>
        <section className="companies-section">
          <p className="companies-label">Trusted by job seekers applying to</p>
          <div className="companies-logos">
            <span className="company-logo">Google</span>
            <span className="company-logo">Meta</span>
            <span className="company-logo">Amazon</span>
            <span className="company-logo">Microsoft</span>
            <span className="company-logo">Apple</span>
            <span className="company-logo">Netflix</span>
            <span className="company-logo">Shopify</span>
          </div>
        </section>
      </div>

      {/* Pricing */}
      <div ref={revealPricing.ref} className={`reveal ${revealPricing.visible ? "revealed" : ""}`}>
        <section className="section" id="pricing">
          <h2 className="section-title">Simple Pricing</h2>
          <p className="section-sub">Start free, upgrade when you're ready</p>
          <div className="pricing-grid">
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
          </div>
        </section>
      </div>

      {/* FAQ */}
      <div ref={revealFaq.ref} className={`reveal ${revealFaq.visible ? "revealed" : ""}`}>
        <section className="faq-section" id="faq">
          <h2 className="faq-title">Frequently Asked<br />Questions</h2>
          <div className="faq-list">
            {faqs.map((faq, i) => (
              <div key={i} className={`faq-item ${openFaq === i ? "open" : ""}`}>
                <button className="faq-question" onClick={() => setOpenFaq(openFaq === i ? null : i)}>
                  <span>{faq.q}</span>
                  <span className="faq-toggle">{openFaq === i ? "−" : "+"}</span>
                </button>
                {openFaq === i && <div className="faq-answer">{faq.a}</div>}
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Bottom Banner */}
      <div ref={revealBanner.ref} className={`reveal ${revealBanner.visible ? "revealed" : ""}`}>
        <section className="bottom-banner">
          <div className="bottom-banner-inner">
            <div className="bottom-banner-text">
              <h2>Start applying smarter today.</h2>
              <p>Join 1.25M+ job seekers who landed their dream roles with AI.</p>
            </div>
            <button className="btn-cta-hero" onClick={() => navigate("/app")}>GET STARTED FREE</button>
          </div>
        </section>
      </div>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-inner">
          <div className="footer-col">
            <div className="footer-brand">
              <img src="/logo-icon.png" alt="Resumate" className="landing-logo-img" />
              <span className="landing-logo-text">Resumate</span>
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
          <p>© 2026 Resumate. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
