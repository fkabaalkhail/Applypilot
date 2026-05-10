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
                    </div>
                    <div className="mockup-card">
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
                    </div>
                    <div className="mockup-card">
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

      {/* Stats Section */}
      <div ref={revealStats.ref} className={`reveal ${revealStats.visible ? "revealed" : ""}`}>
        <section className="stats-section-light" id="stats">
          <div className="stats-content-light">
            <div className="stats-left-light">
              <span className="stats-eyebrow-light">OUR TRACK RECORD</span>
              <h2 className="stats-headline-light">Real results,<br />not just promises.</h2>
              <p className="stats-sub-light">
                Trusted by over a million job seekers to land interviews faster
                and cut the time spent searching.
              </p>
              <button className="btn-dark" onClick={() => navigate("#features")}>
                See how it works ↗
              </button>
            </div>
            <div className="stats-right-light">
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
                  <span className="stat-number-light">3× more interviews</span>
                  <span className="stat-label-light">compared to manual applications</span>
                </div>
              </div>
              <div className="stat-card-light">
                <div className="stat-icon-light">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#14b8a6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                </div>
                <div className="stat-info-light">
                  <span className="stat-number-light">80% time saved</span>
                  <span className="stat-label-light">on the average job search</span>
                </div>
              </div>
              <div className="stat-card-light">
                <div className="stat-icon-light">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                </div>
                <div className="stat-info-light">
                  <span className="stat-number-light">No. 1 choice</span>
                  <span className="stat-label-light">for 80% of users after first use</span>
                </div>
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
              <ul className="showcase-bullets">
                <li>✓ ATS-optimized formatting</li>
                <li>✓ Keyword matching from job description</li>
                <li>✓ Quantified achievements highlighted</li>
                <li>✓ Industry-specific language</li>
              </ul>
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
            </div>
          </div>
        </section>
      </div>

      {/* Trusted By Companies */}
      <div ref={revealCompanies.ref} className={`reveal ${revealCompanies.visible ? "revealed" : ""}`}>
        <section className="companies-section">
          <p className="companies-label">Trusted by job seekers applying to</p>
          <div className="companies-logos">
            <span className="company-logo">
              <img src="https://www.google.com/s2/favicons?domain=google.com&sz=32" alt="Google" className="company-favicon" />
              Google
            </span>
            <span className="company-logo">
              <img src="https://www.google.com/s2/favicons?domain=meta.com&sz=32" alt="Meta" className="company-favicon" />
              Meta
            </span>
            <span className="company-logo">
              <img src="https://www.google.com/s2/favicons?domain=amazon.com&sz=32" alt="Amazon" className="company-favicon" />
              Amazon
            </span>
            <span className="company-logo">
              <img src="https://www.google.com/s2/favicons?domain=microsoft.com&sz=32" alt="Microsoft" className="company-favicon" />
              Microsoft
            </span>
            <span className="company-logo">
              <img src="https://www.google.com/s2/favicons?domain=apple.com&sz=32" alt="Apple" className="company-favicon" />
              Apple
            </span>
            <span className="company-logo">
              <img src="https://www.google.com/s2/favicons?domain=netflix.com&sz=32" alt="Netflix" className="company-favicon" />
              Netflix
            </span>
            <span className="company-logo">
              <img src="https://www.google.com/s2/favicons?domain=shopify.com&sz=32" alt="Shopify" className="company-favicon" />
              Shopify
            </span>
          </div>
        </section>
      </div>

      {/* Testimonials */}
      <section className="testimonials-section">
        <h2 className="section-title">What Our Users Say</h2>
        <p className="section-sub">Join thousands who landed their dream jobs</p>
        <div className="testimonials-grid">
          <div className="testimonial-card">
            <div className="testimonial-stars">★★★★★</div>
            <p className="testimonial-text">"I went from applying to 5 jobs a day to 50+. Got 3 interviews in my first week. This tool is a game changer."</p>
            <div className="testimonial-author">
              <div className="testimonial-avatar">S</div>
              <div>
                <div className="testimonial-name">Sarah K.</div>
                <div className="testimonial-role">Software Engineer → Google</div>
              </div>
            </div>
          </div>
          <div className="testimonial-card">
            <div className="testimonial-stars">★★★★★</div>
            <p className="testimonial-text">"The AI-tailored resume feature alone is worth it. My response rate went from 2% to 15% overnight."</p>
            <div className="testimonial-author">
              <div className="testimonial-avatar">M</div>
              <div>
                <div className="testimonial-name">Marcus T.</div>
                <div className="testimonial-role">Data Analyst → Amazon</div>
              </div>
            </div>
          </div>
          <div className="testimonial-card">
            <div className="testimonial-stars">★★★★★</div>
            <p className="testimonial-text">"Saved me hours every day. The screening question answers are surprisingly accurate and personalized."</p>
            <div className="testimonial-author">
              <div className="testimonial-avatar">A</div>
              <div>
                <div className="testimonial-name">Aisha R.</div>
                <div className="testimonial-role">Product Manager → Shopify</div>
              </div>
            </div>
          </div>
        </div>
      </section>

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
